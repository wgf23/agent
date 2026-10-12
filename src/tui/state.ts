import type { AgentEvent } from "../agent/events.js";
import type { PendingPermission } from "./approval.js";
import {
	acceptMenu,
	commandSuggestions,
	MENU_CLOSED,
	MENU_NEUTRAL,
	type MenuState,
	moveMenu,
} from "./suggestions.js";
import { summarizeArgs } from "./summarize.js";

export type TuiStatus = "idle" | "streaming" | "error" | "awaiting_permission";

export interface TuiUsage {
	input: number;
	output: number;
	cacheHit: number;
	cacheMiss: number;
}

export type TuiRole = "user" | "assistant" | "system";

export type ToolStatus = "running" | "ok" | "error" | "blocked";

export interface TuiToolCall {
	id: string;
	name: string;
	args: unknown;
	summary: string;
	status: ToolStatus;
	output: string;
}

export interface TuiUserMessage {
	id: number;
	role: "user";
	text: string;
	label?: string;
}

export interface TuiSystemMessage {
	id: number;
	role: "system";
	text: string;
}

export interface TuiAssistantMessage {
	id: number;
	role: "assistant";
	text: string;
	reasoning: string;
	tools: TuiToolCall[];
}

export type TuiMessage =
	| TuiUserMessage
	| TuiSystemMessage
	| TuiAssistantMessage;

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
	expandTools: boolean;
	expandReasoning: boolean;
	permission: PendingPermission | null;
	menu: MenuState;
}

export interface TuiInit {
	workspaceRoot: string;
	model: string;
}

// The fields an AgentEvent stream writes. Extraction lets the team reducer
// reuse the same event handling per rob without carrying TuiState.
export type TranscriptState = Pick<
	TuiState,
	"messages" | "status" | "usage" | "lastError" | "nextId"
>;

export type TuiAction =
	| { type: "submit"; text: string; at: number }
	| { type: "agent"; event: AgentEvent }
	| { type: "cancel" }
	| { type: "clear" }
	| { type: "set_input"; text: string }
	| { type: "append_system"; text: string }
	| { type: "history_prev" }
	| { type: "history_next" }
	| { type: "toggle_tools" }
	| { type: "toggle_reasoning" }
	| { type: "menu_move"; text: string; delta: 1 | -1 }
	| { type: "menu_accept"; text: string }
	| { type: "menu_close" }
	| { type: "permission"; request: PendingPermission | null };

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
		expandTools: false,
		expandReasoning: false,
		permission: null,
		menu: MENU_NEUTRAL,
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
				menu: MENU_NEUTRAL,
			};
		}

		case "agent":
			return { ...state, ...applyAgentEvent(state, action.event) };

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
			return {
				...state,
				input: action.text,
				historyIndex: null,
				menu: MENU_NEUTRAL,
			};

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

		case "toggle_tools":
			return { ...state, expandTools: !state.expandTools };

		case "toggle_reasoning":
			return { ...state, expandReasoning: !state.expandReasoning };

		case "menu_move":
			return {
				...state,
				menu: moveMenu(
					state.menu,
					commandSuggestions(action.text),
					action.delta,
				),
			};

		case "menu_accept": {
			// Accept reads the live text the component passes, so the line fills
			// from the same matches the keystroke produced even before React has
			// committed that keystroke.
			const accepted = acceptMenu(state.menu, commandSuggestions(action.text));
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

		case "permission": {
			if (action.request === null) {
				if (state.permission === null) return state;
				return {
					...state,
					permission: null,
					status:
						state.status === "awaiting_permission" ? "streaming" : state.status,
				};
			}
			return {
				...state,
				permission: action.request,
				status: "awaiting_permission",
				menu: MENU_CLOSED,
			};
		}
	}
}

function upsertAssistant(
	state: TranscriptState,
	update: (message: TuiAssistantMessage) => TuiAssistantMessage,
): TranscriptState {
	const last = state.messages[state.messages.length - 1];
	if (last !== undefined && last.role === "assistant") {
		return {
			...state,
			messages: [...state.messages.slice(0, -1), update(last)],
		};
	}
	const created = update({
		id: state.nextId,
		role: "assistant",
		text: "",
		reasoning: "",
		tools: [],
	});
	return {
		...state,
		messages: [...state.messages, created],
		nextId: state.nextId + 1,
	};
}

export function applyAgentEvent(
	state: TranscriptState,
	event: AgentEvent,
): TranscriptState {
	switch (event.type) {
		case "text_delta":
			return upsertAssistant(state, (message) => ({
				...message,
				text: message.text + event.text,
			}));
		case "reasoning_delta":
			return upsertAssistant(state, (message) => ({
				...message,
				reasoning: message.reasoning + event.text,
			}));
		case "tool_started":
			return upsertAssistant(state, (message) => ({
				...message,
				tools: [
					...message.tools,
					{
						id: event.id,
						name: event.name,
						args: event.args,
						summary: summarizeArgs(event.name, event.args),
						status: "running",
						output: "",
					},
				],
			}));
		case "tool_finished":
			return upsertAssistant(state, (message) => ({
				...message,
				tools: finishTool(message.tools, event),
			}));
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

function finishTool(
	tools: TuiToolCall[],
	event: Extract<AgentEvent, { type: "tool_finished" }>,
): TuiToolCall[] {
	const index = tools.findIndex((tool) => tool.id === event.id);
	if (index === -1) {
		return [
			...tools,
			{
				id: event.id,
				name: event.name,
				args: undefined,
				summary: "",
				status: event.status,
				output: event.output,
			},
		];
	}
	return tools.map((tool, position) =>
		position === index
			? { ...tool, status: event.status, output: event.output }
			: tool,
	);
}
