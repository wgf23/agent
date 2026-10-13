import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { PermissionRules } from "../../src/permissions/rules.js";
import type { TurnResult } from "../../src/rob/backend.js";
import {
	CLAUDE_CONFIG_DIR_ENV,
	claudeToolAllowlist,
	createClaudeBackend,
	defaultClaudeConfigDir,
} from "../../src/rob/claude-backend.js";
import type { Inbound } from "../../src/rob/types.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-claude.mjs", import.meta.url),
);

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-claude-backend-");
	await chmod(FIXTURE, 0o755);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	delete process.env.FAKE_CLAUDE_SCENARIO;
	delete process.env.FAKE_CLAUDE_ARGV_FILE;
	delete process.env.FAKE_CLAUDE_ENV_FILE;
	delete process.env.FAKE_CLAUDE_ENV_NAME;
	delete process.env.FAKE_CLAUDE_PID_FILE;
});

describe("claudeToolAllowlist", () => {
	it("maps an allow for every tool to its claude name and denies the rest", () => {
		expect(
			claudeToolAllowlist({
				read_file: "allow",
				write_file: "allow",
				edit_file: "deny",
				glob: "deny",
				grep: "deny",
				bash: "deny",
				web_fetch: "deny",
			}),
		).toEqual({
			allowed: ["Read", "Write"],
			disallowed: ["Edit", "Glob", "Grep", "Bash", "WebFetch"],
		});
	});

	it("moves ask and deny tools into the disallowed list", () => {
		expect(
			claudeToolAllowlist({
				read_file: "allow",
				write_file: "ask",
				edit_file: "ask",
				glob: "allow",
				grep: "allow",
				bash: "deny",
				web_fetch: "ask",
			}),
		).toEqual({
			allowed: ["Read", "Glob", "Grep"],
			disallowed: ["Write", "Edit", "Bash", "WebFetch"],
		});
	});
});

describe("defaultClaudeConfigDir", () => {
	it("defaults to a rob-scoped directory under ~/.config/my-agent/claude", () => {
		expect(defaultClaudeConfigDir("reviewer", {}, "/home/u")).toBe(
			path.join("/home/u", ".config", "my-agent", "claude", "reviewer"),
		);
	});

	it("honors the env override as the prefix", () => {
		expect(
			defaultClaudeConfigDir(
				"reviewer",
				{ [CLAUDE_CONFIG_DIR_ENV]: "/tmp/cfg" },
				"/home/u",
			),
		).toBe(path.join("/tmp/cfg", "reviewer"));
	});
});

describe("createClaudeBackend missing command", () => {
	it("reports an actionable error instead of a raw spawn ENOENT", async () => {
		const events: AgentEvent[] = [];
		const backend = createClaudeBackend({
			rob: "r",
			role: "x",
			command: "my-agent-no-such-cli",
			configDir: path.join(workspace, "cfg"),
		});
		await backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "hi", at: 0 }],
			workspaceRoot: workspace,
			rules: {},
			signal: new AbortController().signal,
			onEvent: (event) => events.push(event),
		});
		const error = events.find((event) => event.type === "error");
		expect(error?.message).toMatch(/my-agent-no-such-cli/);
		expect(error?.message).toMatch(/PATH/);
		expect(error?.message).not.toMatch(/ENOENT/);
	});
});

describe("claude backend", () => {
	it("spawns claude with the role, allowlist, and a fresh session id", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

		const { result } = await runTurn({
			rules: {
				read_file: "allow",
				write_file: "allow",
				edit_file: "deny",
				glob: "deny",
				grep: "deny",
				bash: "deny",
				web_fetch: "deny",
			},
		});

		expect(result.ok).toBe(true);

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		const sidIndex = argv.indexOf("--session-id");
		expect(sidIndex).not.toBe(-1);
		const sid = argv[sidIndex + 1];
		expect(sid).toMatch(/^[0-9a-f-]{36}$/);

		expect(argv).toEqual([
			"-p",
			"[from user] hello",
			"--output-format",
			"stream-json",
			"--verbose",
			"--append-system-prompt",
			"review code",
			"--allowedTools",
			"Read,Write",
			"--disallowedTools",
			"Edit,Glob,Grep,Bash,WebFetch",
			"--session-id",
			sid,
		]);
	});

	it("resumes the same session with --resume on a later turn", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

		const backend = createClaudeBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			configDir: path.join(workspace, "cfg"),
		});
		const turn = (text: string): Parameters<typeof backend.run>[0] => ({
			history: [],
			inbound: [{ kind: "user", from: "user", text, at: 0 }],
			workspaceRoot: workspace,
			rules: {},
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		await backend.run(turn("hello"));
		const first = JSON.parse(await readFile(argvFile, "utf8"));
		const sid = first[first.indexOf("--session-id") + 1];

		await backend.run(turn("again"));
		const second = JSON.parse(await readFile(argvFile, "utf8"));
		expect(second).not.toContain("--session-id");
		const resumeIndex = second.indexOf("--resume");
		expect(resumeIndex).not.toBe(-1);
		expect(second[resumeIndex + 1]).toBe(sid);
	});

	it("passes --model only when a model is set", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

		const backend = createClaudeBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			model: "sonnet",
			configDir: path.join(workspace, "cfg"),
		});
		await backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "hi", at: 0 }],
			workspaceRoot: workspace,
			rules: {},
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		expect(argv).toContain("--model");
		expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
	});

	it("maps the stream to text, tool, and usage events and the final answer", async () => {
		const { result, events } = await runTurn({
			rules: { read_file: "allow" },
		});

		expect(events).toEqual([
			{ type: "text_delta", text: "I'll read the file." },
			{
				type: "tool_started",
				id: "toolu_1",
				name: "read_file",
				args: { file_path: "a.txt" },
			},
			{
				type: "tool_finished",
				id: "toolu_1",
				name: "read_file",
				ok: true,
				status: "ok",
				summary: `${"A".repeat(200)}...`,
				output: `${"A".repeat(4000)}[truncated]`,
			},
			{ type: "text_delta", text: "The final answer." },
			{
				type: "usage",
				inputTokens: 150,
				outputTokens: 30,
				cacheHitTokens: 5,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			{ type: "done", reason: "finished", steps: 2 },
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("The final answer.");
		expect(result.usage).toEqual({
			inputTokens: 150,
			outputTokens: 30,
			cacheHitTokens: 5,
			cacheMissTokens: 0,
			reasoningTokens: 0,
		});
		expect(result.messages).toEqual([
			{ role: "user", content: "[from user] hello" },
			{
				role: "assistant",
				content: [{ type: "text", text: "The final answer." }],
			},
		]);
	});

	it("returns an error result from an is_error result", async () => {
		process.env.FAKE_CLAUDE_SCENARIO = "error";

		const { result, events } = await runTurn({ rules: {} });

		expect(events).toEqual([
			{
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheHitTokens: 0,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			{ type: "error", message: "Not logged in · Please run /login" },
			{ type: "done", reason: "error", steps: 0 },
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("Not logged in · Please run /login");
	});

	it("sets CLAUDE_CONFIG_DIR to the rob-scoped directory and creates it", async () => {
		const envFile = path.join(workspace, "env.txt");
		process.env.FAKE_CLAUDE_ENV_FILE = envFile;
		process.env.FAKE_CLAUDE_ENV_NAME = "CLAUDE_CONFIG_DIR";

		const configDir = path.join(workspace, "claude-config");
		await runTurn({ rules: {}, configDir });

		expect(await readFile(envFile, "utf8")).toBe(configDir);
		expect(await stat(configDir)).toBeDefined();
	});

	it("kills the child on abort and ends the turn as aborted", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_CLAUDE_SCENARIO = "sleep";
		process.env.FAKE_CLAUDE_PID_FILE = pidFile;

		const events: AgentEvent[] = [];
		const controller = new AbortController();
		const backend = createClaudeBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			configDir: path.join(workspace, "cfg"),
		});
		const running = backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "sleep", at: 0 }],
			workspaceRoot: workspace,
			rules: {},
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		await waitForFile(pidFile);
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort();

		const result = await running;
		expect(events).toEqual([{ type: "done", reason: "aborted", steps: 0 }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("Turn aborted.");

		await waitFor(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, "the child process to exit");
	});
});

async function runTurn(options: {
	rules?: PermissionRules;
	inbound?: Inbound[];
	configDir?: string;
}): Promise<{ result: TurnResult; events: AgentEvent[] }> {
	const events: AgentEvent[] = [];
	const backend = createClaudeBackend({
		rob: "reviewer",
		role: "review code",
		command: FIXTURE,
		configDir: options.configDir ?? path.join(workspace, "cfg"),
	});
	const result = await backend.run({
		history: [],
		inbound: options.inbound ?? [
			{ kind: "user", from: "user", text: "hello", at: 0 },
		],
		workspaceRoot: workspace,
		rules: options.rules ?? {},
		signal: new AbortController().signal,
		onEvent: (event) => events.push(event),
	});
	return { result, events };
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await readFile(file, "utf8");
			return;
		} catch {
			if (Date.now() > deadline)
				throw new Error(`Timed out waiting for ${file}`);
			await sleep(10);
		}
	}
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
