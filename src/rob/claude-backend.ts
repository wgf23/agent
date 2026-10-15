import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageTotals } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { type PermissionRules, resolveAction } from "../permissions/rules.js";
import type { Message } from "../providers/types.js";
import { toolDefinition } from "../tools/registry.js";
import { killProcessGroup } from "../util/process.js";
import {
	emptyUsage,
	promptFor,
	type RobBackend,
	type TurnResult,
	toUserMessage,
} from "./backend.js";
import { teamMcpShim } from "./gateway/shims.js";
import { renderTeamPreamble } from "./roster.js";
import type { Inbound, RobName } from "./types.js";

const CLAUDE_COMMAND = "claude";
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const SUMMARY_MAX_CHARS = 200;
const UI_OUTPUT_MAX_CHARS = 4000;
const MAX_STDERR_CHARS = 1000;

// The MCP server name is also the prefix in every team tool's claude name,
// "mcp__myagent-team__send_message" and friends.
const TEAM_MCP_SERVER = "myagent-team";
const TEAM_MCP_FILE = "team-mcp.mjs";
const TEAM_MCP_CONFIG_FILE = "team-mcp.json";

export const CLAUDE_CONFIG_DIR_ENV = "MY_AGENT_CLAUDE_CONFIG_DIR";

// Our tool name to Claude Code's built-in tool name.
const CLAUDE_TOOLS: ReadonlyArray<readonly [string, string]> = [
	["read_file", "Read"],
	["write_file", "Write"],
	["edit_file", "Edit"],
	["glob", "Glob"],
	["grep", "Grep"],
	["bash", "Bash"],
	["web_fetch", "WebFetch"],
	["web_search", "WebSearch"],
];

const CLAUDE_TO_OURS = new Map(
	CLAUDE_TOOLS.map(([ours, claude]) => [claude, ours]),
);

export interface ClaudeBackendOptions {
	rob: RobName;
	role: string;
	// Defaults to "claude"; tests point it at the fake binary.
	command?: string;
	model?: string;
	// Isolates the child's CLAUDE_CONFIG_DIR; tests inject a temp dir.
	configDir?: string;
	// Env the child needs beyond process.env, such as the provider key.
	extraEnv?: Record<string, string>;
	// Kills a stuck claude after this many milliseconds (default 10 minutes).
	timeoutMs?: number;
}

// The one place that resolves the claude config dir, mirroring skillsRoot so a
// test or a user can redirect the whole prefix with one env var. Each rob still
// gets its own subdirectory under it.
export function defaultClaudeConfigDir(
	rob: RobName,
	env: Record<string, string | undefined> = process.env,
	homeDir: string = os.homedir(),
): string {
	const override = env[CLAUDE_CONFIG_DIR_ENV];
	const base =
		override !== undefined && override.trim() !== ""
			? path.resolve(override)
			: path.join(homeDir, ".config", "my-agent", "claude");
	return path.join(base, rob);
}

// A tool that resolves to allow is exposed via --allowedTools; ask and deny
// tools are denied via --disallowedTools. Interactive approval is not bridged,
// so an ask tool is treated as denied instead of left to prompt.
export function claudeToolAllowlist(rules: PermissionRules): {
	allowed: string[];
	disallowed: string[];
} {
	const allowed: string[] = [];
	const disallowed: string[] = [];
	for (const [tool, claudeTool] of CLAUDE_TOOLS) {
		if (toolBlanketAllows(rules, tool)) allowed.push(claudeTool);
		else disallowed.push(claudeTool);
	}
	return { allowed, disallowed };
}

// A tool is blanket-allowed only when its rules cannot resolve to anything but
// allow for any subject, the same rule opencode-backend.ts uses. A scalar
// "allow" allows; a list of only { pattern: "*", action: "allow" } allows; any
// specific pattern, deny, or ask entry gates the tool instead.
function toolBlanketAllows(rules: PermissionRules, tool: string): boolean {
	const rule = rules[tool];
	if (rule === undefined) return resolveAction(rules, tool, "*") === "allow";
	if (typeof rule === "string") return rule === "allow";
	return (
		rule.length > 0 &&
		rule.every((entry) => entry.action === "allow" && entry.pattern === "*")
	);
}

export function createClaudeBackend(options: ClaudeBackendOptions): RobBackend {
	const command = options.command ?? CLAUDE_COMMAND;
	const configDir = options.configDir ?? defaultClaudeConfigDir(options.rob);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
	// One session per rob, kept across turns so the rob remembers its history.
	let sessionID: string | null = null;

	return {
		async run(turn) {
			await mkdir(configDir, { recursive: true });

			const { allowed, disallowed } = claudeToolAllowlist(turn.rules);
			const defs = turn.bridge.tools.map(toolDefinition);
			const teamTools = defs.map(
				(def) => `mcp__${TEAM_MCP_SERVER}__${def.name}`,
			);
			// The bridge env is opaque to this backend, so it travels whole. The
			// MCP config lives in a file so the per-turn secret stays out of argv.
			const childEnv = turn.bridge.childEnv();
			let mcpConfigFile: string | undefined;
			if (defs.length > 0) {
				const shimFile = path.join(configDir, TEAM_MCP_FILE);
				mcpConfigFile = path.join(configDir, TEAM_MCP_CONFIG_FILE);
				await writeFile(shimFile, teamMcpShim({ defs }), "utf8");
				await writeFile(
					mcpConfigFile,
					JSON.stringify({
						mcpServers: {
							[TEAM_MCP_SERVER]: {
								command: "node",
								args: [shimFile],
								env: childEnv,
							},
						},
					}),
					"utf8",
				);
			}
			const prompt = turn.inbound.map(promptFor).join("\n\n");
			const allowedTools = [...allowed, ...teamTools];

			const args = [
				"-p",
				prompt,
				"--output-format",
				"stream-json",
				"--verbose",
				"--append-system-prompt",
				renderTeamPreamble({
					rob: options.rob,
					role: options.role,
					roster: turn.bridge.roster(),
					tools: turn.bridge.tools,
				}),
				// A team call is let through here and authorized by the gateway,
				// the same way the pi and opencode backends expose their tools.
				...(allowedTools.length > 0
					? ["--allowedTools", allowedTools.join(",")]
					: []),
				...(disallowed.length > 0
					? ["--disallowedTools", disallowed.join(",")]
					: []),
				...(mcpConfigFile === undefined ? [] : ["--mcp-config", mcpConfigFile]),
				// Only the MCP servers named above load; the user's own never do.
				"--strict-mcp-config",
				...(options.model !== undefined && options.model !== ""
					? ["--model", options.model]
					: []),
			];
			// Only resume a session claude actually created: the id is remembered
			// after a turn returns ok, never before. A failed first turn must not
			// make later turns resume a session that claude never persisted.
			const resume = sessionID;
			const nextSessionID = resume ?? randomUUID();
			args.push(resume === null ? "--session-id" : "--resume", nextSessionID);

			const result = await runClaude({
				command,
				args,
				cwd: turn.workspaceRoot,
				env: {
					...process.env,
					...options.extraEnv,
					...childEnv,
					CLAUDE_CONFIG_DIR: configDir,
				},
				signal: turn.signal,
				onEvent: turn.onEvent,
				history: turn.history,
				inbound: turn.inbound,
				timeoutMs,
			});

			if (result.ok) sessionID = nextSessionID;
			return result;
		},
	};
}

interface RunClaudeOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	onEvent: (event: AgentEvent) => void;
	history: readonly Message[];
	inbound: readonly Inbound[];
	timeoutMs: number;
}

function runClaude(options: RunClaudeOptions): Promise<TurnResult> {
	const usage = emptyUsage();
	const messages: Message[] = [
		...options.history,
		...options.inbound.map(toUserMessage),
	];
	const emit = options.onEvent;
	const toolNames = new Map<string, string>();
	let lastText = "";
	let failure: string | null = null;
	let stderr = "";
	let steps = 0;
	let ended = false;
	let timedOut = false;
	let buffer = "";

	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		// detached puts the child in its own process group so a timeout can kill
		// it and any descendants together, mirroring the bash tool.
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: options.env,
	});

	return new Promise<TurnResult>((resolve) => {
		let settled = false;

		const abort = (): void => {
			killProcessGroup(child);
		};

		const finish = (result: TurnResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			resolve(result);
		};

		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, options.timeoutMs);

		const conclude = (): void => {
			if (options.signal.aborted) {
				emit({ type: "done", reason: "aborted", steps });
				finish({ ok: false, error: "Turn aborted.", usage, messages });
				return;
			}
			if (failure !== null) {
				const error = `${failure}${stderrDiagnostics(stderr)}`;
				emit({ type: "error", message: error });
				emit({ type: "done", reason: "error", steps });
				finish({ ok: false, error, usage, messages });
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

		const handleEvent = (event: unknown): void => {
			if (event === null || typeof event !== "object") return;
			const record = event as Record<string, unknown>;
			switch (record.type) {
				case "assistant": {
					const message = record.message;
					if (!isRecord(message) || !Array.isArray(message.content)) return;
					steps += 1;
					for (const block of message.content) {
						if (!isRecord(block)) continue;
						if (block.type === "text") {
							const text = stringField(block.text);
							if (text !== "") emit({ type: "text_delta", text });
						} else if (block.type === "tool_use") {
							const id = stringField(block.id);
							const name = stringField(block.name);
							if (id !== "") toolNames.set(id, name);
							emit({
								type: "tool_started",
								id,
								name: mapToolName(name),
								args: block.input,
							});
						}
					}
					return;
				}
				case "user": {
					const message = record.message;
					if (!isRecord(message) || !Array.isArray(message.content)) return;
					for (const block of message.content) {
						if (!isRecord(block) || block.type !== "tool_result") continue;
						const id = stringField(block.tool_use_id);
						const text = toolResultText(block.content);
						const isError = block.is_error === true;
						emit({
							type: "tool_finished",
							id,
							name: mapToolName(toolNames.get(id) ?? ""),
							ok: !isError,
							status: isError ? "error" : "ok",
							summary: summarize(text),
							output: capOutput(text),
						});
					}
					return;
				}
				case "result": {
					recordUsage(usage, record.usage, emit);
					const text = stringField(record.result);
					if (record.is_error === true) {
						failure = text !== "" ? text : "claude reported an error.";
					} else {
						lastText = text;
					}
					ended = true;
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
				// claude can print non-JSON diagnostics on stdout; they carry no events.
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

		// claude can write enough stderr to fill the pipe and deadlock; consume
		// it and capture the text so a failure can report what claude printed.
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
			const message = spawnFailureMessage(options.command, error);
			emit({ type: "error", message });
			emit({ type: "done", reason: "error", steps });
			finish({ ok: false, error: message, usage, messages });
		});

		child.on("close", (code) => {
			if (settled) return;
			if (buffer !== "") handleLine(buffer);
			if (timedOut) {
				failure = `claude: timed out after ${options.timeoutMs}ms`;
			} else if (!ended && code !== 0 && !options.signal.aborted) {
				failure = `claude exited with code ${String(code)}.`;
			} else if (!ended && !options.signal.aborted) {
				failure = "claude ended without a result";
			}
			conclude();
		});
	});
}

function recordUsage(
	totals: UsageTotals,
	raw: unknown,
	emit: (event: AgentEvent) => void,
): void {
	if (!isRecord(raw)) return;
	const inputTokens = numberField(raw.input_tokens);
	const outputTokens = numberField(raw.output_tokens);
	const cacheHitTokens = numberField(raw.cache_read_input_tokens);
	const cacheMissTokens = numberField(raw.cache_creation_input_tokens);
	totals.inputTokens += inputTokens;
	totals.outputTokens += outputTokens;
	totals.cacheHitTokens += cacheHitTokens;
	totals.cacheMissTokens += cacheMissTokens;
	// claude reports no reasoning tokens in the result usage, so it stays zero.
	emit({
		type: "usage",
		inputTokens,
		outputTokens,
		cacheHitTokens,
		cacheMissTokens,
		reasoningTokens: 0,
	});
}

function spawnFailureMessage(
	command: string,
	error: NodeJS.ErrnoException,
): string {
	if (error.code === "ENOENT") {
		return `Cannot start "${command}": command not found on PATH. Install it, or set this bot's backend to native.`;
	}
	return `Failed to start "${command}": ${error.message}`;
}

function mapToolName(claudeName: string): string {
	return CLAUDE_TO_OURS.get(claudeName) ?? claudeName;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return contentText(content);
	return "";
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

function stderrDiagnostics(stderr: string): string {
	const detail = stderr.trim();
	return detail === "" ? "" : `\n${capStderr(detail)}`;
}

function capStderr(text: string): string {
	return text.length > MAX_STDERR_CHARS
		? text.slice(0, MAX_STDERR_CHARS)
		: text;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
