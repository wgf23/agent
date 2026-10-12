import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { runHeadless } from "../../src/cli/run.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import type {
	HookInput,
	HookOutcome,
	HookRunner,
} from "../../src/hooks/hooks.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { ToolMessage } from "../../src/providers/types.js";
import { SoloHub } from "../../src/serve/solo.js";
import { newSession } from "../../src/session/store.js";
import { App } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeAll(async () => {
	workspace = await makeWorkspace("my-agent-hooks-agent-");
	await writeFile(path.join(workspace, "a.txt"), "alpha\nbeta", "utf8");
});

afterAll(async () => {
	await removeWorkspace(workspace);
});

interface HookCall {
	command: string;
	input: HookInput;
}

function fakeRunner(outcomes: HookOutcome[]): {
	runner: HookRunner;
	calls: HookCall[];
} {
	const calls: HookCall[] = [];
	let index = 0;
	const runner: HookRunner = async (command, input) => {
		calls.push({ command, input });
		const outcome = outcomes[index];
		index += 1;
		return outcome ?? { kind: "exit", code: 0, stdout: "", stderr: "" };
	};
	return { runner, calls };
}

function readFileTurn() {
	return [
		[
			{
				type: "tool_call" as const,
				id: "call_1",
				name: "read_file",
				args: { path: "a.txt" },
			},
			{ type: "finish" as const, reason: "tool_calls" as const },
		],
		[
			{ type: "text_delta" as const, text: "done" },
			{ type: "finish" as const, reason: "stop" as const },
		],
	];
}

function toolMessages(messages: readonly { role: string }[]): ToolMessage[] {
	return messages.filter(
		(message): message is ToolMessage => message.role === "tool",
	);
}

describe("runAgent hooks", () => {
	it("blocks a tool when a matching pre hook exits non-zero, using its stdout as the reason", async () => {
		const { runner, calls } = fakeRunner([
			{ kind: "exit", code: 1, stdout: "veto read_file\n", stderr: "" },
		]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { preToolUse: [{ match: "read_file", command: "block.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(calls).toEqual([
			{
				command: "block.sh",
				input: {
					hook: "preToolUse",
					tool: "read_file",
					args: { path: "a.txt" },
				},
			},
		]);
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: false,
			status: "blocked",
			summary: "veto read_file",
			output: "veto read_file",
		});
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "veto read_file",
			isError: true,
		});
	});

	it("runs the tool when a matching pre hook exits zero", async () => {
		const { runner } = fakeRunner([
			{ kind: "exit", code: 0, stdout: "", stderr: "" },
		]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { preToolUse: [{ match: "read_file", command: "ok.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: true,
			status: "ok",
			summary: "1\talpha",
			output: "1\talpha\n2\tbeta",
		});
	});

	it("does not run a hook whose match does not cover the tool", async () => {
		const { runner, calls } = fakeRunner([]);
		const provider = createMockProvider(readFileTurn());

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { preToolUse: [{ match: "bash", command: "bash-hook.sh" }] },
			runHook: runner,
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(calls).toEqual([]);
	});

	it("blocks a tool with the default reason when a pre hook cannot spawn", async () => {
		const { runner } = fakeRunner([{ kind: "spawn-error", message: "ENOENT" }]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { preToolUse: [{ match: "*", command: "missing.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: false,
			status: "blocked",
			summary: "Tool read_file was blocked by a preToolUse hook.",
			output: "Tool read_file was blocked by a preToolUse hook.",
		});
	});

	it("runs a post hook after the tool without changing the result", async () => {
		const { runner, calls } = fakeRunner([
			{ kind: "exit", code: 0, stdout: "", stderr: "" },
		]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { postToolUse: [{ match: "read_file", command: "after.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(calls).toEqual([
			{
				command: "after.sh",
				input: {
					hook: "postToolUse",
					tool: "read_file",
					args: { path: "a.txt" },
				},
			},
		]);
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: true,
			status: "ok",
			summary: "1\talpha",
			output: "1\talpha\n2\tbeta",
		});
	});

	it("ignores a failing post hook and keeps the successful result", async () => {
		const { runner } = fakeRunner([
			{ kind: "exit", code: 1, stdout: "post fails", stderr: "" },
		]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { postToolUse: [{ match: "read_file", command: "after.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: true,
			status: "ok",
			summary: "1\talpha",
			output: "1\talpha\n2\tbeta",
		});
	});

	it("ignores a post hook that cannot spawn", async () => {
		const { runner } = fakeRunner([{ kind: "spawn-error", message: "ENOENT" }]);
		const provider = createMockProvider(readFileTurn());
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			hooks: { postToolUse: [{ match: "*", command: "missing.sh" }] },
			runHook: runner,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: true,
			status: "ok",
			summary: "1\talpha",
			output: "1\talpha\n2\tbeta",
		});
	});
});

const WIRING_SETTINGS: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

const BLOCKED_TOOL_MESSAGE = {
	role: "tool",
	toolCallId: "call_1",
	content: "bash is disabled",
	isError: true,
} as const;

async function writeBlockingHook(dir: string): Promise<string> {
	const hookPath = path.join(dir, "block-bash.sh");
	await writeFile(
		hookPath,
		"#!/bin/sh\necho 'bash is disabled'\nexit 1\n",
		"utf8",
	);
	await chmod(hookPath, 0o755);
	return hookPath;
}

function bashTurn() {
	return [
		[
			{
				type: "tool_call" as const,
				id: "call_1",
				name: "bash",
				args: { command: "echo hi" },
			},
			{ type: "finish" as const, reason: "tool_calls" as const },
		],
		[
			{ type: "text_delta" as const, text: "done" },
			{ type: "finish" as const, reason: "stop" as const },
		],
	];
}

async function waitFor(assertion: () => void, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			assertion();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

describe("hooks wiring", () => {
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

	let sessionsDir: string;
	let workspaceRoot: string;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(
			path.join(tmpdir(), "my-agent-hooks-sessions-"),
		);
		workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-ws-"));
		process.env.MY_AGENT_SESSIONS_DIR = sessionsDir;
	});

	afterEach(async () => {
		if (originalSessionsDir === undefined) {
			delete process.env.MY_AGENT_SESSIONS_DIR;
		} else {
			process.env.MY_AGENT_SESSIONS_DIR = originalSessionsDir;
		}
		await rm(sessionsDir, { recursive: true, force: true });
		await rm(workspaceRoot, { recursive: true, force: true });
		cleanup();
	});

	it("blocks a bash call in a headless run through the resolved config", async () => {
		const hookPath = await writeBlockingHook(workspaceRoot);
		await writeFile(
			path.join(workspaceRoot, "my-agent.json"),
			JSON.stringify({
				hooks: { preToolUse: [{ match: "bash", command: hookPath }] },
			}),
			"utf8",
		);
		const provider = createMockProvider(bashTurn());
		const events: AgentEvent[] = [];

		const code = await runHeadless({
			prompt: "run it",
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
			onEvent: (event) => events.push(event),
		});

		expect(code).toBe(0);
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "bash",
			ok: false,
			status: "blocked",
			summary: "bash is disabled",
			output: "bash is disabled",
		});
		expect(toolMessages(provider.requests[1].messages)).toContainEqual(
			BLOCKED_TOOL_MESSAGE,
		);
	});

	it("threads hooks into the serve solo hub", async () => {
		const hookPath = await writeBlockingHook(workspaceRoot);
		const provider = createMockProvider(bashTurn());
		const session = newSession(workspaceRoot, WIRING_SETTINGS.model);
		const hub = new SoloHub(
			{
				workspaceRoot,
				provider,
				settings: WIRING_SETTINGS,
				permissions: {},
				extraTools: [],
				compaction: {
					auto: false,
					thresholdTokens: 100_000,
					keepRecentTokens: 20_000,
				},
				hooks: { preToolUse: [{ match: "bash", command: hookPath }] },
				allowAll: createAllowAll(),
			},
			{ session, sessions: [] },
		);

		hub.dispatch("assistant", "go");
		await waitFor(() =>
			expect(provider.requests.length).toBeGreaterThanOrEqual(2),
		);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual(
			BLOCKED_TOOL_MESSAGE,
		);
		await hub.dispose();
	});

	it("threads hooks into the TUI app", async () => {
		const hookPath = await writeBlockingHook(workspaceRoot);
		const provider = createMockProvider(bashTurn());
		const { stdin } = render(
			createElement(App, {
				provider,
				authorize: readOnlyAuthorize,
				approval: createApprovalBridge(),
				allowAll: createAllowAll(),
				model: WIRING_SETTINGS.model,
				workspaceRoot,
				hooks: { preToolUse: [{ match: "bash", command: hookPath }] },
			}),
		);

		stdin.write("go");
		stdin.write("\r");
		await waitFor(() =>
			expect(provider.requests.length).toBeGreaterThanOrEqual(2),
		);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual(
			BLOCKED_TOOL_MESSAGE,
		);
	});
});
