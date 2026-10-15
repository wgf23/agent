import type { ApprovalRequest } from "../../rob/approvals.js";
import type { TeamEvent } from "../../rob/events.js";
import type {
	RoomEntry,
	RoomEvent,
	RoomRun,
	RunOutcome,
} from "../../rob/room.js";
import type { DmEntry, RobStatus, SubagentEntry } from "../../rob/types.js";
import {
	applyAgentEvent,
	type TranscriptState,
	type TuiMessage,
	type TuiSystemMessage,
} from "../state.js";
import {
	acceptMenu,
	MENU_CLOSED,
	MENU_NEUTRAL,
	type MenuState,
	moveMenu,
	teamSuggestions,
} from "../suggestions.js";

export type TeamView = "transcript" | "dms" | "subagents";

export interface TeamRobState extends TranscriptState {
	name: string;
	robStatus: RobStatus;
}

/** A room as the surface holds it: the events it applied plus surface-local
 *  command output. `notes` never goes back to the room; the room is the only
 *  writer of `transcript`. */
export interface TeamRoomState {
	name: string;
	members: string[];
	transcript: RoomEntry[];
	run: RoomRun;
	lastOutcome: RunOutcome | null;
	notes: TuiSystemMessage[];
	nextNoteId: number;
}

export interface TeamEntry {
	readonly kind: "rob" | "room";
	readonly name: string;
}

export interface TeamState {
	robs: TeamRobState[];
	rooms: TeamRoomState[];
	selected: number;
	view: TeamView;
	approvals: ApprovalRequest[];
	input: string;
	history: string[];
	historyIndex: number | null;
	dms: DmEntry[];
	subagents: SubagentEntry[];
	expandTools: boolean;
	expandReasoning: boolean;
	model: string;
	menu: MenuState;
}

export interface TeamInit {
	robs: readonly { name: string }[];
	rooms?: readonly { name: string; members: readonly string[] }[];
	model: string;
}

export type TeamAction =
	| { type: "team_event"; event: TeamEvent }
	| { type: "set_input"; text: string }
	| { type: "user_message"; rob: string; text: string; interjection: boolean }
	| { type: "system"; rob: string; text: string }
	| { type: "room_system"; room: string; text: string }
	| { type: "select"; index: number }
	| { type: "select_name"; name: string }
	| { type: "cycle"; direction: 1 | -1 }
	| { type: "view"; view: TeamView }
	| { type: "close_view" }
	| { type: "toggle_tools" }
	| { type: "toggle_reasoning" }
	| { type: "history_prev" }
	| { type: "history_next" }
	| { type: "menu_move"; text: string; delta: 1 | -1 }
	| { type: "menu_accept"; text: string }
	| { type: "menu_close" };

export function initialTeamState(init: TeamInit): TeamState {
	return {
		robs: init.robs.map((rob) => ({
			name: rob.name,
			robStatus: "idle",
			messages: [],
			status: "idle",
			usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
			lastError: null,
			nextId: 1,
		})),
		rooms: (init.rooms ?? []).map((room) => ({
			...emptyRoom(room.name),
			members: [...room.members],
		})),
		selected: 0,
		view: "transcript",
		approvals: [],
		input: "",
		history: [],
		historyIndex: null,
		dms: [],
		subagents: [],
		expandTools: false,
		expandReasoning: false,
		model: init.model,
		menu: MENU_NEUTRAL,
	};
}

export function selectedRob(state: TeamState): TeamRobState | undefined {
	if (state.selected >= state.robs.length) return undefined;
	return state.robs[state.selected];
}

export function selectedRoom(state: TeamState): TeamRoomState | undefined {
	const index = state.selected - state.robs.length;
	if (index < 0) return undefined;
	return state.rooms[index];
}

/** The one place the selection order lives: robs first, then rooms. */
export function teamEntries(state: TeamState): readonly TeamEntry[] {
	return [
		...state.robs.map((rob) => ({ kind: "rob" as const, name: rob.name })),
		...state.rooms.map((room) => ({ kind: "room" as const, name: room.name })),
	];
}

/** The @ suggestions follow the selection: a room suggests its members. */
export function suggestionNames(state: TeamState): string[] {
	const room = selectedRoom(state);
	if (room !== undefined) return [...room.members];
	return state.robs.map((rob) => rob.name);
}

export function teamTokens(state: TeamState): {
	input: number;
	output: number;
} {
	let input = 0;
	let output = 0;
	for (const rob of state.robs) {
		input += rob.usage.input;
		output += rob.usage.output;
	}
	return { input, output };
}

export function teamReducer(state: TeamState, action: TeamAction): TeamState {
	switch (action.type) {
		case "team_event":
			return applyTeamEvent(state, action.event);

		case "set_input":
			return {
				...state,
				input: action.text,
				historyIndex: null,
				menu: MENU_NEUTRAL,
			};

		case "user_message": {
			const label = action.interjection
				? `you → ${action.rob} (interjection): `
				: `you → ${action.rob}: `;
			return {
				...updateRob(state, action.rob, (rob) =>
					appendMessage(rob, { role: "user", text: action.text, label }),
				),
				input: "",
				history: [...state.history, action.text],
				historyIndex: null,
				menu: MENU_CLOSED,
			};
		}

		case "system":
			return updateRob(state, action.rob, (rob) =>
				appendMessage(rob, { role: "system", text: action.text }),
			);

		case "room_system":
			return updateRoom(state, action.room, (room) => ({
				...room,
				notes: appendNote(room, action.text),
				nextNoteId: room.nextNoteId + 1,
			}));

		case "select": {
			const count = state.robs.length + state.rooms.length;
			if (action.index < 0 || action.index >= count) return state;
			return { ...state, selected: action.index };
		}

		case "select_name": {
			const index = teamEntries(state).findIndex(
				(entry) => entry.name === action.name,
			);
			if (index === -1) return state;
			return { ...state, selected: index };
		}

		case "cycle": {
			const count = state.robs.length + state.rooms.length;
			if (count === 0) return state;
			return {
				...state,
				selected: (state.selected + action.direction + count) % count,
			};
		}

		case "view":
			return { ...state, view: action.view };

		case "close_view":
			return { ...state, view: "transcript" };

		case "toggle_tools":
			return { ...state, expandTools: !state.expandTools };

		case "toggle_reasoning":
			return { ...state, expandReasoning: !state.expandReasoning };

		case "menu_move":
			return {
				...state,
				menu: moveMenu(
					state.menu,
					teamSuggestions(action.text, suggestionNames(state)),
					action.delta,
				),
			};

		case "menu_accept": {
			const accepted = acceptMenu(
				action.text,
				state.menu,
				teamSuggestions(action.text, suggestionNames(state)),
			);
			if (accepted === null) return state;
			return {
				...state,
				input: accepted,
				historyIndex: null,
				menu: MENU_NEUTRAL,
			};
		}

		case "menu_close":
			return { ...state, menu: MENU_CLOSED };

		case "history_prev": {
			if (state.history.length === 0) return state;
			const index =
				state.historyIndex === null
					? state.history.length - 1
					: Math.max(0, state.historyIndex - 1);
			return {
				...state,
				historyIndex: index,
				input: state.history[index] ?? state.input,
				menu: MENU_CLOSED,
			};
		}

		case "history_next": {
			if (state.historyIndex === null) return state;
			if (state.historyIndex >= state.history.length - 1) {
				return { ...state, historyIndex: null, input: "", menu: MENU_CLOSED };
			}
			const index = state.historyIndex + 1;
			return {
				...state,
				historyIndex: index,
				input: state.history[index] ?? "",
				menu: MENU_CLOSED,
			};
		}
	}
}

function applyTeamEvent(state: TeamState, event: TeamEvent): TeamState {
	switch (event.kind) {
		case "rob_event":
			return updateRob(state, event.rob, (rob) => ({
				...rob,
				...applyAgentEvent(rob, event.event),
			}));
		case "rob_status":
			return updateRob(state, event.rob, (rob) => ({
				...rob,
				robStatus: event.status,
			}));
		case "notice":
			return updateRob(state, event.rob, (rob) =>
				appendMessage(rob, { role: "system", text: event.text }),
			);
		case "dm":
			return { ...state, dms: [...state.dms, { ...event.entry }] };
		case "subagent":
			return {
				...state,
				subagents: [...state.subagents, structuredClone(event.entry)],
			};
		case "approval_requested":
			if (state.approvals.some((item) => item.id === event.request.id)) {
				return state;
			}
			return {
				...state,
				approvals: [...state.approvals, { ...event.request }],
			};
		case "approval_resolved":
			return {
				...state,
				approvals: state.approvals.filter((item) => item.id !== event.id),
			};
		case "room":
			return applyRoomEvent(state, event.event);
	}
}

function applyRoomEvent(state: TeamState, event: RoomEvent): TeamState {
	switch (event.kind) {
		case "members":
			return updateRoom(state, event.room, (room) => ({
				...room,
				members: [...event.members],
			}));
		case "entry":
			return updateRoom(state, event.room, (room) => ({
				...room,
				transcript: [...room.transcript, { ...event.entry }],
			}));
		case "run":
			return updateRoom(state, event.room, (room) => ({
				...room,
				run: { ...event.run },
			}));
		case "run_ended":
			return updateRoom(state, event.room, (room) => ({
				...room,
				run: { phase: "idle" },
				lastOutcome: event.outcome,
			}));
		case "turn":
			// A turn only annotates the round that just closed, and the run
			// snapshot already names the current speaker, so there is no state.
			return state;
	}
}

function emptyRoom(name: string): TeamRoomState {
	return {
		name,
		members: [],
		transcript: [],
		run: { phase: "idle" },
		lastOutcome: null,
		notes: [],
		nextNoteId: 1,
	};
}

/** Room events can arrive before a create returns; an unknown room is created
 *  on the spot so an event is never dropped. */
function updateRoom(
	state: TeamState,
	name: string,
	update: (room: TeamRoomState) => TeamRoomState,
): TeamState {
	const index = state.rooms.findIndex((room) => room.name === name);
	if (index === -1) {
		return { ...state, rooms: [...state.rooms, update(emptyRoom(name))] };
	}
	const rooms = state.rooms.slice();
	rooms[index] = update(rooms[index]);
	return { ...state, rooms };
}

function appendNote(room: TeamRoomState, text: string): TuiSystemMessage[] {
	return [...room.notes, { id: room.nextNoteId, role: "system", text }];
}

function updateRob(
	state: TeamState,
	name: string,
	update: (rob: TeamRobState) => TeamRobState,
): TeamState {
	const index = state.robs.findIndex((rob) => rob.name === name);
	if (index === -1) return state;
	const robs = state.robs.slice();
	robs[index] = update(robs[index]);
	return { ...state, robs };
}

function appendMessage(
	rob: TeamRobState,
	message:
		| { role: "user"; text: string; label: string }
		| { role: "system"; text: string },
): TeamRobState {
	const created: TuiMessage =
		message.role === "user"
			? {
					id: rob.nextId,
					role: "user",
					text: message.text,
					label: message.label,
				}
			: { id: rob.nextId, role: "system", text: message.text };
	return {
		...rob,
		messages: [...rob.messages, created],
		nextId: rob.nextId + 1,
	};
}
