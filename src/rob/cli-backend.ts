import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { UsageTotals } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { type PermissionRules, resolveAction } from "../permissions/rules.js";
import type { Message } from "../providers/types.js";
import {
	emptyUsage,
	promptFor,
	type RobBackend,
	type TurnResult,
	toUserMessage,
} from "./backend.js";
import type { Inbound, RobName } from "./types.js";

const SUMMARY_MAX_CHARS = 200;
const UI_OUTPUT_MAX_CHARS = 4000;
const STDERR_MAX_CHARS = 1000;

const PI_SESSIONS_DIR = ".my-agent";
const PI_SESSIONS_SUBDIR = "pi-sessions";

// Our tool name to pi's. Only these four have a pi counterpart.
const PI_TOOLS: ReadonlyArray<readonly [string, string]> = [
	["read_file", "read"],
	["write_file", "write"],
	["edit_file", "edit"],
	["bash", "bash"],
];

const PI_TO_OURS = new Map(PI_TOOLS.map(([ours, pi]) => [pi, ours]));

// pi has no channel to ask for approval, so a tool that resolves to "ask" is
// left out entirely: only an outright "allow" for the tool's default subject
// ("*") exposes it.
export function piToolAllowlist(rules: PermissionRules): string[] {
	const allowed: string[] = [];
	for (const [tool, piTool] of PI_TOOLS) {
		if (resolveAction(rules, tool, "*") === "allow") allowed.push(piTool);
	}
	return allowed;
}

export function defaultSessionDir(workspaceRoot: string, rob: RobName): string {
	return path.join(workspaceRoot, PI_SESSIONS_DIR, PI_SESSIONS_SUBDIR, rob);
}

export interface CliBackendOptions {
	rob: RobName;
	role: string;
	command: string;
	provider: string;
	model: string;
	sessionDir?: string;
}

export function createCliBackend(options: CliBackendOptions): RobBackend {
	return {
		async run(turn) {
			const sessionDir =
				options.sessionDir ??
				defaultSessionDir(turn.workspaceRoot, options.rob);
			await mkdir(sessionDir, { recursive: true });

			const allowed = piToolAllowlist(turn.rules);
			const args = [
				"-p",
				"--mode",
				"json",
				"--provider",
				options.provider,
				"--model",
				options.model,
				"--append-system-prompt",
				options.role,
				"--session-dir",
				sessionDir,
				// --continue reuses the rob's most recent session in its own
				// directory; without it pi starts a fresh one every turn.
				"--continue",
				...(allowed.length > 0
					? ["--tools", allowed.join(",")]
					: ["--no-tools"]),
				turn.inbound.map(promptFor).join("\n\n"),
			];

			return runPi({
				command: options.command,
				args,
				cwd: turn.workspaceRoot,
				signal: turn.signal,
				onEvent: turn.onEvent,
				history: turn.history,
				inbound: turn.inbound,
			});
		},
	};
}

interface RunPiOptions {
	command: string;
	args: string[];
	cwd: string;
	signal: AbortSignal;
	onEvent: (event: AgentEvent) => void;
	history: readonly Message[];
	inbound: readonly Inbound[];
}

function runPi(options: RunPiOptions): Promise<TurnResult> {
	const usage = emptyUsage();
	const messages: Message[] = [
		...options.history,
		...options.inbound.map(toUserMessage),
	];
	const emit = options.onEvent;
	let lastText = "";
	let currentText = "";
	let failure: string | null = null;
	let steps = 0;
	let stderr = "";

	// pi blocks waiting for stdin EOF, so stdin is ignored rather than left as an
	// open pipe the parent never closes.
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});

	return new Promise<TurnResult>((resolve) => {
		let settled = false;
		const finish = (result: TurnResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const abort = (): void => {
			child.kill("SIGKILL");
		};
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });

		const handleEvent = (event: unknown): void => {
			if (event === null || typeof event !== "object") return;
			const record = event as Record<string, unknown>;
			switch (record.type) {
				case "tool_execution_start": {
					emit({
						type: "tool_started",
						id: stringField(record.toolCallId),
						name: mapToolName(stringField(record.toolName)),
						args: record.args,
					});
					return;
				}
				case "tool_execution_end": {
					const text = piResultText(record.result);
					const isError = record.isError === true;
					emit({
						type: "tool_finished",
						id: stringField(record.toolCallId),
						name: mapToolName(stringField(record.toolName)),
						ok: !isError,
						status: isError ? "error" : "ok",
						summary: summarize(text),
						output: capOutput(text),
					});
					return;
				}
				case "message_start": {
					if (messageRole(record) === "assistant") currentText = "";
					return;
				}
				case "message_update": {
					const delta = textDelta(record);
					if (delta === "") return;
					currentText += delta;
					emit({ type: "text_delta", text: delta });
					return;
				}
				case "message_end": {
					if (record.message === null || typeof record.message !== "object") {
						return;
					}
					const message = record.message as Record<string, unknown>;
					if (message.role !== "assistant") return;
					steps += 1;
					emitUsage(usage, message.usage, emit);
					const stopReason = stringField(message.stopReason);
					if (stopReason === "error" || stopReason === "aborted") {
						const detail = stringField(message.errorMessage);
						failure =
							detail !== ""
								? detail
								: `pi stopped with reason "${stopReason}".`;
						currentText = "";
						return;
					}
					const text = contentText(message.content);
					if (text !== "") {
						// message_update already streamed the leading text; emit only
						// the remainder so a non-streaming pi is not lost.
						const rest = text.startsWith(currentText)
							? text.slice(currentText.length)
							: text;
						if (rest !== "") emit({ type: "text_delta", text: rest });
						lastText = text;
					}
					currentText = "";
					return;
				}
				default:
					return;
			}
		};

		const handleLine = (line: string): void => {
			const trimmed = line.trim();
			if (trimmed === "") return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// pi can print non-JSON diagnostics on stdout; they carry no events.
				return;
			}
			handleEvent(parsed);
		};

		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			options.signal.removeEventListener("abort", abort);
			if (options.signal.aborted) {
				emit({ type: "done", reason: "aborted", steps });
				finish({ ok: false, error: "Turn aborted.", usage, messages });
				return;
			}
			emit({ type: "error", message: error.message });
			emit({ type: "done", reason: "error", steps });
			finish({ ok: false, error: error.message, usage, messages });
		});

		child.on("close", (code) => {
			options.signal.removeEventListener("abort", abort);
			if (buffer !== "") handleLine(buffer);

			if (options.signal.aborted) {
				emit({ type: "done", reason: "aborted", steps });
				finish({ ok: false, error: "Turn aborted.", usage, messages });
				return;
			}
			if (code !== 0) {
				const detail = capStderr(stderr) || `pi exited with code ${code}.`;
				emit({ type: "error", message: detail });
				emit({ type: "done", reason: "error", steps });
				finish({ ok: false, error: detail, usage, messages });
				return;
			}
			if (failure !== null) {
				emit({ type: "error", message: failure });
				emit({ type: "done", reason: "error", steps });
				finish({ ok: false, error: failure, usage, messages });
				return;
			}
			if (lastText !== "") {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: lastText }],
				});
			}
			emit({ type: "done", reason: "finished", steps });
			finish({ ok: true, text: lastText, usage, messages });
		});
	});
}

function emitUsage(
	totals: UsageTotals,
	raw: unknown,
	emit: (event: AgentEvent) => void,
): void {
	if (raw === null || typeof raw !== "object") return;
	const usage = raw as Record<string, unknown>;
	const inputTokens = numberField(usage.input);
	const outputTokens = numberField(usage.output);
	const cacheHitTokens = numberField(usage.cacheRead);
	totals.inputTokens += inputTokens;
	totals.outputTokens += outputTokens;
	totals.cacheHitTokens += cacheHitTokens;
	// pi reports no cache-miss or reasoning tokens, so those stay zero.
	emit({
		type: "usage",
		inputTokens,
		outputTokens,
		cacheHitTokens,
		cacheMissTokens: 0,
		reasoningTokens: 0,
	});
}

function mapToolName(piName: string): string {
	return PI_TO_OURS.get(piName) ?? piName;
}

function messageRole(record: Record<string, unknown>): string {
	const message = record.message;
	if (message === null || typeof message !== "object") return "";
	return stringField((message as Record<string, unknown>).role);
}

function textDelta(record: Record<string, unknown>): string {
	const inner = record.assistantMessageEvent;
	if (inner === null || typeof inner !== "object") return "";
	const event = inner as Record<string, unknown>;
	if (event.type !== "text_delta") return "";
	return stringField(event.delta);
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				block !== null &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function piResultText(result: unknown): string {
	if (result === null || typeof result !== "object") return "";
	return contentText((result as Record<string, unknown>).content);
}

function summarize(text: string): string {
	const firstLine = text.split("\n")[0] ?? "";
	return firstLine.length > SUMMARY_MAX_CHARS
		? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}...`
		: firstLine;
}

function capOutput(text: string): string {
	return text.length > UI_OUTPUT_MAX_CHARS
		? `${text.slice(0, UI_OUTPUT_MAX_CHARS)}[truncated]`
		: text;
}

function capStderr(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > STDERR_MAX_CHARS
		? trimmed.slice(0, STDERR_MAX_CHARS)
		: trimmed;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
