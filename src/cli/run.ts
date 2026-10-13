import os from "node:os";
import { runAgent, type UsageTotals } from "../agent/agent.js";
import { estimateCost, formatCost } from "../agent/cost.js";
import type { AgentDoneReason, AgentEvent } from "../agent/events.js";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { startLspServers } from "../lsp/manager.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import {
	autoApprovedLine,
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Message, Provider, TextBlock } from "../providers/types.js";
import { buildSemanticSearchTool } from "../semantic/tool.js";
import { chooseSession } from "../session/chooser.js";
import {
	latestSession,
	listSessions,
	loadSession,
	newSession,
	type StoredSession,
	saveSession,
	withoutSystem,
} from "../session/store.js";
import { createTaskTool } from "../tools/task.js";

export type OutputFormat = "text" | "json";

export interface RunHeadlessOptions {
	prompt: string;
	model?: string;
	maxSteps?: number;
	maxCost?: number;
	yesAll?: boolean;
	continueSession?: boolean;
	sessionId?: string;
	outputFormat?: OutputFormat;
	onEvent?: (event: AgentEvent) => void;
	// Test seams: a double replaces the network provider and the workspace/env
	// are injected so a run never reads the real home directory.
	provider?: Provider;
	workspaceRoot?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
}

export function exitCodeForReason(reason: AgentDoneReason): number {
	return reason === "finished" ? 0 : 1;
}

export function eventJsonLine(event: AgentEvent): string {
	return JSON.stringify(event);
}

export function summaryJsonLine(result: {
	reason: AgentDoneReason;
	steps: number;
	usage: UsageTotals;
}): string {
	return JSON.stringify({
		type: "summary",
		reason: result.reason,
		steps: result.steps,
		usage: result.usage,
	});
}

export async function runHeadless(
	options: RunHeadlessOptions,
): Promise<number> {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const outputFormat = options.outputFormat ?? "text";
	const resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot,
		env,
		homeDir,
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider: settings, apiKey, permissions } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		return 1;
	}

	const provider =
		options.provider ??
		createOpenAICompatibleProvider({
			id: settings.preset,
			baseURL: settings.baseURL,
			apiKey,
			apiKeyEnv: settings.apiKeyEnv,
		});

	const session = await resolveSession(options, workspaceRoot, settings.model);
	if (session === null) return 1;
	process.stderr.write(`[session] ${session.id}\n`);

	const yesAll = options.yesAll ?? false;
	const rules = {
		...defaultRules(),
		...permissions,
	};
	const authorize = createAuthorizer({
		workspaceRoot,
		rules,
		approval: headlessApproval({
			yesAll,
			log: (line) => process.stderr.write(line),
		}),
		yesAll,
		allowAll: createAllowAll(yesAll),
		onAutoApproved: (request) =>
			process.stderr.write(`${autoApprovedLine(request)}\n`),
	});

	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot,
	});
	for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);

	const lsp = startLspServers({
		servers: resolved.config.lspServers,
		workspaceRoot,
	});

	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);

	// DeepSeek's thinking controls do not apply to other OpenAI-compatible
	// endpoints, so only forward them when the deepseek preset is active.
	const deepseek = settings.preset === "deepseek";
	const thinking = deepseek ? settings.thinking : undefined;
	const reasoningEffort = deepseek ? settings.reasoningEffort : undefined;

	// The sub-agent inherits the parent's provider, model, workspace, authorize,
	// and thinking, and receives the standard tools only, so it cannot recurse.
	const taskTool = createTaskTool({
		depth: 0,
		run: (task, signal) =>
			runAgent({
				provider,
				model: settings.model,
				workspaceRoot,
				prompt: task,
				history: [],
				signal,
				authorize,
				thinking,
				reasoningEffort,
				hooks: resolved.config.hooks,
				onEvent: () => {},
			}).then((result) => lastAssistantText(result.messages)),
	});

	// The semantic index tool is registered only when the embeddings block is
	// configured; without it the workspace search stays off entirely.
	const semanticTool = buildSemanticSearchTool({
		embeddings: resolved.config.embeddings,
		workspaceRoot,
		env,
	});

	let reasoningChars = 0;
	try {
		const result = await runAgent({
			provider,
			model: settings.model,
			workspaceRoot,
			prompt: options.prompt,
			history: session.messages,
			maxSteps: settings.maxSteps,
			maxCost: options.maxCost,
			thinking: deepseek ? settings.thinking : undefined,
			reasoningEffort: deepseek ? settings.reasoningEffort : undefined,
			signal: controller.signal,
			authorize,
			compaction: resolved.config.compaction,
			extraTools: [
				...mcp.tools,
				...lsp.tools,
				taskTool,
				...(semanticTool === undefined ? [] : [semanticTool]),
			],
			hooks: resolved.config.hooks,
			// No lastInputTokens: the stored session usage is cumulative across
			// turns, so auto compaction trusts the character estimate instead.
			onEvent: (event: AgentEvent) => {
				options.onEvent?.(event);
				if (outputFormat === "json") {
					process.stdout.write(`${eventJsonLine(event)}\n`);
					return;
				}
				switch (event.type) {
					case "text_delta":
						process.stdout.write(event.text);
						break;
					case "reasoning_delta":
						reasoningChars += event.text.length;
						break;
					case "tool_finished":
						process.stderr.write(
							`[tool] ${event.name} ${event.status}: ${event.summary}\n`,
						);
						break;
					case "compacted":
						process.stderr.write(
							`· compacted ${event.removedMessages} messages\n`,
						);
						break;
					case "error":
						process.stderr.write(`[error] ${event.message}\n`);
						break;
					case "done":
						process.stderr.write(
							`[done] reason=${event.reason} steps=${event.steps}\n`,
						);
						break;
					default:
						break;
				}
			},
		});

		if (outputFormat === "json") {
			process.stdout.write(`${summaryJsonLine(result)}\n`);
		} else {
			if (reasoningChars > 0) {
				process.stderr.write(`[reasoning] ${reasoningChars} chars\n`);
			}
			process.stderr.write(
				`[usage] input=${result.usage.inputTokens} output=${result.usage.outputTokens} cache_hit=${result.usage.cacheHitTokens} cache_miss=${result.usage.cacheMissTokens} reasoning=${result.usage.reasoningTokens} cost=${formatCost(estimateCost(result.usage, settings.model))}\n`,
			);
		}
		session.messages = withoutSystem(result.messages);
		session.usage = {
			input: session.usage.input + result.usage.inputTokens,
			output: session.usage.output + result.usage.outputTokens,
		};
		session.model = settings.model;
		session.updatedAt = Date.now();
		const saved = await saveSession(session);
		if (!saved.ok) process.stderr.write(`[session] ${saved.error}\n`);
		return exitCodeForReason(result.reason);
	} finally {
		process.off("SIGINT", onSigint);
		await mcp.dispose();
		await lsp.dispose();
	}
}

async function resolveSession(
	options: RunHeadlessOptions,
	workspaceRoot: string,
	model: string,
): Promise<StoredSession | null> {
	const summaries = await listSessions(workspaceRoot);
	const choice = chooseSession(
		{
			continueFlag: options.continueSession ?? false,
			sessionId: options.sessionId,
		},
		summaries,
	);

	switch (choice.mode) {
		case "error":
			console.error(choice.error);
			return null;
		case "latest":
			return (
				(await latestSession(workspaceRoot)) ?? newSession(workspaceRoot, model)
			);
		case "id": {
			const loaded = await loadSession(workspaceRoot, choice.id);
			if (!loaded.ok) {
				console.error(loaded.error);
				return null;
			}
			return loaded.session;
		}
		case "new": {
			if (options.continueSession) {
				process.stderr.write(
					"[session] no saved session for this workspace; starting a new one\n",
				);
			}
			return newSession(workspaceRoot, model);
		}
	}
}

function lastAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((block): block is TextBlock => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}
