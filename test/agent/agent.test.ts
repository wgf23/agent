import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type {
	Message,
	Provider,
	ToolMessage,
} from "../../src/providers/types.js";
import { withoutSystem } from "../../src/session/store.js";
import type { Tool } from "../../src/tools/types.js";
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

		const events: AgentEvent[] = [];
		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(2);
		expect(provider.requests).toHaveLength(2);
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: true,
			status: "ok",
			summary: "1\talpha",
			output: "1\talpha\n2\tbeta",
		});
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

		const events: AgentEvent[] = [];
		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "write new.txt",
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "write_file",
			ok: false,
			status: "blocked",
			summary:
				"Tool write_file is not authorized yet. Only read-only tools run in this mode.",
			output:
				"Tool write_file is not authorized yet. Only read-only tools run in this mode.",
		});
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

		const events: AgentEvent[] = [];
		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read missing.txt",
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(result.steps).toBe(2);
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "read_file",
			ok: false,
			status: "error",
			summary: "read_file: file not found: missing.txt",
			output: "read_file: file not found: missing.txt",
		});
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "read_file: file not found: missing.txt",
			isError: true,
		});
	});

	it("caps the UI output at 4000 characters without changing the model result", async () => {
		await writeFile(path.join(workspace, "big.txt"), "x".repeat(5000), "utf8");
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "read_file",
					args: { path: "big.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const events: AgentEvent[] = [];
		await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read big.txt",
			onEvent: (event) => events.push(event),
		});

		const finished = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_finished" }> =>
				event.type === "tool_finished",
		);
		expect(finished?.output.endsWith("[truncated]")).toBe(true);
		expect(finished?.output.length).toBe(4000 + "[truncated]".length);
		expect(toolMessages(provider.requests[1].messages)[0].content).toHaveLength(
			5002,
		);
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

	it("appends drainInput messages before the next request", async () => {
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
		let calls = 0;
		const drained: Message[] = [{ role: "user", content: "interjected" }];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "read a.txt",
			drainInput: () => {
				calls += 1;
				return calls === 2 ? drained : [];
			},
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(provider.requests[0].messages).not.toContainEqual({
			role: "user",
			content: "interjected",
		});
		const second = provider.requests[1].messages;
		expect(second).toContainEqual({ role: "user", content: "interjected" });
		expect(second[second.length - 1]).toEqual({
			role: "user",
			content: "interjected",
		});
		expect(second[second.length - 2].role).toBe("tool");
	});

	it("advertises and executes an extra tool", async () => {
		const echoSchema = z.object({ text: z.string() });
		const echoTool: Tool<typeof echoSchema> = {
			name: "echo",
			description: "Echo the text back.",
			schema: echoSchema,
			readOnly: true,
			async execute(args) {
				return { ok: true, output: `echo:${args.text}` };
			},
		};
		const provider = createMockProvider([
			[
				{ type: "tool_call", id: "call_1", name: "echo", args: { text: "hi" } },
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "echo",
			extraTools: [echoTool],
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
			"echo",
		);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "echo:hi",
			isError: false,
		});
		expect(events).toContainEqual({
			type: "tool_finished",
			id: "call_1",
			name: "echo",
			ok: true,
			status: "ok",
			summary: "echo:hi",
			output: "echo:hi",
		});
	});

	it("lets an extra tool shadow a same-named built-in", async () => {
		const shadowSchema = z.object({ path: z.string() });
		let ran = false;
		const shadowedReadFile: Tool<typeof shadowSchema> = {
			name: "read_file",
			description: "Bridged read_file (host-side).",
			schema: shadowSchema,
			readOnly: true,
			async execute() {
				ran = true;
				return { ok: true, output: "served by the bridge" };
			},
		};
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
			prompt: "read",
			extraTools: [shadowedReadFile],
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		const names = provider.requests[0].tools.map((tool) => tool.name);
		expect(names.filter((name) => name === "read_file")).toHaveLength(1);
		expect(ran).toBe(true);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "served by the bridge",
			isError: false,
		});
	});

	it("deduplicates two extra tools that share a name, first one winning", async () => {
		const dupeSchema = z.object({ text: z.string() });
		const makeDupe = (tag: string): Tool<typeof dupeSchema> => ({
			name: "echo",
			description: `Echo (${tag}).`,
			schema: dupeSchema,
			readOnly: true,
			async execute() {
				return { ok: true, output: tag };
			},
		});
		const provider = createMockProvider([
			[
				{ type: "tool_call", id: "call_1", name: "echo", args: { text: "hi" } },
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
			prompt: "echo",
			extraTools: [makeDupe("first"), makeDupe("second")],
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		const names = provider.requests[0].tools.map((tool) => tool.name);
		expect(names.filter((name) => name === "echo")).toHaveLength(1);
		expect(toolMessages(provider.requests[1].messages)).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "first",
			isError: false,
		});
	});
});

describe("runAgent compaction", () => {
	const oldest = "oldest question";

	it("replaces the older history with a summary before the first request", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "SUMMARY-TEXT" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "new question",
			history: [
				{ role: "user", content: `${oldest} ${"x".repeat(4000)}` },
				{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			],
			compaction: { auto: true, thresholdTokens: 100, keepRecentTokens: 1 },
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events).toContainEqual({
			type: "compacted",
			removedMessages: 2,
			summaryChars: "SUMMARY-TEXT".length,
		});
		expect(provider.requests).toHaveLength(2);
		const second = provider.requests[1].messages;
		expect(second).toContainEqual({
			role: "user",
			content: "[compacted summary]\nSUMMARY-TEXT",
		});
		expect(
			second.some(
				(message) =>
					message.role === "user" && message.content.includes(oldest),
			),
		).toBe(false);
	});

	it("leaves the history alone under a large threshold", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "new question",
			history: [
				{ role: "user", content: oldest },
				{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			],
			compaction: {
				auto: true,
				thresholdTokens: 10_000_000,
				keepRecentTokens: 1,
			},
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(provider.requests).toHaveLength(1);
		expect(events.some((event) => event.type === "compacted")).toBe(false);
		expect(provider.requests[0].messages).toContainEqual({
			role: "user",
			content: oldest,
		});
	});

	it("skips compaction and continues when the summary call fails", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "summary down", retryable: false }],
			[
				{ type: "text_delta", text: "answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "new question",
			history: [
				{ role: "user", content: `${oldest} ${"x".repeat(4000)}` },
				{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			],
			compaction: { auto: true, thresholdTokens: 100, keepRecentTokens: 1 },
			onEvent: (event) => events.push(event),
		});

		expect(result.reason).toBe("finished");
		expect(events.some((event) => event.type === "compacted")).toBe(false);
		expect(
			provider.requests[1].messages.some(
				(message) =>
					message.role === "user" && message.content.includes(oldest),
			),
		).toBe(true);
	});

	it("keeps the summary across turns when the persisted history is replayed", async () => {
		const summaryText = "The user asked to remember MANGO.";
		const firstProvider = createMockProvider([
			[
				{ type: "text_delta", text: summaryText },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "OK" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const first = await runAgent({
			provider: firstProvider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "new question",
			history: [
				{ role: "user", content: `remember MANGO ${"x".repeat(4000)}` },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			],
			compaction: { auto: true, thresholdTokens: 100, keepRecentTokens: 1 },
			onEvent: () => {},
		});

		expect(first.messages).toContainEqual({
			role: "user",
			content: `[compacted summary]\n${summaryText}`,
		});

		// The persistence boundary drops system messages before the next run.
		const secondProvider = createMockProvider([
			[
				{ type: "text_delta", text: "MANGO" },
				{ type: "finish", reason: "stop" },
			],
		]);
		await runAgent({
			provider: secondProvider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "what word were you told to remember?",
			history: withoutSystem(first.messages),
			onEvent: () => {},
		});

		expect(secondProvider.requests[0].messages).toContainEqual({
			role: "user",
			content: `[compacted summary]\n${summaryText}`,
		});
	});
});
