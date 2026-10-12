import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-tools-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("send_message", () => {
	it("delivers a DM to the target rob and records it in the DM log", async () => {
		const plannerProvider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "send_message",
					args: { to: "worker", text: "ping" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "planner done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const workerProvider = createMockProvider([
			[
				{ type: "text_delta", text: "worker ack" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [
				{ name: "planner", role: "plan" },
				{ name: "worker", role: "work" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: (rob) =>
				rob.name === "planner" ? plannerProvider : workerProvider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
		});
		team.start();

		team.dispatch("planner", "go");
		await waitFor(
			() =>
				plannerProvider.requests.length === 2 &&
				workerProvider.requests.length === 1 &&
				team
					.statuses()
					.every((status) => status.status === "idle" && status.pending === 0),
			"the DM to be delivered and both robs to settle",
		);
		await team.stop();

		expect(team.readDms()).toEqual([
			{ from: "planner", to: "worker", text: "ping", at: expect.any(Number) },
		]);

		const workerUser = workerProvider.requests[0].messages.find(
			(message) => message.role === "user",
		);
		expect(workerUser?.content).toBe("[from rob:planner] ping");
	});

	it("rejects the 21st DM in a single run", async () => {
		const calls = Array.from({ length: 21 }, (_, index) => ({
			type: "tool_call" as const,
			id: `call_${index}`,
			name: "send_message",
			args: { to: "worker", text: `m${index}` },
		}));
		const plannerProvider = createMockProvider([
			[...calls, { type: "finish", reason: "tool_calls" }],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const workerProvider = createMockProvider([]);
		const team = new Team({
			robs: [
				{ name: "planner", role: "plan" },
				{ name: "worker", role: "work" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: (rob) =>
				rob.name === "planner" ? plannerProvider : workerProvider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
		});
		team.start();

		team.dispatch("planner", "spam");
		await waitFor(
			() =>
				plannerProvider.requests.length === 2 &&
				team
					.statuses()
					.every((status) => status.status === "idle" && status.pending === 0),
			"the 21 sends to complete",
		);
		await team.stop();

		const toolMessages = plannerProvider.requests[1].messages.filter(
			(message) => message.role === "tool",
		);
		expect(toolMessages).toHaveLength(21);
		expect(toolMessages[20]).toEqual({
			role: "tool",
			toolCallId: "call_20",
			content: "DM limit reached: a rob may send at most 20 messages per run.",
			isError: true,
		});
		expect(team.readDms()).toHaveLength(20);
	});
});

describe("delegate", () => {
	it("runs a sub-agent with fresh history and returns its text to the parent", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "delegate",
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
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
		});
		team.start();

		team.dispatch("planner", "parent task");
		await waitFor(
			() =>
				provider.requests.length === 3 && team.statuses()[0].status === "idle",
			"the delegate run to finish",
		);
		await team.stop();

		const parentTools = provider.requests[0].tools.map((tool) => tool.name);
		expect(parentTools).toContain("send_message");
		expect(parentTools).toContain("delegate");

		const subRequest = provider.requests[1];
		expect(subRequest.messages).toHaveLength(2);
		expect(subRequest.messages[0].role).toBe("system");
		expect(subRequest.messages[1]).toEqual({
			role: "user",
			content: "sub task",
		});
		expect(subRequest.messages).not.toContainEqual({
			role: "user",
			content: "[from user] parent task",
		});
		const subTools = subRequest.tools.map((tool) => tool.name);
		expect(subTools).not.toContain("send_message");
		expect(subTools).not.toContain("delegate");

		const parentToolMessage = provider.requests[2].messages.find(
			(message) => message.role === "tool",
		);
		expect(parentToolMessage).toEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "sub result",
			isError: false,
		});

		const subagents = team.readSubagents("planner");
		expect(subagents).toContainEqual(
			expect.objectContaining({
				parent: "planner",
				id: "planner-sub-0",
				event: { type: "text_delta", text: "sub result" },
			}),
		);
		expect(subagents.every((entry) => entry.parent === "planner")).toBe(true);
	});
});
