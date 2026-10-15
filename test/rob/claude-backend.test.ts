import {
	chmod,
	copyFile,
	mkdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
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
import { Team } from "../../src/rob/team.js";
import type { BridgePort, Inbound } from "../../src/rob/types.js";
import type { Tool } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, fakeBridge } from "./helpers.js";

const FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-claude.mjs", import.meta.url),
);

// The preamble for the fixture's lone rob: no teammates and no bridged tools.
const LONE_ROB_PREAMBLE = [
	'You are rob "reviewer", one member of a team of robs.',
	"Your role: review code",
	"You are the only rob: there is no teammate to message.",
	"",
	"Team tools:",
	"",
	"send_message is fire-and-forget: the message is delivered when the teammate next runs, and their reply arrives later as a message from them.",
].join("\n");

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
	delete process.env.FAKE_CLAUDE_TEAM_CALLS;
	delete process.env.FAKE_CLAUDE_TEAM_RESULTS;
	delete process.env.MY_AGENT_CLAUDE_CONFIG_DIR;
});

describe("claudeToolAllowlist", () => {
	it("exposes an allow for every tool under its claude name and omits the rest", () => {
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
		).toEqual(["Read", "Write"]);
	});

	it("omits an ask or deny tool from the exposed set", () => {
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
		).toEqual(["Read", "Glob", "Grep"]);
	});

	it("blanket-allows a scalar allow and a list of only * allows", () => {
		expect(
			claudeToolAllowlist({
				write_file: "allow",
				bash: [{ pattern: "*", action: "allow" }],
			}),
		).toEqual(["Read", "Write", "Glob", "Grep", "Bash"]);
	});

	it("does not blanket-allow a tool with any specific pattern, deny, or ask entry", () => {
		expect(
			claudeToolAllowlist({
				write_file: [{ pattern: "docs/**", action: "allow" }],
				read_file: [
					{ pattern: "*", action: "allow" },
					{ pattern: "src/**", action: "deny" },
				],
			}),
		).toEqual(["Glob", "Grep"]);
	});

	it("exposes web_search as claude's WebSearch tool", () => {
		expect(claudeToolAllowlist({ web_search: "allow" })).toContain("WebSearch");
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
			bridge: fakeBridge(),
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
	it("spawns claude with the team preamble, allowlist, and a fresh session id", async () => {
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
			LONE_ROB_PREAMBLE,
			"--allowedTools",
			"Read,Write",
			"--tools",
			"Read,Write",
			"--strict-mcp-config",
			"--session-id",
			sid,
		]);
	});

	it("keeps an ask or deny built-in out of --tools", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

		await runTurn({ rules: { write_file: "ask", edit_file: "deny" } });

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		const tools = argv[argv.indexOf("--tools") + 1];
		expect(tools).toBe("Read,Glob,Grep");
		expect(tools).not.toContain("Write");
		expect(tools).not.toContain("Edit");
		expect(argv).not.toContain("--disallowedTools");
	});

	it("passes an empty --tools when no built-in resolves to allow", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

		await runTurn({
			rules: {
				read_file: "deny",
				glob: "deny",
				grep: "deny",
				write_file: "deny",
				edit_file: "deny",
				bash: "deny",
			},
		});

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		expect(argv[argv.indexOf("--tools") + 1]).toBe("");
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
			bridge: fakeBridge(),
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
			bridge: fakeBridge(),
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

	it("forwards extraEnv to the claude child", async () => {
		const envFile = path.join(workspace, "env.txt");
		process.env.FAKE_CLAUDE_ENV_FILE = envFile;
		process.env.FAKE_CLAUDE_ENV_NAME = "MY_AGENT_TEST_FORWARDED_KEY";

		const backend = createClaudeBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			configDir: path.join(workspace, "cfg"),
			extraEnv: { MY_AGENT_TEST_FORWARDED_KEY: "forwarded-value" },
		});
		await backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "hi", at: 0 }],
			workspaceRoot: workspace,
			bridge: fakeBridge(),
			rules: {},
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		expect(await readFile(envFile, "utf8")).toBe("forwarded-value");
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
			bridge: fakeBridge(),
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

	it("does not resume a session after a failed first turn", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
		process.env.FAKE_CLAUDE_SCENARIO = "error";

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
			bridge: fakeBridge(),
			rules: {},
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		await backend.run(turn("hello"));
		await backend.run(turn("again"));
		const second = JSON.parse(await readFile(argvFile, "utf8"));
		expect(second).toContain("--session-id");
		expect(second).not.toContain("--resume");
	});

	it("consumes a large stderr stream and reports it on failure", async () => {
		process.env.FAKE_CLAUDE_SCENARIO = "stderr";
		const { result } = await runTurn({ rules: {} });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(`boom\n${"X".repeat(1000)}`);
	});

	it("times out a stuck claude and kills its process group", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_CLAUDE_SCENARIO = "sleep";
		process.env.FAKE_CLAUDE_PID_FILE = pidFile;

		const backend = createClaudeBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			configDir: path.join(workspace, "cfg"),
			timeoutMs: 1000,
		});
		// The fixture writes its pid before it sleeps; reading it before the
		// turn's timeout keeps the assertion off node's spawn latency.
		const running = backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "sleep", at: 0 }],
			workspaceRoot: workspace,
			bridge: fakeBridge(),
			rules: {},
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		await waitForFile(pidFile);
		const result = await running;

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("claude: timed out after 1000ms");

		const pid = Number(await readFile(pidFile, "utf8"));
		await waitFor(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, "the child process to exit");
	});

	it("reports a clean exit without a result as an error", async () => {
		process.env.FAKE_CLAUDE_SCENARIO = "empty";
		const { result } = await runTurn({ rules: {} });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("claude ended without a result");
	});
});

const SEND_MESSAGE_PARAMETERS = {
	type: "object",
	properties: { to: { type: "string" }, text: { type: "string" } },
	required: ["to", "text"],
};

const DELEGATE_PARAMETERS = {
	type: "object",
	properties: { task: { type: "string" } },
	required: ["task"],
};

const TEAM_TOOLS: Tool[] = [
	{
		name: "send_message",
		description: "Send a private message.",
		readOnly: true,
		parameters: SEND_MESSAGE_PARAMETERS,
		execute: async () => ({ ok: true, output: "" }),
	},
	{
		name: "delegate",
		description: "Delegate a task.",
		readOnly: false,
		parameters: DELEGATE_PARAMETERS,
		execute: async () => ({ ok: true, output: "" }),
	},
];

const TEAM_CHILD_ENV = {
	MYAGENT_TEAM_SOCKET: "/tmp/myagent-team/gateway.sock",
	MYAGENT_TEAM_SECRET: "team-secret",
};

// The preamble renderTeamPreamble builds for the claude rob's live roster.
const TEAM_PREAMBLE = [
	'You are rob "reviewer", one member of a team of robs.',
	"Your role: review code",
	"",
	"Your teammates:",
	'- "worker": work',
	"",
	"Team tools:",
	"- send_message: Send a private message.",
	"- delegate: Delegate a task.",
	"",
	"send_message is fire-and-forget: the message is delivered when the teammate next runs, and their reply arrives later as a message from them.",
].join("\n");

function teamBridge(): BridgePort {
	return fakeBridge({
		tools: TEAM_TOOLS,
		roster: () => [{ name: "worker", role: "work" }],
		childEnv: () => TEAM_CHILD_ENV,
	});
}

describe("claude team bridge", () => {
	it("writes the MCP shim and starts claude with it on the team socket", async () => {
		const configDir = path.join(workspace, "cfg");
		const argvFile = path.join(workspace, "argv.json");
		const envFile = path.join(workspace, "env.txt");
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
		process.env.FAKE_CLAUDE_ENV_FILE = envFile;
		process.env.FAKE_CLAUDE_ENV_NAME = "MYAGENT_TEAM_SOCKET";

		const { result } = await runTurn({
			rules: { read_file: "allow" },
			bridge: teamBridge(),
			configDir,
		});

		expect(result.ok).toBe(true);

		const shimFile = path.join(configDir, "team-mcp.mjs");
		const mcpConfigFile = path.join(configDir, "team-mcp.json");
		const argv = JSON.parse(await readFile(argvFile, "utf8"));

		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(
			TEAM_PREAMBLE,
		);
		expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
			"Read,Glob,Grep,mcp__myagent-team__send_message,mcp__myagent-team__delegate",
		);
		expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(mcpConfigFile);
		expect(argv).toContain("--strict-mcp-config");
		expect(await readFile(envFile, "utf8")).toBe(
			TEAM_CHILD_ENV.MYAGENT_TEAM_SOCKET,
		);

		expect(JSON.parse(await readFile(mcpConfigFile, "utf8"))).toEqual({
			mcpServers: {
				"myagent-team": {
					command: "node",
					args: [shimFile],
					env: TEAM_CHILD_ENV,
				},
			},
		});

		const shim = await readFile(shimFile, "utf8");
		expect(shim).toContain(
			JSON.stringify([
				{
					name: "send_message",
					description: "Send a private message.",
					inputSchema: SEND_MESSAGE_PARAMETERS,
				},
				{
					name: "delegate",
					description: "Delegate a task.",
					inputSchema: DELEGATE_PARAMETERS,
				},
			]),
		);
		expect(shim).toContain("process.env.MYAGENT_TEAM_SOCKET");
		expect(shim).toContain("process.env.MYAGENT_TEAM_SECRET");
	});

	it("carries a fake claude's MCP team calls through the turn's gateway", async () => {
		const callsFile = path.join(workspace, "team-calls.json");
		const resultsFile = path.join(workspace, "team-results.json");
		await writeFile(
			callsFile,
			JSON.stringify([
				{
					name: "send_message",
					args: { to: "worker", text: "ping from claude" },
				},
				{ name: "delegate", args: { task: "summarize the log" } },
				{ name: "send_message", args: { to: "nobody", text: "lost" } },
			]),
			"utf8",
		);
		process.env.FAKE_CLAUDE_SCENARIO = "team";
		process.env.FAKE_CLAUDE_TEAM_CALLS = callsFile;
		process.env.FAKE_CLAUDE_TEAM_RESULTS = resultsFile;
		process.env.MY_AGENT_CLAUDE_CONFIG_DIR = path.join(
			workspace,
			"claude-config",
		);
		// The rob config names the real command, and a fixture copied to
		// "claude" on the child's PATH answers it.
		const binDir = path.join(workspace, "bin");
		await mkdir(binDir, { recursive: true });
		await copyFile(FIXTURE, path.join(binDir, "claude"));
		await chmod(path.join(binDir, "claude"), 0o755);

		const subagent = createMockProvider([
			[
				{ type: "text_delta", text: "the sub-agent answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [
				{
					name: "planner",
					role: "plan",
					backend: { kind: "cli", command: "claude" },
				},
				{ name: "worker", role: "work" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: (rob) =>
				rob.name === "planner" ? subagent : createMockProvider([]),
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			providerEnv: {
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		});
		team.start();
		team.dispatch("planner", "reach the team");

		await waitFor(
			() => team.readDms().length === 1 && team.statuses()[0].status === "idle",
			"the claude turn to finish with one DM logged",
		);
		await team.stop();

		expect(team.readDms()).toEqual([
			{
				from: "planner",
				to: "worker",
				text: "ping from claude",
				at: expect.any(Number),
			},
		]);
		expect(JSON.parse(await readFile(resultsFile, "utf8"))).toEqual([
			'Message queued for "worker".',
			"the sub-agent answer",
			"Unknown rob: nobody",
		]);
	});
});

async function runTurn(options: {
	rules?: PermissionRules;
	inbound?: Inbound[];
	configDir?: string;
	bridge?: BridgePort;
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
		bridge: options.bridge ?? fakeBridge(),
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
