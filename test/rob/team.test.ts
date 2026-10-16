import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { manualClock, manualTimer } from "../../src/bot/wake.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import {
	type ApprovalRequest,
	createAuthorizer,
} from "../../src/permissions/authorizer.js";
import { Team, UnknownRobError } from "../../src/rob/team.js";
import type { TurnHost } from "../../src/rob/types.js";
import type { Tool } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-team-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function makeTeam(): Team {
	return new Team({
		robs: [
			{ name: "planner", role: "plan" },
			{ name: "worker", role: "work" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: () => createMockProvider([]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
	});
}

describe("Team", () => {
	it("throws a typed error when dispatching to an unknown rob", () => {
		const team = makeTeam();

		expect(() => team.dispatch("ghost", "hi")).toThrow(UnknownRobError);
		expect(() => team.dispatch("ghost", "hi")).toThrow("Unknown rob: ghost");
	});

	it("returns a DM snapshot that cannot mutate the log", () => {
		const team = makeTeam();
		team.postDm("planner", "worker", "secret");

		const snapshot = team.readDms();
		expect(snapshot).toEqual([
			{ from: "planner", to: "worker", text: "secret", at: expect.any(Number) },
		]);

		snapshot[0].text = "tampered";
		expect(team.readDms()[0].text).toBe("secret");
	});

	it("reports a status snapshot per rob", () => {
		const team = makeTeam();

		expect(team.statuses()).toEqual([
			{
				name: "planner",
				status: "idle",
				messageCount: 0,
				pending: 0,
				lastMessage: null,
				usage: { input: 0, output: 0 },
			},
			{
				name: "worker",
				status: "idle",
				messageCount: 0,
				pending: 0,
				lastMessage: null,
				usage: { input: 0, output: 0 },
			},
		]);
	});

	it("sums token usage per rob from the event stream", async () => {
		const provider = createMockProvider([
			[
				{ type: "usage", inputTokens: 12, outputTokens: 7 },
				{ type: "usage", inputTokens: 3, outputTokens: 5 },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
		});
		team.start();

		team.dispatch("planner", "go");
		await waitFor(() => {
			const status = team.statuses()[0];
			return status.status === "idle" && status.pending === 0;
		}, "the planner to finish");

		expect(team.statuses()[0].usage).toEqual({ input: 15, output: 12 });
		await team.stop();
	});

	it("advertises extra tools to every native rob", async () => {
		const providers: Record<string, ReturnType<typeof createMockProvider>> = {
			planner: createMockProvider([
				[
					{ type: "text_delta", text: "planned" },
					{ type: "finish", reason: "stop" },
				],
			]),
			worker: createMockProvider([
				[
					{ type: "text_delta", text: "worked" },
					{ type: "finish", reason: "stop" },
				],
			]),
		};
		const team = new Team({
			robs: [
				{ name: "planner", role: "plan" },
				{ name: "worker", role: "work" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: (rob) => providers[rob.name],
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			extraTools: [mcpTool()],
		});

		team.start();
		team.dispatch("planner", "go");
		await waitFor(
			() =>
				providers.planner.requests.length === 1 &&
				team.statuses()[0].status === "idle",
			"the planner to finish",
		);
		team.dispatch("worker", "go");
		await waitFor(
			() => providers.worker.requests.length === 1,
			"the worker to start",
		);
		await team.stop();

		expect(
			providers.planner.requests[0].tools.map((tool) => tool.name),
		).toContain("mcp__memory__create_entity");
		expect(
			providers.worker.requests[0].tools.map((tool) => tool.name),
		).toContain("mcp__memory__create_entity");
	});

	it("keeps a cli rob out of the extra tools without crashing", async () => {
		const native = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const cliProvider = createMockProvider([]);
		const team = new Team({
			robs: [
				{ name: "planner", role: "plan" },
				{
					name: "worker",
					role: "work",
					backend: {
						kind: "cli",
						command: "pi",
						provider: "deepseek",
						model: "deepseek-v4-flash",
					},
				},
			],
			defaultModel: "deepseek-flash",
			providerFactory: (rob) => (rob.name === "planner" ? native : cliProvider),
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			extraTools: [mcpTool()],
		});

		team.start();
		team.dispatch("planner", "go");
		await waitFor(
			() =>
				native.requests.length === 1 && team.statuses()[0].status === "idle",
			"the planner to finish",
		);
		await team.stop();

		expect(native.requests[0].tools.map((tool) => tool.name)).toContain(
			"mcp__memory__create_entity",
		);
		// The pi backend runs its own registry, so the mock never sees a request.
		expect(cliProvider.requests).toEqual([]);
		expect(team.statuses()).toHaveLength(2);
	});

	it("asks the rob's authorizer for an MCP tool call by default", async () => {
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
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: (rob) =>
				createAuthorizer({
					workspaceRoot: workspace,
					rules: rob.rules,
					approval: rob.approval,
					yesAll: false,
					allowAll: createAllowAll(false),
				}),
			extraTools: [mcpTool()],
		});
		const requests: ApprovalRequest[] = [];
		team.subscribe((event) => {
			if (event.kind !== "approval_requested") return;
			requests.push(event.request);
			team.resolveApproval(event.request.id, "allow_once");
		});

		team.start();
		team.dispatch("planner", "go");
		await waitFor(
			() =>
				team.statuses()[0].status === "idle" && provider.requests.length === 2,
			"the rob to finish",
		);
		await team.stop();

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			rob: "planner",
			toolName: "mcp__memory__create_entity",
			subject: "",
			dangerous: false,
		});
		expect(provider.requests[1].messages).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "created",
			isError: false,
		});
	});
});

describe("Team sessions", () => {
	it("reports the live roster in configuration order", () => {
		const team = makeTeam();

		expect(team.roster()).toEqual([
			{ name: "planner", role: "plan" },
			{ name: "worker", role: "work" },
		]);
	});

	it("refuses a DM to an unknown rob instead of dropping it", () => {
		const team = makeTeam();

		expect(team.postDm("planner", "ghost", "hi")).toEqual({
			status: "rejected",
			reason: "unknown_target",
		});
		expect(team.readDms()).toEqual([]);
	});

	it("refuses a DM to the sender", () => {
		const team = makeTeam();

		expect(team.postDm("planner", "planner", "hi")).toEqual({
			status: "rejected",
			reason: "self",
		});
		expect(team.readDms()).toEqual([]);
	});

	it("refuses a DM once the team is stopping", async () => {
		const team = makeTeam();
		await team.stop();

		expect(team.postDm("planner", "worker", "late")).toEqual({
			status: "rejected",
			reason: "team_stopped",
		});
		expect(team.readDms()).toEqual([]);
	});

	it("opens one turn bridge per rob and rejects a second concurrent turn", async () => {
		const team = makeTeam();
		const host: TurnHost = {
			signal: new AbortController().signal,
			workspaceRoot: workspace,
			authorize: async () => ({ allowed: true }),
			runSubagent: async () => "answer",
		};

		await expect(team.beginTurn("ghost", host)).rejects.toThrow(
			"Unknown rob: ghost",
		);

		const bridge = await team.beginTurn("planner", host);
		expect(bridge.rob).toBe("planner");
		expect(bridge.roster()).toEqual([{ name: "worker", role: "work" }]);
		await expect(team.beginTurn("planner", host)).rejects.toThrow(
			'Rob "planner" already has a turn in flight.',
		);

		bridge.close();
		const next = await team.beginTurn("planner", host);
		next.close();
		await team.stop();
	});

	it("rejects one of two concurrent turns for the same rob", async () => {
		const team = makeTeam();
		const host: TurnHost = {
			signal: new AbortController().signal,
			workspaceRoot: workspace,
			authorize: async () => ({ allowed: true }),
			runSubagent: async () => "answer",
		};

		const [first, second] = await Promise.allSettled([
			team.beginTurn("planner", host),
			team.beginTurn("planner", host),
		]);

		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		if (first.status === "fulfilled") first.value.close();
		await team.stop();
	});

	it("notices when a rob wakes on its interval", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "awake" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const manual = manualTimer();
		const team = new Team({
			robs: [
				{
					name: "planner",
					role: "plan",
					wake: { everyMs: 60000, prompt: "check the board" },
				},
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			clock: manualClock(0),
			timer: manual.timer,
		});
		const notices: string[] = [];
		team.subscribe((event) => {
			if (event.kind === "notice") notices.push(event.text);
		});

		team.start();
		manual.fire("planner");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the wake's turn",
		);
		await team.stop();

		expect(notices).toContain("woke on interval");
	});

	it("removes a rob, disarms its wake, and denies further work", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "awake" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const manual = manualTimer();
		const team = new Team({
			robs: [
				{
					name: "planner",
					role: "plan",
					wake: { everyMs: 60000, prompt: "check the board" },
				},
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			timer: manual.timer,
		});
		team.start();
		expect(manual.pending()).toHaveLength(1);

		expect(() => team.removeRob("ghost")).toThrow(UnknownRobError);
		team.removeRob("planner");

		expect(team.hasRob("planner")).toBe(false);
		expect(team.statuses()).toEqual([]);
		expect(manual.pending()).toEqual([]);
		expect(() => team.dispatch("planner", "go")).toThrow(
			"Unknown rob: planner",
		);

		// The disarmed timer can no longer deliver a turn.
		manual.fire("planner");
		expect(provider.requests).toEqual([]);
		await team.stop();
	});

	it("replaces a rob's config in place and keeps its wake", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [
				{
					name: "planner",
					role: "old role",
					wake: { everyMs: 60000, prompt: "check" },
				},
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
		});
		team.start();

		expect(() => team.updateRob({ name: "ghost", role: "x" })).toThrow(
			UnknownRobError,
		);
		team.updateRob({
			name: "planner",
			role: "new role",
			model: "deepseek-chat",
		});

		expect(team.hasRob("planner")).toBe(true);
		expect(team.robWake("planner")).toEqual({
			everyMs: 60000,
			prompt: "check",
		});

		team.dispatch("planner", "go");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the edited rob's turn",
		);
		await team.stop();
		expect(provider.requests[0].model).toBe("deepseek-chat");
	});
});

function mcpTool(): Tool {
	return {
		name: "mcp__memory__create_entity",
		description: "create an entity",
		readOnly: false,
		parameters: { type: "object", properties: { name: { type: "string" } } },
		execute: async () => ({ ok: true, output: "created" }),
	};
}
