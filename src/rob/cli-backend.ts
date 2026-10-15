import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UsageTotals } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import { type PermissionRules, resolveAction } from "../permissions/rules.js";
import type { Message } from "../providers/types.js";
import { getTool } from "../tools/registry.js";
import {
	emptyUsage,
	promptFor,
	type RobBackend,
	type TurnResult,
	toUserMessage,
} from "./backend.js";
import type { BridgePort, Inbound, RobName } from "./types.js";

const SUMMARY_MAX_CHARS = 200;
const UI_OUTPUT_MAX_CHARS = 4000;
const STDERR_MAX_CHARS = 1000;
const INTERJECT_POLL_MS = 50;
const EXIT_GRACE_MS = 1000;

const PI_SESSIONS_DIR = ".my-agent";
const PI_SESSIONS_SUBDIR = "pi-sessions";
const APPROVAL_EXTENSION_FILE = "approval-extension.mjs";

// The approval bridge lives inside pi: on every tool call it asks our process
// over pi's RPC extension-UI channel and blocks until the answer arrives.
const APPROVAL_EXTENSION = `export default function (pi) {
	pi.on("tool_call", async (event, ctx) => {
		const allowed = await ctx.ui.confirm(
			"my-agent approval",
			JSON.stringify({ toolName: event.toolName, input: event.input }),
		);
		if (!allowed) {
			return { block: true, reason: "Denied by the my-agent approval bridge." };
		}
	});
}
`;

// Our tool name to pi's. Only these four have a pi counterpart.
const PI_TOOLS: ReadonlyArray<readonly [string, string]> = [
	["read_file", "read"],
	["write_file", "write"],
	["edit_file", "edit"],
	["bash", "bash"],
];

const PI_TO_OURS = new Map(PI_TOOLS.map(([ours, pi]) => [pi, ours]));

// A missing binary is common on a fresh machine, so name the command and the way
// out instead of surfacing Node's raw "spawn pi ENOENT".
function spawnFailureMessage(
	command: string,
	error: NodeJS.ErrnoException,
): string {
	if (error.code === "ENOENT") {
		return `Cannot start "${command}": command not found on PATH. Install it, or set this bot's backend to native.`;
	}
	return `Failed to start "${command}": ${error.message}`;
}

// Without a bridge, pi has no channel to ask for approval, so a tool that
// resolves to "ask" is left out entirely: only an outright "allow" for the
// tool's default subject ("*") exposes it. With the bridge, "ask" tools are
// exposed because the extension gates each call on our authorizer.
export function piToolAllowlist(
	rules: PermissionRules,
	includeAsk = false,
): string[] {
	const allowed: string[] = [];
	for (const [tool, piTool] of PI_TOOLS) {
		const action = resolveAction(rules, tool, "*");
		if (action === "allow" || (includeAsk && action === "ask")) {
			allowed.push(piTool);
		}
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
	// The turn's bridge to the team; the pi host shim attaches the child to it.
	bridge?: BridgePort;
	// When set, the approval extension is loaded and "ask" tools are exposed.
	authorize?: Authorize;
	// Returns queued interjections to steer into a running turn.
	drain?: () => Inbound[];
	// Environment for the child, e.g. the provider key pi reads to authenticate.
	extraEnv?: Record<string, string>;
}

export function createCliBackend(options: CliBackendOptions): RobBackend {
	return {
		async run(turn) {
			const sessionDir =
				options.sessionDir ??
				defaultSessionDir(turn.workspaceRoot, options.rob);
			await mkdir(sessionDir, { recursive: true });

			const bridged = options.authorize !== undefined;
			const allowed = piToolAllowlist(turn.rules, bridged);
			let extensionFile: string | undefined;
			if (bridged) {
				extensionFile = path.join(sessionDir, APPROVAL_EXTENSION_FILE);
				await writeFile(extensionFile, APPROVAL_EXTENSION, "utf8");
			}

			const args = [
				"--mode",
				"rpc",
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
				...(extensionFile !== undefined ? ["--extension", extensionFile] : []),
			];

			return runPi({
				command: options.command,
				args,
				cwd: turn.workspaceRoot,
				signal: turn.signal,
				onEvent: turn.onEvent,
				history: turn.history,
				inbound: turn.inbound,
				authorize: options.authorize,
				drain: options.drain,
				extraEnv: options.extraEnv,
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
	authorize?: Authorize;
	drain?: () => Inbound[];
	extraEnv?: Record<string, string>;
}

interface InFlightSteer {
	message: string;
	queued: boolean;
	failed: boolean;
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
	let promptFailure: string | null = null;
	let steps = 0;
	let stderr = "";
	let ended = false;
	let buffer = "";
	let turnActive = false;
	let steering: string[] = [];
	let inFlight: InFlightSteer[] = [];
	const pendingResponses: InFlightSteer[] = [];
	let awaitingPrompt: string[] = [];

	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...options.extraEnv },
	});

	return new Promise<TurnResult>((resolve) => {
		let settled = false;
		let exitTimer: NodeJS.Timeout | undefined;

		const send = (command: Record<string, unknown>): boolean => {
			if (!child.stdin.writable) return false;
			child.stdin.write(`${JSON.stringify(command)}\n`);
			return true;
		};

		const finish = (result: TurnResult): void => {
			if (settled) return;
			settled = true;
			clearInterval(poller);
			if (exitTimer !== undefined) clearTimeout(exitTimer);
			options.signal.removeEventListener("abort", abort);
			resolve(result);
		};

		const abort = (): void => {
			child.kill("SIGKILL");
		};
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });

		const conclude = (): void => {
			if (options.signal.aborted) {
				emit({ type: "done", reason: "aborted", steps });
				finish({ ok: false, error: "Turn aborted.", usage, messages });
				return;
			}
			if (promptFailure !== null) {
				emit({ type: "error", message: promptFailure });
				emit({ type: "done", reason: "error", steps });
				finish({ ok: false, error: promptFailure, usage, messages });
				return;
			}
			const lost = lostSteerCount(inFlight, steering) + awaitingPrompt.length;
			if (lost > 0) failure = lostMessageError(lost);
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
		};

		const poller = setInterval(() => {
			if (settled || !turnActive || options.drain === undefined) return;
			for (const item of options.drain()) {
				const message = promptFor(item);
				const steer: InFlightSteer = { message, queued: false, failed: false };
				inFlight.push(steer);
				if (!send({ type: "steer", message })) {
					steer.failed = true;
					continue;
				}
				pendingResponses.push(steer);
			}
		}, INTERJECT_POLL_MS);

		const handleApproval = async (
			record: Record<string, unknown>,
		): Promise<void> => {
			const id = stringField(record.id);
			const method = stringField(record.method);
			if (method === "confirm") {
				send({
					type: "extension_ui_response",
					id,
					confirmed: await decideApproval(record, options.authorize),
				});
				return;
			}
			if (method === "select" || method === "input" || method === "editor") {
				send({ type: "extension_ui_response", id, cancelled: true });
			}
		};

		const handleEvent = (event: unknown): void => {
			if (event === null || typeof event !== "object") return;
			const record = event as Record<string, unknown>;
			switch (record.type) {
				case "response": {
					if (record.command === "steer") {
						const steer = pendingResponses.shift();
						if (steer !== undefined && record.success === false) {
							steer.failed = true;
						}
						return;
					}
					if (record.command === "prompt" && record.success === false) {
						promptFailure =
							stringField(record.error) || "pi rejected the prompt.";
						conclude();
						if (child.stdin.writable) child.stdin.end();
					}
					return;
				}
				case "queue_update": {
					steering = stringList(record.steering);
					for (const steer of inFlight) {
						if (steering.includes(steer.message)) steer.queued = true;
					}
					return;
				}
				case "extension_ui_request": {
					void handleApproval(record);
					return;
				}
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
				case "agent_end": {
					turnActive = false;
					awaitingPrompt = [];
					// A steer still in pi's queue at agent_end was never delivered, so
					// resend it as a prompt in this process instead of dropping it.
					const resend = inFlight
						.filter((steer) => steer.failed || steering.includes(steer.message))
						.map((steer) => steer.message);
					if (resend.length > 0) {
						inFlight = [];
						steering = [];
						currentText = "";
						awaitingPrompt = resend;
						turnActive = true;
						if (send({ type: "prompt", message: resend.join("\n\n") })) {
							ended = false;
							return;
						}
					}
					ended = true;
					conclude();
					// Let pi drain and exit on its own so the session is saved.
					if (child.stdin.writable) child.stdin.end();
					exitTimer = setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS);
					exitTimer.unref();
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
			if (options.signal.aborted) {
				emit({ type: "done", reason: "aborted", steps });
				finish({ ok: false, error: "Turn aborted.", usage, messages });
				return;
			}
			emit({
				type: "error",
				message: spawnFailureMessage(options.command, error),
			});
			emit({ type: "done", reason: "error", steps });
			finish({
				ok: false,
				error: spawnFailureMessage(options.command, error),
				usage,
				messages,
			});
		});

		child.on("close", (code) => {
			if (settled) return;
			if (exitTimer !== undefined) clearTimeout(exitTimer);
			if (buffer !== "") handleLine(buffer);
			if (!ended && options.signal.aborted !== true && code !== 0) {
				const detail = capStderr(stderr) || `pi exited with code ${code}.`;
				promptFailure = detail;
			} else if (!ended && stderr.trim() !== "" && failure === null) {
				failure = capStderr(stderr);
			}
			conclude();
		});

		turnActive = true;
		send({
			type: "prompt",
			message: options.inbound.map(promptFor).join("\n\n"),
		});
	});
}

async function decideApproval(
	record: Record<string, unknown>,
	authorize: Authorize | undefined,
): Promise<boolean> {
	if (authorize === undefined) return false;
	const info = parseApprovalInfo(stringField(record.message));
	if (info === undefined) return false;
	const mapped = mapToolName(info.toolName);
	const tool = getTool(mapped);
	if (tool === undefined) return false;
	const decision = await authorize(
		{ id: stringField(record.id), name: mapped, args: info.input },
		tool,
	);
	return decision.allowed;
}

function parseApprovalInfo(
	message: string,
): { toolName: string; input: unknown } | undefined {
	try {
		const parsed: unknown = JSON.parse(message);
		if (parsed === null || typeof parsed !== "object") return undefined;
		const record = parsed as Record<string, unknown>;
		return { toolName: stringField(record.toolName), input: record.input };
	} catch {
		return undefined;
	}
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

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

// A drained message is delivered only once pi has acknowledged it into a
// steering queue and then consumed it. Anything else at conclude is lost.
function lostSteerCount(
	inFlight: readonly InFlightSteer[],
	steering: readonly string[],
): number {
	return inFlight.filter(
		(steer) => !(steer.queued && !steering.includes(steer.message)),
	).length;
}

function lostMessageError(count: number): string {
	const noun = count === 1 ? "interjection was" : "interjections were";
	return `${count} ${noun} not delivered by pi.`;
}
