import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { Provider, ToolMessage } from "../../src/providers/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeAll(async () => {
	workspace = await makeWorkspace("my-agent-loop-");
	await writeFile(path.join(workspace, "a.txt"), "alpha\nbeta", "utf8");
	await writeFile(path.join(workspace, "b.txt"), "gamma\ndelta", "utf8");
});

afterAll(async () => {
	await removeWorkspace(workspace);
});

function toolMessages(messages: readonly { role: string }[]): ToolMessage[] {
	return messages.filter(
		(message): message is ToolMessage => message.role === "tool",
	);
}

describe("runAgent", () => {
	it("finishes a text-only turn in one step", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "Hello" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "say hi",
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(1);
		expect(events).toContainEqual({ type: "text_delta", text: "Hello" });
		expect(events).toContainEqual({
			type: "done",
			reason: "finished",
			steps: 1,
		});
		expect(result.messages).toContainEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
		});
	});

	it("runs a read_file call and feeds the contents to the next request", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "read_file",
					args: { path: "a.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(2);
		expect(provider.requests).toHaveLength(2);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "1\talpha\n2\tbeta",
			isError: false,
		});
	});

	it("runs two read-only calls in parallel and appends results in call order", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "read_file",
					args: { path: "a.txt" },
				},
				{
					type: "tool_call",
					id: "call_2",
					name: "read_file",
					args: { path: "b.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read both",
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(toolMessages(provider.requests[1].messages)).toEqual([
			{
				role: "tool",
				toolCallId: "call_1",
				content: "1\talpha\n2\tbeta",
				isError: false,
			},
			{
				role: "tool",
				toolCallId: "call_2",
				content: "1\tgamma\n2\tdelta",
				isError: false,
			},
		]);
	});

	it("blocks a write_file call with the not-authorized error and does not write", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "write_file",
					args: { path: "new.txt", content: "x" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "write new.txt",
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content:
				"Tool write_file is not authorized yet. Only read-only tools run in this mode.",
			isError: true,
		});
		await expect(access(path.join(workspace, "new.txt"))).rejects.toThrow();
	});

	it("returns a tool error to the model and keeps the loop running", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "read_file",
					args: { path: "missing.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read missing.txt",
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(2);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "read_file: file not found: missing.txt",
			isError: true,
		});
	});

	it("retries a retryable error that arrives before any output", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "overloaded", retryable: true }],
			[
				{ type: "text_delta", text: "recovered" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "try again",
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(1);
		expect(provider.requests).toHaveLength(2);
	});

	it("ends the run on a non-retryable error without retrying", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "bad request", retryable: false }],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "go",
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("error");
		expect(result.steps).toBe(1);
		expect(provider.requests).toHaveLength(1);
		expect(events).toContainEqual({ type: "error", message: "bad request" });
		expect(events).toContainEqual({
			type: "done",
			reason: "error",
			steps: 1,
		});
	});

	it("aborts when the signal fires during a turn", async () => {
		const controller = new AbortController();
		const provider: Provider = {
			id: "abort",
			async *stream() {
				yield { type: "text_delta", text: "partial" };
				controller.abort();
			},
		};
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "go",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("aborted");
		expect(events).toContainEqual({
			type: "done",
			reason: "aborted",
			steps: 1,
		});
	});

	it("stops at maxSteps when every turn calls a tool", async () => {
		const toolTurn = [
			{
				type: "tool_call" as const,
				id: "call_1",
				name: "read_file",
				args: { path: "a.txt" },
			},
			{ type: "finish" as const, reason: "tool_calls" as const },
		];
		const provider = createMockProvider([toolTurn, toolTurn, toolTurn]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "loop",
			maxSteps: 2,
			onEvent: () => {},
		});

		expect(result.reason).toBe("max_steps");
		expect(result.steps).toBe(2);
		expect(provider.requests).toHaveLength(2);
	});
});
