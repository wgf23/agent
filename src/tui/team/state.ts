import type { ApprovalRequest } from "../../rob/approvals.js";
import type { TeamEvent } from "../../rob/events.js";
import type { DmEntry, RobStatus, SubagentEntry } from "../../rob/types.js";
import {
	applyAgentEvent,
	type TranscriptState,
	type TuiMessage,
} from "../state.js";
import {
	MENU_CLOSED,
	MENU_NEUTRAL,
	type MenuState,
	moveMenu,
	robSuggestions,
} from "../suggestions.js";

export type TeamView = "transcript" | "dms" | "subagents";

export interface TeamRobState extends TranscriptState {
	name: string;
	robStatus: RobStatus;
}

export interface TeamState {
	robs: TeamRobState[];
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
	model: string;
}

export type TeamAction =
	| { type: "team_event"; event: TeamEvent }
	| { type: "set_input"; text: string }
	| { type: "user_message"; rob: string; text: string; interjection: boolean }
	| { type: "system"; rob: string; text: string }
	| { type: "select"; index: number }
	| { type: "cycle"; direction: 1 | -1 }
	| { type: "view"; view: TeamView }
	| { type: "close_view" }
	| { type: "toggle_tools" }
	| { type: "toggle_reasoning" }
	| { type: "history_prev" }
	| { type: "history_next" }
	| { type: "menu_move"; delta: 1 | -1 }
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
	return state.robs[state.selected];
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

		case "select":
			if (action.index < 0 || action.index >= state.robs.length) return state;
			return { ...state, selected: action.index };

		case "cycle": {
			if (state.robs.length === 0) return state;
			const count = state.robs.length;
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
					robSuggestions(state.input, robNames(state)),
					action.delta,
				),
			};

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

function robNames(state: TeamState): string[] {
	return state.robs.map((rob) => rob.name);
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
	}
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
