import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider, ToolMessage } from "../../src/providers/types.js";
import { Rob } from "../../src/rob/rob.js";
import { Team } from "../../src/rob/team.js";
import type { Tool } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, FakeTeam, waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("Rob", () => {
	it("replies to a dispatched user message and keeps history across runs", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "first reply" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "second reply" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "coordinate the team" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
		});
		team.start();

		team.dispatch("planner", "hello");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"first reply",
		);

		team.dispatch("planner", "again");
		await waitFor(
			() =>
				provider.requests.length === 2 && team.statuses()[0].status === "idle",
			"second reply",
		);
		await team.stop();

		const status = team.statuses()[0];
		expect(status.name).toBe("planner");
		expect(status.status).toBe("stopped");
		expect(status.messageCount).toBe(4);
		expect(status.lastMessage).toBe("second reply");

		const first = provider.requests[0].messages;
		expect(first[0].role).toBe("system");
		expect(first[0].content).toContain('You are rob "planner"');
		expect(first[0].content).toContain("coordinate the team");
		expect(first).toContainEqual({
			role: "user",
			content: "[from user] hello",
		});

		// The second request carries the first run's history.
		expect(provider.requests[1].messages).toContainEqual({
			role: "assistant",
			content: [{ type: "text", text: "first reply" }],
		});
		expect(provider.requests[1].messages).toContainEqual({
			role: "user",
			content: "[from user] again",
		});
	});

	it("adds a delegate sub-agent's usage to the rob's totals", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "delegate",
					args: { task: "count the files" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "usage", inputTokens: 5, outputTokens: 3 },
				{ type: "text_delta", text: "sub answer" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "usage", inputTokens: 10, outputTokens: 4 },
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		expect(rob.statusSnapshot().usage).toEqual({ input: 15, output: 7 });
	});

	it("aborts an in-flight run when stop is called", async () => {
		const provider: Provider = {
			id: "slow",
			async *stream(request) {
				yield { type: "text_delta", text: "working" };
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) {
						resolve();
						return;
					}
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			},
		};
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			team: new FakeTeam(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "long task", at: 0 });
		await waitFor(
			() => rob.readEvents().some((event) => event.type === "text_delta"),
			"the provider to yield before the abort",
		);

		rob.stop();
		await running;

		expect(rob.statusSnapshot().status).toBe("stopped");
		expect(rob.readEvents()).toContainEqual({
			type: "done",
			reason: "aborted",
			steps: 1,
		});
	});

	it("advertises and runs an injected extra tool beside send_message and delegate", async () => {
		const extra: Tool = {
			name: "mcp__memory__create_entity",
			description: "create an entity",
			readOnly: false,
			parameters: { type: "object", properties: { name: { type: "string" } } },
			execute: async () => ({ ok: true, output: "created Ada" }),
		};
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "mcp__memory__create_entity",
					args: { name: "Ada" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			extraTools: [extra],
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		const names = provider.requests[0].tools.map((tool) => tool.name);
		expect(names).toContain("mcp__memory__create_entity");
		expect(names).toContain("send_message");
		expect(names).toContain("delegate");

		const toolMessages = provider.requests[1].messages.filter(
			(message): message is ToolMessage => message.role === "tool",
		);
		expect(toolMessages).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "created Ada",
			isError: false,
		});
	});
});
