import type {
	ContentBlock,
	ImagePart,
	Message,
	Provider,
	ReasoningEffort,
	ThinkingSetting,
	ToolCallBlock,
} from "../providers/types.js";
import {
	executeTool,
	getTool,
	toolDefinition,
	toolDefinitions,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { type Authorize, readOnlyAuthorize } from "./authorize.js";
import {
	type CompactionSettings,
	compactSummaryMessage,
	estimateTokens,
	shouldCompact,
	splitForCompaction,
	summarizeMessages,
} from "./compact.js";
import { trimForBudget } from "./context.js";
import type { AgentDoneReason, AgentEvent, Usage } from "./events.js";
import { buildSystemPrompt } from "./system-prompt.js";

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	reasoningTokens: number;
}

export interface RunAgentOptions {
	provider: Provider;
	model: string;
	workspaceRoot: string;
	prompt: string;
	images?: ImagePart[];
	history?: Message[];
	maxSteps?: number;
	signal?: AbortSignal;
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	authorize?: Authorize;
	onEvent: (event: AgentEvent) => void;
	maxRetries?: number;
	drainInput?: () => Message[];
	extraTools?: Tool[];
	extraInstructions?: string;
	compaction?: CompactionSettings;
	forceCompact?: boolean;
	lastInputTokens?: number;
}

export interface RunAgentResult {
	messages: Message[];
	reason: AgentDoneReason;
	steps: number;
	usage: UsageTotals;
}

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const SUMMARY_MAX_CHARS = 200;
const UI_OUTPUT_MAX_CHARS = 4000;

type StepResult =
	| { kind: "ok"; text: string; toolCalls: ToolCallBlock[] }
	| { kind: "error"; message: string }
	| { kind: "aborted" };

interface CallSlot {
	call: ToolCallBlock;
	tool?: Tool;
	result?: ToolResult;
	blocked?: boolean;
}

export async function runAgent(
	options: RunAgentOptions,
): Promise<RunAgentResult> {
	const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const authorize = options.authorize ?? readOnlyAuthorize;
	const signal = options.signal;
	const emit = options.onEvent;

	const systemPrompt = await buildSystemPrompt({
		workspaceRoot: options.workspaceRoot,
		platform: process.platform,
		date: new Date().toISOString(),
		extraInstructions: options.extraInstructions,
	});

	let messages: Message[] = [
		{ role: "system", content: systemPrompt },
		...(options.history ?? []),
		{
			role: "user",
			content: options.prompt,
			...(options.images !== undefined && options.images.length > 0
				? { images: options.images }
				: {}),
		},
	];

	const extraTools = options.extraTools ?? [];
	const definitions = [...toolDefinitions(), ...extraTools.map(toolDefinition)];
	function lookupTool(name: string): Tool | undefined {
		return getTool(name) ?? extraTools.find((tool) => tool.name === name);
	}
	const usage: UsageTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		reasoningTokens: 0,
	};
	let steps = 0;
	let reason: AgentDoneReason = "max_steps";

	function flushUsage(events: Usage[]): void {
		for (const event of events) {
			addUsage(usage, event);
			emit(event);
		}
	}

	// Compaction runs once at the start of a run. Its own summary call is a
	// provider request too, so the agent loop sees the compacted history.
	async function compactOnce(): Promise<void> {
		if (options.compaction === undefined) return;
		const tail = messages.slice(1);
		const { older, recent } = splitForCompaction(
			tail,
			options.compaction.keepRecentTokens,
		);
		if (older.length === 0) return;
		const fires = shouldCompact({
			force: options.forceCompact ?? false,
			auto: options.compaction.auto,
			estimatedTokens: estimateTokens(messages),
			lastInputTokens: options.lastInputTokens,
			thresholdTokens: options.compaction.thresholdTokens,
		});
		if (!fires) return;
		const summary = await summarizeMessages(
			options.provider,
			options.model,
			older,
			signal,
		);
		if (!summary.ok) return;
		messages = [messages[0], compactSummaryMessage(summary.summary), ...recent];
		emit({
			type: "compacted",
			removedMessages: older.length,
			summaryChars: summary.summary.length,
		});
	}

	async function collectStep(current: Message[]): Promise<StepResult> {
		let retries = 0;
		while (true) {
			const textParts: string[] = [];
			const toolCalls: ToolCallBlock[] = [];
			const pendingUsage: Usage[] = [];
			let failure: { message: string; retryable: boolean } | undefined;

			try {
				for await (const event of options.provider.stream({
					model: options.model,
					messages: current,
					tools: definitions,
					thinking: options.thinking,
					reasoningEffort: options.reasoningEffort,
					signal,
				})) {
					switch (event.type) {
						case "text_delta":
							textParts.push(event.text);
							emit({ type: "text_delta", text: event.text });
							break;
						case "reasoning_delta":
							emit({ type: "reasoning_delta", text: event.text });
							break;
						case "tool_call":
							toolCalls.push({
								type: "tool_call",
								id: event.id,
								name: event.name,
								args: event.args,
							});
							break;
						case "usage":
							pendingUsage.push(event);
							break;
						case "error":
							failure = {
								message: event.message,
								retryable: event.retryable,
							};
							break;
						case "finish":
							break;
					}
				}
			} catch (error) {
				if (signal?.aborted) return { kind: "aborted" };
				return { kind: "error", message: errorMessage(error) };
			}

			if (signal?.aborted) return { kind: "aborted" };

			if (failure !== undefined) {
				const emittedOutput = textParts.length > 0 || toolCalls.length > 0;
				if (failure.retryable && !emittedOutput && retries < maxRetries) {
					retries += 1;
					await sleep(BASE_BACKOFF_MS * 2 ** (retries - 1), signal);
					if (signal?.aborted) return { kind: "aborted" };
					continue;
				}
				flushUsage(pendingUsage);
				return { kind: "error", message: failure.message };
			}

			flushUsage(pendingUsage);
			return { kind: "ok", text: textParts.join(""), toolCalls };
		}
	}

	try {
		await compactOnce();
		while (steps < maxSteps) {
			if (signal?.aborted) {
				reason = "aborted";
				break;
			}

			if (options.drainInput !== undefined) {
				const injected = options.drainInput();
				for (const message of injected) {
					messages.push(message);
				}
			}

			steps += 1;
			const step = await collectStep(messages);
			if (step.kind === "aborted") {
				reason = "aborted";
				break;
			}
			if (step.kind === "error") {
				emit({ type: "error", message: step.message });
				reason = "error";
				break;
			}

			const content: ContentBlock[] = [];
			if (step.text !== "") {
				content.push({ type: "text", text: step.text });
			}
			for (const call of step.toolCalls) {
				content.push(call);
			}
			messages.push({ role: "assistant", content });

			if (step.toolCalls.length === 0) {
				reason = "finished";
				break;
			}

			const slots: CallSlot[] = step.toolCalls.map((call) => ({ call }));
			for (const slot of slots) {
				emit({
					type: "tool_started",
					id: slot.call.id,
					name: slot.call.name,
					args: slot.call.args,
				});
				const tool = lookupTool(slot.call.name);
				if (tool === undefined) {
					slot.result = {
						ok: false,
						error: `Unknown tool: ${slot.call.name}`,
					};
					continue;
				}
				slot.tool = tool;
				const decision = await authorize(slot.call, tool);
				if (!decision.allowed) {
					slot.result = { ok: false, error: decision.reason };
					slot.blocked = true;
				}
			}

			const ctx: ToolContext = {
				workspaceRoot: options.workspaceRoot,
				signal,
			};
			const parallel = slots.filter(
				(slot): slot is CallSlot & { tool: Tool } =>
					slot.tool?.readOnly === true && slot.result === undefined,
			);
			await Promise.all(
				parallel.map(async (slot) => {
					slot.result = await executeTool(slot.tool, slot.call.args, ctx);
				}),
			);
			for (const slot of slots) {
				if (slot.result !== undefined || slot.tool === undefined) continue;
				slot.result = await executeTool(slot.tool, slot.call.args, ctx);
			}

			for (const slot of slots) {
				const result = slot.result ?? {
					ok: false as const,
					error: "Tool did not run",
				};
				let status: "ok" | "error" | "blocked" = result.ok ? "ok" : "error";
				if (slot.blocked === true) {
					status = "blocked";
				}
				emit({
					type: "tool_finished",
					id: slot.call.id,
					name: slot.call.name,
					ok: result.ok,
					status,
					summary: summarize(result),
					output: uiOutput(result.ok ? result.output : result.error),
				});
				messages.push({
					role: "tool",
					toolCallId: slot.call.id,
					content: result.ok ? result.output : result.error,
					isError: !result.ok,
				});
			}

			if (signal?.aborted) {
				reason = "aborted";
				break;
			}

			messages = trimForBudget(messages);
		}
	} catch (error) {
		emit({ type: "error", message: errorMessage(error) });
		reason = "error";
	}

	emit({ type: "done", reason, steps });
	return { messages, reason, steps, usage };
}

function addUsage(totals: UsageTotals, event: Usage): void {
	totals.inputTokens += event.inputTokens;
	totals.outputTokens += event.outputTokens;
	totals.cacheHitTokens += event.cacheHitTokens ?? 0;
	totals.cacheMissTokens += event.cacheMissTokens ?? 0;
	totals.reasoningTokens += event.reasoningTokens ?? 0;
}

function summarize(result: ToolResult): string {
	const text = result.ok ? result.output : result.error;
	const firstLine = text.split("\n")[0] ?? "";
	return firstLine.length > SUMMARY_MAX_CHARS
		? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}...`
		: firstLine;
}

function uiOutput(text: string): string {
	return text.length > UI_OUTPUT_MAX_CHARS
		? `${text.slice(0, UI_OUTPUT_MAX_CHARS)}[truncated]`
		: text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
