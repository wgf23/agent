import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type {
	HookInput,
	HookOutcome,
	HookRunner,
} from "../../src/hooks/hooks.js";
import type { ToolMessage } from "../../src/providers/types.js";
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
