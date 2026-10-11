import type { AgentEvent } from "../agent/events.js";

export type TuiStatus = "idle" | "streaming" | "error";

export interface TuiUsage {
	input: number;
	output: number;
	cacheHit: number;
	cacheMiss: number;
}

export type TuiRole = "user" | "assistant" | "system";

export interface TuiMessage {
	id: number;
	role: TuiRole;
	text: string;
}

export interface TuiState {
	messages: TuiMessage[];
	status: TuiStatus;
	usage: TuiUsage;
	runStartedAt: number | null;
	lastError: string | null;
	input: string;
	history: string[];
	historyIndex: number | null;
	nextId: number;
	workspaceRoot: string;
	model: string;
}

export interface TuiInit {
	workspaceRoot: string;
	model: string;
}

export type TuiAction =
	| { type: "submit"; text: string; at: number }
	| { type: "agent"; event: AgentEvent }
	| { type: "cancel" }
	| { type: "clear" }
	| { type: "set_input"; text: string }
	| { type: "append_system"; text: string }
	| { type: "history_prev" }
	| { type: "history_next" };

export const CANCEL_MESSAGE = "[cancelled]";

export function initialTuiState(init: TuiInit): TuiState {
	return {
		messages: [],
		status: "idle",
		usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
		runStartedAt: null,
		lastError: null,
		input: "",
		history: [],
		historyIndex: null,
		nextId: 1,
		workspaceRoot: init.workspaceRoot,
		model: init.model,
	};
}

export function cacheHitRatio(usage: TuiUsage): number | null {
	const total = usage.cacheHit + usage.cacheMiss;
	if (total === 0) return null;
	return usage.cacheHit / total;
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case "submit": {
			const text = action.text;
			if (text.trim() === "") return state;
			return {
				...state,
				messages: [...state.messages, { id: state.nextId, role: "user", text }],
				nextId: state.nextId + 1,
				status: "streaming",
				runStartedAt: action.at,
				lastError: null,
				input: "",
				history: [...state.history, text],
				historyIndex: null,
			};
		}

		case "agent":
			return applyAgentEvent(state, action.event);

		case "cancel": {
			if (state.status !== "streaming") return state;
			return {
				...state,
				status: "idle",
				messages: [
					...state.messages,
					{ id: state.nextId, role: "system", text: CANCEL_MESSAGE },
				],
				nextId: state.nextId + 1,
			};
		}

		case "clear":
			return { ...state, messages: [], lastError: null };

		case "set_input":
			return { ...state, input: action.text, historyIndex: null };

		case "append_system":
			return {
				...state,
				messages: [
					...state.messages,
					{ id: state.nextId, role: "system", text: action.text },
				],
				nextId: state.nextId + 1,
			};

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
			};
		}

		case "history_next": {
			if (state.historyIndex === null) return state;
			if (state.historyIndex >= state.history.length - 1) {
				return { ...state, historyIndex: null, input: "" };
			}
			const index = state.historyIndex + 1;
			return {
				...state,
				historyIndex: index,
				input: state.history[index] ?? "",
			};
		}
	}
}

function applyAgentEvent(state: TuiState, event: AgentEvent): TuiState {
	switch (event.type) {
		case "text_delta": {
			const last = state.messages[state.messages.length - 1];
			if (last !== undefined && last.role === "assistant") {
				return {
					...state,
					messages: [
						...state.messages.slice(0, -1),
						{ ...last, text: last.text + event.text },
					],
				};
			}
			return {
				...state,
				messages: [
					...state.messages,
					{ id: state.nextId, role: "assistant", text: event.text },
				],
				nextId: state.nextId + 1,
			};
		}
		case "usage":
			return {
				...state,
				usage: {
					input: state.usage.input + event.inputTokens,
					output: state.usage.output + event.outputTokens,
					cacheHit: state.usage.cacheHit + (event.cacheHitTokens ?? 0),
					cacheMiss: state.usage.cacheMiss + (event.cacheMissTokens ?? 0),
				},
			};
		case "error":
			return { ...state, status: "error", lastError: event.message };
		case "done":
			return {
				...state,
				status: event.reason === "error" ? "error" : "idle",
			};
		default:
			return state;
	}
}
