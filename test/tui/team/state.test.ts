import { describe, expect, it } from "vitest";
import {
	initialTeamState,
	selectedRob,
	selectedRoom,
	suggestionNames,
	teamEntries,
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

describe("teamReducer rooms", () => {
	function withRoom() {
		return initialTeamState({
			robs: [{ name: "planner" }, { name: "worker" }],
			rooms: [{ name: "ship-it", members: ["planner", "worker"] }],
			model: "deepseek-flash",
		});
	}

	it("applies room events into the room transcript and run state", () => {
		let state = withRoom();
		expect(state.rooms).toEqual([
			{
				name: "ship-it",
				members: ["planner", "worker"],
				transcript: [],
				run: { phase: "idle" },
				lastOutcome: null,
				notes: [],
				nextNoteId: 1,
			},
		]);

		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "room",
				event: {
					kind: "entry",
					room: "ship-it",
					entry: { id: 1, at: 5, kind: "user", text: "who takes it?" },
				},
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "room",
				event: {
					kind: "run",
					room: "ship-it",
					run: {
						phase: "running",
						round: 1,
						rounds: 3,
						current: "planner",
						posted: 0,
						remaining: 10,
						addressed: [],
					},
				},
			},
		});
		state = teamReducer(state, {
			type: "team_event",
			event: {
				kind: "room",
				event: {
					kind: "run_ended",
					room: "ship-it",
					run: {
						phase: "running",
						round: 1,
						rounds: 3,
						current: null,
						posted: 0,
						remaining: 10,
						addressed: [],
					},
					outcome: "settled",
				},
			},
		});

		expect(state.rooms[0].transcript).toEqual([
			{ id: 1, at: 5, kind: "user", text: "who takes it?" },
		]);
		expect(state.rooms[0].run).toEqual({ phase: "idle" });
		expect(state.rooms[0].lastOutcome).toBe("settled");
	});

	it("creates a room from a members event and keeps notes out of the transcript", () => {
		let state = teamReducer(base(), {
			type: "team_event",
			event: {
				kind: "room",
				event: {
					kind: "members",
					room: "ship-it",
					members: ["planner", "worker"],
				},
			},
		});
		expect(state.rooms).toEqual([
			{
				name: "ship-it",
				members: ["planner", "worker"],
				transcript: [],
				run: { phase: "idle" },
				lastOutcome: null,
				notes: [],
				nextNoteId: 1,
			},
		]);

		state = teamReducer(state, {
			type: "room_system",
			room: "ship-it",
			text: 'Room "ship-it" is busy.',
		});
		expect(state.rooms[0].notes).toEqual([
			{ id: 1, role: "system", text: 'Room "ship-it" is busy.' },
		]);
		expect(state.rooms[0].transcript).toEqual([]);
	});

	it("selects rooms in the combined entry list", () => {
		let state = withRoom();
		expect(teamEntries(state)).toEqual([
			{ kind: "rob", name: "planner" },
			{ kind: "rob", name: "worker" },
			{ kind: "room", name: "ship-it" },
		]);
		expect(selectedRoom(state)).toBeUndefined();
		expect(suggestionNames(state)).toEqual(["planner", "worker"]);

		state = teamReducer(state, { type: "select_name", name: "ship-it" });
		expect(state.selected).toBe(2);
		expect(selectedRoom(state)?.name).toBe("ship-it");
		expect(selectedRob(state)).toBeUndefined();
		expect(suggestionNames(state)).toEqual(["planner", "worker"]);

		state = teamReducer(state, { type: "cycle", direction: 1 });
		expect(state.selected).toBe(0);
		state = teamReducer(state, { type: "select", index: 3 });
		expect(state.selected).toBe(0);
	});
});
