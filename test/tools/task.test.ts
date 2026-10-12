import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import type { Authorize } from "../../src/agent/authorize.js";
import type { Message, TextBlock } from "../../src/providers/types.js";
import {
	createTaskTool,
	MAX_TASK_DEPTH,
	TASK_OUTPUT_MAX_CHARS,
} from "../../src/tools/task.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-task-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("createTaskTool", () => {
	it("exposes a non-read-only task tool with a strict schema", () => {
		const tool = createTaskTool({ depth: 0, run: async () => "" });
		expect(tool.name).toBe("task");
		expect(tool.readOnly).toBe(false);
		expect(tool.schema?.safeParse({ task: "x" }).success).toBe(true);
		expect(tool.schema?.safeParse({ task: "x", extra: 1 }).success).toBe(false);
	});

	it("runs the injected runner and returns its text", async () => {
		const calls: { task: string; signal?: AbortSignal }[] = [];
		const tool = createTaskTool({
			depth: 0,
			run: async (task, signal) => {
				calls.push({ task, signal });
				return "sub-agent answer";
			},
		});
		const result = await tool.execute(
			{ task: "summarize the repo" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "sub-agent answer" });
		expect(calls).toEqual([{ task: "summarize the repo", signal: undefined }]);
	});

	it("caps the returned text at 4000 characters", async () => {
		const tool = createTaskTool({
			depth: 0,
			run: async () => "x".repeat(TASK_OUTPUT_MAX_CHARS + 100),
		});
		const result = await tool.execute(
			{ task: "big" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "x".repeat(TASK_OUTPUT_MAX_CHARS),
		});
	});

	it("turns a rejected runner into an error without throwing", async () => {
		const tool = createTaskTool({
			depth: 0,
			run: async () => {
				throw new Error("boom");
			},
		});
		const result = await tool.execute(
			{ task: "failing" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: false, error: "boom" });
	});

	it("refuses to run at the depth cap without calling the runner", async () => {
		let ran = false;
		const tool = createTaskTool({
			depth: MAX_TASK_DEPTH,
			run: async () => {
				ran = true;
				return "should not run";
			},
		});
		const result = await tool.execute(
			{ task: "nested" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "Sub-agents cannot delegate further.",
		});
		expect(ran).toBe(false);
	});
});

describe("task integration", () => {
	it("returns the sub-agent text to the parent and gives the sub-agent no task tool", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "task",
					args: { task: "sub task" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "sub result" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "parent done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const authorize: Authorize = async () => ({ allowed: true });

		const run = (task: string, signal?: AbortSignal): Promise<string> =>
			runAgent({
				provider,
				model: "deepseek-flash",
				workspaceRoot: workspace,
				prompt: task,
				history: [],
				signal,
				authorize,
				onEvent: () => {},
			}).then((result) => lastAssistantText(result.messages));

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			prompt: "parent task",
			authorize,
			extraTools: [createTaskTool({ depth: 0, run })],
			onEvent: () => {},
		});

		expect(result.reason).toBe("finished");
		expect(provider.requests).toHaveLength(3);

		const parentTools = provider.requests[0].tools.map((tool) => tool.name);
		expect(parentTools).toContain("task");

		const subRequest = provider.requests[1];
		expect(subRequest.tools.map((tool) => tool.name)).not.toContain("task");
		expect(subRequest.messages).toHaveLength(2);
		expect(subRequest.messages[1]).toEqual({
			role: "user",
			content: "sub task",
		});

		const parentToolMessage = provider.requests[2].messages.find(
			(message) => message.role === "tool",
		);
		expect(parentToolMessage).toEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "sub result",
			isError: false,
		});
	});
});

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
