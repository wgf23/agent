import { describe, expect, it } from "vitest";
import {
	initialTeamState,
	teamReducer,
	teamTokens,
} from "../../../src/tui/team/state.js";

function base() {
	return initialTeamState({
		robs: [{ name: "planner" }, { name: "worker" }],
		model: "deepseek-flash",
	});
}

describe("teamReducer", () => {
	it("applies a rob_event stream to that rob's transcript", () => {
		let state = teamReducer(base(), {
			type: "team_event",
			event: { kind: "rob_status", rob: "planner", status: "working" },
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "rob_event",
				rob: "planner",
				event: { type: "text_delta", text: "Hel" },
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "rob_event",
				rob: "planner",
				event: { type: "text_delta", text: "lo" },
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "rob_event",
				rob: "planner",
				event: { type: "usage", inputTokens: 10, outputTokens: 4 },
			},
		});

		expect(state.robs[0].robStatus).toBe("working");
		expect(state.robs[0].messages).toEqual([
			{ id: 1, role: "assistant", text: "Hello", reasoning: "", tools: [] },
		]);
		expect(state.robs[0].usage).toEqual({
			input: 10,
			output: 4,
			cacheHit: 0,
			cacheMiss: 0,
		});
		expect(teamTokens(state)).toEqual({ input: 10, output: 4 });
	});

	it("sums token usage across robs for the team total", () => {
		let state = base();
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "rob_event",
				rob: "planner",
				event: { type: "usage", inputTokens: 10, outputTokens: 2 },
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "rob_event",
				rob: "worker",
				event: { type: "usage", inputTokens: 5, outputTokens: 3 },
			},
		});

		expect(teamTokens(state)).toEqual({ input: 15, output: 5 });
	});

	it("moves a rob to waiting_approval on a status event", () => {
		const state = teamReducer(base(), {
			type: "team_event",
			event: {
				kind: "rob_status",
				rob: "worker",
				status: "waiting_approval",
			},
		});

		expect(state.robs[1].robStatus).toBe("waiting_approval");
	});

	it("keeps the approval queue in FIFO order", () => {
		let state = base();
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "approval_requested",
				request: {
					id: "approval-0",
					rob: "planner",
					toolName: "write_file",
					subject: "a.txt",
					dangerous: false,
					rule: "a.txt",
				},
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "approval_requested",
				request: {
					id: "approval-1",
					rob: "worker",
					toolName: "write_file",
					subject: "b.txt",
					dangerous: false,
					rule: "b.txt",
				},
			},
		});

		expect(state.approvals.map((entry) => entry.rob)).toEqual([
			"planner",
			"worker",
		]);

		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "approval_resolved",
				id: "approval-0",
				decision: "allow_once",
			},
		});
		expect(state.approvals.map((entry) => entry.id)).toEqual(["approval-1"]);
	});

	it("records DM and subagent entries for the read-only views", () => {
		let state = base();
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "dm",
				entry: { from: "planner", to: "worker", text: "secret", at: 1 },
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "subagent",
				entry: {
					parent: "planner",
					id: "planner-sub-0",
					at: 2,
					event: { type: "text_delta", text: "child" },
				},
			},
		});

		expect(state.dms).toEqual([
			{ from: "planner", to: "worker", text: "secret", at: 1 },
		]);
		expect(state.subagents).toEqual([
			{
				parent: "planner",
				id: "planner-sub-0",
				at: 2,
				event: { type: "text_delta", text: "child" },
			},
		]);
	});

	it("labels a user message with the rob and marks an interjection", () => {
		let state = teamReducer(base(), {
			type: "user_message",
			rob: "planner",
			text: "hello",
			interjection: false,
		});
		state = teamReducer(state, {
			type: "user_message",
			rob: "worker",
			text: "status?",
			interjection: true,
		});

		expect(state.robs[0].messages).toEqual([
			{ id: 1, role: "user", text: "hello", label: "you → planner: " },
		]);
		expect(state.robs[1].messages).toEqual([
			{
				id: 1,
				role: "user",
				text: "status?",
				label: "you → worker (interjection): ",
			},
		]);
		expect(state.history).toEqual(["hello", "status?"]);
	});

	it("cycles the selection across the wrap boundary", () => {
		let state = teamReducer(base(), { type: "cycle", direction: 1 });
		expect(state.selected).toBe(1);
		state = teamReducer(state, { type: "cycle", direction: 1 });
		expect(state.selected).toBe(0);
		state = teamReducer(state, { type: "cycle", direction: -1 });
		expect(state.selected).toBe(1);
	});

	it("opens and closes a read-only view", () => {
		let state = teamReducer(base(), { type: "view", view: "dms" });
		expect(state.view).toBe("dms");
		state = teamReducer(state, { type: "close_view" });
		expect(state.view).toBe("transcript");
	});
});
