import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { addPermissionRule } from "../../src/config/project-file.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { createAuthorizer } from "../../src/permissions/authorizer.js";
import { defaultRules } from "../../src/permissions/rules.js";
import {
	ApprovalQueue,
	UnknownApprovalError,
} from "../../src/rob/approvals.js";
import { TEAM_STOPPED_REASON, Team } from "../../src/rob/team.js";
import type { Tool } from "../../src/tools/types.js";
import { writeFileTool } from "../../src/tools/write_file.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

vi.mock("../../src/config/project-file.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/config/project-file.js")>();
	return { ...actual, addPermissionRule: vi.fn(actual.addPermissionRule) };
});

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-approvals-");
	vi.clearAllMocks();
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function request(subject: string) {
	return {
		toolName: "write_file",
		subject,
		dangerous: false,
		rule: subject,
	};
}

describe("ApprovalQueue", () => {
	it("keeps two robs in FIFO order and resolves each promise", async () => {
		const queue = new ApprovalQueue();
		const first = queue.request("planner", request("a.txt"));
		const second = queue.request("worker", request("b.txt"));

		expect(queue.pending()).toEqual([
			{
				id: "approval-0",
				rob: "planner",
				toolName: "write_file",
				subject: "a.txt",
				dangerous: false,
				rule: "a.txt",
			},
			{
				id: "approval-1",
				rob: "worker",
				toolName: "write_file",
				subject: "b.txt",
				dangerous: false,
				rule: "b.txt",
			},
		]);

		queue.resolve("approval-0", "allow_once");
		expect(await first.decision).toBe("allow_once");
		expect(queue.pending().map((entry) => entry.rob)).toEqual(["worker"]);

		queue.resolve("approval-1", "deny");
		expect(await second.decision).toBe("deny");
		expect(queue.pending()).toEqual([]);
	});

	it("throws a typed error for an unknown or already resolved id", () => {
		const queue = new ApprovalQueue();
		const entry = queue.request("planner", request("a.txt"));
		queue.resolve(entry.id, "allow_once");

		expect(() => queue.resolve(entry.id, "allow_once")).toThrow(
			UnknownApprovalError,
		);
		expect(() => queue.resolve(entry.id, "allow_once")).toThrow(
			"Unknown or already resolved approval: approval-0",
		);
	});

	it("denies every pending request with the literal reason", async () => {
		const queue = new ApprovalQueue();
		const first = queue.request("planner", request("a.txt"));
		const second = queue.request("worker", request("b.txt"));

		queue.denyAll("The team stopped before this approval was answered.");

		expect(await first.decision).toEqual({
			deny: "The team stopped before this approval was answered.",
		});
		expect(await second.decision).toEqual({
			deny: "The team stopped before this approval was answered.",
		});
		expect(queue.pending()).toEqual([]);
	});

	it("denies an unanswered request when the injected timer expires", async () => {
		const queue = new ApprovalQueue();
		const timers: Array<() => void> = [];
		let canceled = 0;
		const schedule = (_delayMs: number, fn: () => void) => {
			timers.push(fn);
			return () => {
				canceled += 1;
			};
		};

		const entry = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		expect(queue.pending()).toHaveLength(1);
		expect(timers).toHaveLength(1);

		timers[0]?.();
		expect(await entry.decision).toEqual({
			deny: "No one answered this approval within 0.05s, so it was denied.",
		});
		expect(queue.pending()).toEqual([]);
		expect(canceled).toBe(1);

		// Resolving first clears the timer instead of letting it fire later.
		const answered = queue.request("planner", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		queue.resolve(answered.id, "allow_once");
		expect(await answered.decision).toBe("allow_once");
		expect(canceled).toBe(2);
	});

	it("expires only the head: a queued request starts its window on promotion", async () => {
		const queue = new ApprovalQueue();
		const timers: Array<() => void> = [];
		const schedule = (_delayMs: number, fn: () => void) => {
			timers.push(fn);
			return () => undefined;
		};

		const first = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		const second = queue.request("worker", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		// Only the head is armed: the queued request is invisible to
		// the client and must still be pending at the head's deadline.
		expect(timers).toHaveLength(1);
		timers[0]?.();
		expect(await first.decision).toEqual({
			deny: "No one answered this approval within 0.05s, so it was denied.",
		});
		expect(queue.pending().map((entry) => entry.subject)).toEqual(["b.txt"]);

		// Promotion armed the second's own window, so it expires on
		// that later deadline, not on the first's.
		expect(timers).toHaveLength(2);
		timers[1]?.();
		expect(await second.decision).toEqual({
			deny: "No one answered this approval within 0.05s, so it was denied.",
		});
		expect(queue.pending()).toEqual([]);
	});

	it("reports a deadline only once the window is armed", async () => {
		const queue = new ApprovalQueue();
		const schedule = () => () => undefined;

		const first = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		// The head is armed at enqueue, so the client can count it down.
		expect(queue.deadline(first.id)).not.toBeNull();

		const second = queue.request("worker", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		// A queued request has no window yet, so it has no deadline to show.
		expect(queue.deadline(second.id)).toBeNull();

		queue.resolve(first.id, "allow_once");
		expect(await first.decision).toBe("allow_once");
		// Promotion starts the window, and only now is there a deadline.
		const deadline = queue.deadline(second.id);
		expect(deadline).not.toBeNull();
		expect(deadline as number).toBeGreaterThan(Date.now());

		queue.denyAll("stopped");
		// Once taken, the request is gone and so is its deadline.
		expect(queue.deadline(second.id)).toBeNull();
	});

	it("announces the deadline when a queued request is promoted", async () => {
		const armed: Array<{ id: string; expiresAt: number }> = [];
		const queue = new ApprovalQueue({
			onArm: (pending, expiresAt) => {
				armed.push({ id: pending.id, expiresAt });
			},
		});
		const schedule = () => () => undefined;

		const first = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		const second = queue.request("worker", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		// The head's emitter announces it right after enqueue, so arming it
		// here must not announce it twice.
		expect(armed).toEqual([]);

		queue.resolve(first.id, "allow_once");
		expect(await first.decision).toBe("allow_once");
		expect(armed).toHaveLength(1);
		expect(armed[0].id).toBe(second.id);
		expect(armed[0].expiresAt).toBe(queue.deadline(second.id));
	});

	it("starts the next request's window when the head resolves", async () => {
		const queue = new ApprovalQueue();
		const timers: Array<() => void> = [];
		const schedule = (_delayMs: number, fn: () => void) => {
			timers.push(fn);
			return () => undefined;
		};

		const first = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		const second = queue.request("worker", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		expect(timers).toHaveLength(1);

		queue.resolve(first.id, "allow_once");
		expect(await first.decision).toBe("allow_once");
		// Resolving the head promoted the second, arming its own timer.
		expect(timers).toHaveLength(2);
		timers[1]?.();
		expect(await second.decision).toEqual({
			deny: "No one answered this approval within 0.05s, so it was denied.",
		});
	});

	it("clears the armed timer when denyAll empties the queue", async () => {
		const queue = new ApprovalQueue();
		const timers: Array<() => void> = [];
		let canceled = 0;
		const schedule = (_delayMs: number, fn: () => void) => {
			timers.push(fn);
			return () => {
				canceled += 1;
			};
		};

		const first = queue.request("planner", request("a.txt"), {
			timeoutMs: 50,
			schedule,
		});
		const second = queue.request("worker", request("b.txt"), {
			timeoutMs: 50,
			schedule,
		});
		expect(timers).toHaveLength(1);

		queue.denyAll("The team stopped before this approval was answered.");

		expect(await first.decision).toEqual({
			deny: "The team stopped before this approval was answered.",
		});
		expect(await second.decision).toEqual({
			deny: "The team stopped before this approval was answered.",
		});
		expect(queue.pending()).toEqual([]);
		// Both the head's timer and the one promotion armed are cleared.
		expect(canceled).toBe(2);
	});
});

describe("allow_always", () => {
	it("writes exactly once when two identical requests come in", async () => {
		const queue = new ApprovalQueue();
		const authorize = (rob: string) =>
			createAuthorizer({
				workspaceRoot: workspace,
				rules: defaultRules(),
				approval: (approval) => queue.request(rob, approval).decision,
				yesAll: false,
			});
		const call = {
			id: "call_1",
			name: "write_file",
			args: { path: "out.txt", content: "x" },
		};

		const first = authorize("planner")(call, writeFileTool);
		const second = authorize("worker")(call, writeFileTool);
		await waitFor(
			() => queue.pending().length === 2,
			"both robs to ask at the same time",
		);

		queue.resolve("approval-0", "allow_always");

		expect(await first).toEqual({ allowed: true, remember: true });
		expect(await second).toEqual({ allowed: true });
		expect(queue.pending()).toEqual([]);
		expect(vi.mocked(addPermissionRule)).toHaveBeenCalledTimes(1);
	});
});

describe("Team stop", () => {
	it("denies pending approvals and stops the rob", async () => {
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => createMockProvider([]),
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
		});
		team.start();

		const decision = team.requestApproval("planner", request("a.txt"));
		await waitFor(
			() => team.statuses()[0].status === "waiting_approval",
			"the planner to wait for approval",
		);

		await team.stop();

		expect(await decision).toEqual({ deny: TEAM_STOPPED_REASON });
		expect(team.statuses()[0].status).toBe("stopped");
		await expect(
			team.requestApproval("planner", request("a.txt")),
		).resolves.toEqual({ deny: TEAM_STOPPED_REASON });
	});
});

describe("approval timeout", () => {
	it("denies an unanswered approval so the rob's turn finishes", async () => {
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
			approvalTimeoutMs: 50,
		});
		const decisions: string[] = [];
		const armed: number[] = [];
		team.subscribe((event) => {
			if (event.kind === "approval_resolved") decisions.push(event.decision);
			if (
				event.kind === "approval_requested" &&
				event.expiresAt !== undefined
			) {
				armed.push(event.expiresAt);
			}
		});

		const before = Date.now();
		team.start();
		team.dispatch("planner", "go");
		await waitFor(
			() =>
				team.statuses()[0].status === "idle" && provider.requests.length === 2,
			"the timed-out turn to finish",
		);
		await team.stop();

		expect(decisions).toEqual(["deny"]);
		expect(provider.requests).toHaveLength(2);
		// The emitted request carried the deadline it was armed with, so a
		// client could have counted it down.
		expect(armed).toHaveLength(1);
		expect(armed[0]).toBeGreaterThan(before);
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
