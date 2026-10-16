import type {
	AgentEvent,
	AgentJobView,
	AgentStatusView,
	AllowAllState,
	ApprovalRequestInfo,
	BotInfo,
	BotState,
	BotStatus,
	DmInfo,
	InstallPhase,
	MemoryEntryView,
	PresetInfo,
	ProviderView,
	RoomDeliverableInfo,
	RoomEventInfo,
	RoomInfo,
	RoomMessageView,
	RoomRunView,
	SearchResponse,
	ServerEvent,
	SessionSummaryInfo,
	SubagentView,
	ToolCallView,
	TranscriptMessage,
	UsageTotals,
} from "./protocol";
import { WORKSPACE_BOT } from "./protocol";

// A bot's retained sub-agent activity is capped so a long run cannot grow the
// client without bound; the oldest entries drop first.
export const SUBAGENT_FEED_MAX = 200;

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Why a run stopped; mirrors the run_ended arm of the wire event. */
export type RoomOutcome = Extract<
	RoomEventInfo,
	{ kind: "run_ended" }
>["outcome"];

/** One room as the client holds it: the hello summary plus the events applied
 *  since. The transcript comes only from the server; the client never writes
 *  a row. */
export interface ClientRoom {
	name: string;
	members: string[];
	coordinator: string | null;
	transcript: RoomMessageView[];
	run: RoomRunView;
	lastOutcome: RoomOutcome | null;
	deliverable: RoomDeliverableInfo | null;
}

export interface NoticeView {
	bot: string;
	text: string;
}

// The sidebar search's client-only facts. A search is read-only server data,
// so it gets its own small actions rather than riding the SSE channel; the
// null results mean "not searched yet", which is distinct from an empty
// payload that says "nothing found".
export interface SearchState {
	query: string;
	results: SearchResponse | null;
	loading: boolean;
	error: string | null;
}

export interface ClientState {
	workspaceRoot: string;
	model: string;
	// Server view of the LLM provider. null until the first hello arrives.
	provider: ProviderView | null;
	presets: PresetInfo[];
	bots: BotInfo[];
	botStates: Record<string, BotState>;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	// A bot's sessions live in their own maps keyed by bot name, so switching a
	// bot's channel can never clobber the workspace chat's sessions.
	botSessions: Record<string, SessionSummaryInfo[]>;
	botActiveSession: Record<string, string | null>;
	// A bot's memory, replaced wholesale after each read or edit.
	memory: Record<string, MemoryEntryView[]>;
	transcripts: Record<string, TranscriptMessage[]>;
	approvals: ApprovalRequestInfo[];
	allowAll: AllowAllState;
	dms: DmInfo[];
	rooms: Record<string, ClientRoom>;
	notices: NoticeView[];
	// A bot's sub-agent activity, appended per event and capped oldest-first.
	subagents: Record<string, SubagentView[]>;
	connection: ConnectionStatus;
	usage: UsageTotals;
	lastError: string | null;
	settingsOpen: boolean;
	settingsError: string | null;
	// The sidebar's read-only session search; a small client-only slice.
	search: SearchState;
	agents: AgentStatusView[];
	// Latest job per agent id, live or terminal.
	agentJobs: Record<string, AgentJobView>;
	// Bumped by every agent write so the file tree refetches; filesChanged
	// carries the paths named by the event, empty when the agent could not.
	filesVersion: number;
	filesChanged: string[];
}

export type ClientAction =
	| { type: "server"; event: ServerEvent }
	| { type: "room_created"; room: RoomInfo }
	| { type: "connection"; status: ConnectionStatus }
	| { type: "submit"; bot: string; text: string }
	| { type: "approval_removed"; id: string }
	| { type: "settings_presets"; presets: PresetInfo[] }
	| { type: "settings_provider"; provider: ProviderView }
	| { type: "settings_open" }
	| { type: "settings_close" }
	| { type: "settings_error"; error: string | null }
	| { type: "agents_loaded"; agents: AgentStatusView[] }
	| { type: "memory_loaded"; bot: string; entries: MemoryEntryView[] }
	// A search's four transitions: start keeps the prior results, results and
	// failure drop `loading`, and clear resets the slice to its default.
	| { type: "search_started"; query: string }
	| { type: "search_results"; results: SearchResponse }
	| { type: "search_failed"; error: string }
	| { type: "search_cleared" }
	// A request this client made was refused (not an SSE error): the server's
	// reason goes to the same banner so it is never swallowed.
	| { type: "request_error"; error: string };

export function initialState(): ClientState {
	return {
		workspaceRoot: "",
		model: "",
		provider: null,
		presets: [],
		bots: [],
		botStates: {},
		sessions: [],
		activeSessionId: null,
		botSessions: {},
		botActiveSession: {},
		memory: {},
		transcripts: {},
		approvals: [],
		allowAll: { mode: "off", sessionId: null },
		dms: [],
		rooms: {},
		notices: [],
		subagents: {},
		connection: "connecting",
		usage: { input: 0, output: 0 },
		lastError: null,
		settingsOpen: false,
		settingsError: null,
		search: { query: "", results: null, loading: false, error: null },
		agents: [],
		agentJobs: {},
		filesVersion: 0,
		filesChanged: [],
	};
}

export function workspaceBot(bots: readonly BotInfo[]): BotInfo | undefined {
	return bots.find((bot) => bot.kind === "workspace");
}

export function robBots(bots: readonly BotInfo[]): BotInfo[] {
	return bots.filter((bot) => bot.kind === "rob");
}

// Mirrors isLive in src/agents/job.ts: only these phases have a process behind
// them. Kept here because the web bundle cannot import the Node-side module.
export function isLivePhase(phase: InstallPhase): boolean {
	return phase === "queued" || phase === "installing" || phase === "verifying";
}

// A Think block opens while its turn streams and collapses once the turn ends.
// A manual toggle (true = opened, false = closed) overrides that until the next
// streaming state changes it back.
export function reasoningOpen(
	streaming: boolean,
	toggled: boolean | null,
): boolean {
	return toggled ?? streaming;
}

export function clientReducer(
	state: ClientState,
	action: ClientAction,
): ClientState {
	switch (action.type) {
		case "connection":
			return { ...state, connection: action.status };

		case "room_created": {
			// The create response is the server's own snapshot. Seed it so the
			// dialog can open the room right away; a `members` event may have
			// already created it, and that live copy wins.
			if (state.rooms[action.room.name] !== undefined) return state;
			return {
				...state,
				rooms: {
					...state.rooms,
					[action.room.name]: toClientRoom(action.room),
				},
			};
		}

		case "submit": {
			const transcript = transcriptOf(state, action.bot);
			const existing = state.botStates[action.bot];
			// An interjection while the bot is busy or awaiting approval must not
			// clobber that status; only idle/stopped bots flip to "working".
			const status: BotStatus =
				existing !== undefined &&
				(existing.status === "working" ||
					existing.status === "waiting_approval")
					? existing.status
					: "working";
			return {
				...state,
				transcripts: {
					...state.transcripts,
					[action.bot]: appendMessage(transcript, {
						role: "user",
						text: action.text,
						reasoning: "",
						tools: [],
					}),
				},
				botStates: existing
					? { ...state.botStates, [action.bot]: { ...existing, status } }
					: state.botStates,
				lastError: null,
			};
		}

		case "approval_removed":
			return {
				...state,
				approvals: state.approvals.filter((a) => a.id !== action.id),
			};

		case "settings_presets":
			return { ...state, presets: action.presets };

		case "settings_provider":
			return { ...state, provider: action.provider };

		case "settings_open":
			return { ...state, settingsOpen: true, settingsError: null };

		case "settings_close":
			return { ...state, settingsOpen: false, settingsError: null };

		case "settings_error":
			return { ...state, settingsError: action.error };

		case "agents_loaded":
			return { ...state, agents: action.agents };

		case "memory_loaded":
			return {
				...state,
				memory: { ...state.memory, [action.bot]: action.entries },
			};

		// A new search keeps the previous results on screen while it loads and
		// clears any prior error, so the panel never blanks mid-query.
		case "search_started":
			return {
				...state,
				search: {
					...state.search,
					query: action.query,
					loading: true,
					error: null,
				},
			};

		case "search_results":
			return {
				...state,
				search: {
					...state.search,
					results: action.results,
					loading: false,
					error: null,
				},
			};

		// A failure keeps the query so the panel can still show what was asked,
		// but drops `loading` and carries the server's message.
		case "search_failed":
			return {
				...state,
				search: { ...state.search, loading: false, error: action.error },
			};

		case "search_cleared":
			return {
				...state,
				search: { query: "", results: null, loading: false, error: null },
			};

		case "request_error":
			return { ...state, lastError: action.error };

		case "server":
			return applyServerEvent(state, action.event);
	}
}

function applyServerEvent(state: ClientState, event: ServerEvent): ClientState {
	switch (event.type) {
		case "hello": {
			// hello.transcript is the workspace bot's transcript; robs start empty
			// and fill in via agent_event.
			const transcripts: Record<string, TranscriptMessage[]> = {};
			const workspace = workspaceBot(event.bots);
			if (workspace !== undefined) {
				transcripts[workspace.name] = event.transcript;
			}
			return {
				...state,
				workspaceRoot: event.workspaceRoot,
				model: event.model,
				provider: event.provider,
				bots: event.bots,
				botStates: Object.fromEntries(
					event.states.map((s) => [s.bot, s] as const),
				),
				sessions: event.sessions,
				activeSessionId: event.activeSessionId,
				transcripts,
				rooms: roomMap(event.rooms),
				approvals: event.approvals,
				allowAll: event.allowAll,
				usage: { input: 0, output: 0 },
				lastError: null,
				connection: "open",
			};
		}

		case "settings":
			// Broadcast on every successful save so all tabs converge.
			return { ...state, provider: event.provider, settingsError: null };

		case "bots":
			// The roster changed (e.g. a rob was created); keep any live state the
			// server snapshot omits and layer the fresh states on top.
			return {
				...state,
				bots: event.bots,
				botStates: mergeBotStates(state.botStates, event.states),
			};

		case "session_opened":
			// A bot's channel switch replaces only that bot's transcript; the
			// chat keeps its own active id. The workspace chat is the one bot
			// whose active session the top-level `activeSessionId` tracks.
			if (event.bot === WORKSPACE_BOT) {
				return {
					...state,
					activeSessionId: event.sessionId,
					transcripts: {
						...state.transcripts,
						[event.bot]: event.messages,
					},
				};
			}
			return {
				...state,
				botActiveSession: {
					...state.botActiveSession,
					[event.bot]: event.sessionId,
				},
				transcripts: {
					...state.transcripts,
					[event.bot]: event.messages,
				},
			};

		case "sessions":
			return { ...state, sessions: event.sessions };

		// A bot's session list is its own event so it cannot clobber the chat's:
		// it fills the bot-keyed maps only, never `sessions`/`activeSessionId`.
		case "bot_sessions":
			return {
				...state,
				botSessions: { ...state.botSessions, [event.bot]: event.sessions },
				botActiveSession: {
					...state.botActiveSession,
					[event.bot]: event.currentSessionId,
				},
			};

		case "bot_status":
			return {
				...state,
				botStates: { ...state.botStates, [event.state.bot]: event.state },
			};

		case "agent_event": {
			const transcript = applyAgentEvent(
				transcriptOf(state, event.bot),
				event.event,
			);
			let next = setTranscript(state, event.bot, transcript);
			switch (event.event.type) {
				case "usage":
					next = {
						...next,
						usage: {
							input: next.usage.input + event.event.inputTokens,
							output: next.usage.output + event.event.outputTokens,
						},
					};
					break;
				case "done":
					next = setBotStatus(next, event.bot, "idle");
					break;
				case "error":
					next = setBotStatus(next, event.bot, "idle");
					next = setTranscript(
						next,
						event.bot,
						appendMessage(transcript, {
							role: "system",
							text: `⚠ ${event.event.message}`,
							reasoning: "",
							tools: [],
						}),
					);
					break;
				default:
					break;
			}
			return next;
		}

		// A queued request is announced twice: once with no deadline, then again when
		// it becomes the head and the server arms its window. Replacing in place
		// keeps one entry per id and, critically, keeps the FIFO order the modal
		// renders from.
		case "approval_requested": {
			const index = state.approvals.findIndex((a) => a.id === event.request.id);
			if (index === -1) {
				return { ...state, approvals: [...state.approvals, event.request] };
			}
			const approvals = [...state.approvals];
			approvals[index] = event.request;
			return { ...state, approvals };
		}

		case "approval_resolved":
			return {
				...state,
				approvals: state.approvals.filter((a) => a.id !== event.id),
			};

		case "notice":
			return {
				...state,
				notices: [...state.notices, { bot: event.bot, text: event.text }].slice(
					-100,
				),
				transcripts: {
					...state.transcripts,
					[event.bot]: appendMessage(transcriptOf(state, event.bot), {
						role: "system",
						text: event.text,
						reasoning: "",
						tools: [],
					}),
				},
			};

		case "dm":
			return { ...state, dms: [...state.dms, event.entry].slice(-100) };

		// A sub-agent's activity belongs to its parent bot's feed. Only the line
		// with text is rendered; the cap drops the oldest so a long run cannot
		// grow the client without bound.
		case "subagent": {
			const existing = state.subagents[event.bot] ?? [];
			return {
				...state,
				subagents: {
					...state.subagents,
					[event.bot]: [...existing, event.entry].slice(-SUBAGENT_FEED_MAX),
				},
			};
		}

		case "room":
			return applyRoomEvent(state, event.event);

		case "allow_all":
			return { ...state, allowAll: event.allowAll };

		case "agents":
			return { ...state, agents: event.agents };

		case "agent_job":
			return {
				...state,
				agentJobs: { ...state.agentJobs, [event.job.agent]: event.job },
			};

		// An agent write advances the counter the tree watches and records what
		// changed so the tree can pulse those rows. Its own fields, so a
		// files_changed event never disturbs the transcript or the roster.
		case "files_changed":
			return {
				...state,
				filesVersion: state.filesVersion + 1,
				filesChanged: event.paths,
			};

		case "error": {
			let next = state;
			if (event.bot !== undefined) {
				next = setTranscript(
					next,
					event.bot,
					appendMessage(transcriptOf(next, event.bot), {
						role: "system",
						text: `⚠ ${event.message}`,
						reasoning: "",
						tools: [],
					}),
				);
			}
			return { ...next, lastError: event.message };
		}
	}
}

export function applyRoomEvent(
	state: ClientState,
	event: RoomEventInfo,
): ClientState {
	switch (event.kind) {
		case "members":
			return updateRoom(state, event.room, (room) => ({
				...room,
				members: event.members,
			}));

		case "entry":
			return updateRoom(state, event.room, (room) => ({
				...room,
				transcript: [...room.transcript, event.entry].slice(
					-ROOM_TRANSCRIPT_CAP,
				),
			}));

		case "run":
			return updateRoom(state, event.room, (room) => ({
				...room,
				run: event.run,
			}));

		case "run_ended":
			return updateRoom(state, event.room, (room) => ({
				...room,
				run: { phase: "idle" },
				lastOutcome: event.outcome,
			}));

		case "turn":
			// Like the TUI: the run snapshot already names the current speaker,
			// so a single member's turn outcome adds no state.
			return state;
	}
}

// Mirrors src/tui/state.ts applyAgentEvent: streaming deltas accumulate onto
// the trailing assistant message, tool events mutate its tool cards, and the
// transcript-only events (usage / done / error) are handled by the caller.
export function applyAgentEvent(
	transcript: TranscriptMessage[],
	event: AgentEvent,
): TranscriptMessage[] {
	switch (event.type) {
		case "text_delta":
			return upsertAssistant(transcript, (m) => ({
				...m,
				text: m.text + event.text,
			}));
		case "reasoning_delta":
			return upsertAssistant(transcript, (m) => ({
				...m,
				reasoning: m.reasoning + event.text,
			}));
		case "tool_started":
			return upsertAssistant(transcript, (m) => ({
				...m,
				tools: [
					...m.tools,
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
			return upsertAssistant(transcript, (m) => ({
				...m,
				tools: finishTool(m.tools, event),
			}));
		case "compacted":
			return appendMessage(transcript, {
				role: "system",
				text: `compacted ${event.removedMessages} messages`,
				reasoning: "",
				tools: [],
			});
		default:
			return transcript;
	}
}

function upsertAssistant(
	transcript: TranscriptMessage[],
	update: (m: TranscriptMessage) => TranscriptMessage,
): TranscriptMessage[] {
	const last = transcript[transcript.length - 1];
	if (last !== undefined && last.role === "assistant") {
		return [...transcript.slice(0, -1), update(last)];
	}
	const created = update({
		id: nextId(transcript),
		role: "assistant",
		text: "",
		reasoning: "",
		tools: [],
	});
	return [...transcript, created];
}

function finishTool(
	tools: ToolCallView[],
	event: Extract<AgentEvent, { type: "tool_finished" }>,
): ToolCallView[] {
	const index = tools.findIndex((tool) => tool.id === event.id);
	if (index === -1) {
		return [
			...tools,
			{
				id: event.id,
				name: event.name,
				args: undefined,
				summary: event.summary,
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

function transcriptOf(state: ClientState, bot: string): TranscriptMessage[] {
	return state.transcripts[bot] ?? [];
}

function setTranscript(
	state: ClientState,
	bot: string,
	messages: TranscriptMessage[],
): ClientState {
	return { ...state, transcripts: { ...state.transcripts, [bot]: messages } };
}

// The same cap the DM feed uses; the server windows hello.rooms this way too.
const ROOM_TRANSCRIPT_CAP = 100;

function toClientRoom(room: RoomInfo): ClientRoom {
	return {
		name: room.name,
		members: room.members,
		coordinator: room.coordinator,
		transcript: room.transcript.slice(-ROOM_TRANSCRIPT_CAP),
		run: room.run,
		lastOutcome: null,
		deliverable: room.deliverable,
	};
}

function roomMap(rooms: RoomInfo[]): Record<string, ClientRoom> {
	const map: Record<string, ClientRoom> = {};
	for (const room of rooms) map[room.name] = toClientRoom(room);
	return map;
}

/** An event can name a room hello never sent, one created in another tab, so
 *  create it on the spot instead of dropping its entries. */
function updateRoom(
	state: ClientState,
	name: string,
	update: (room: ClientRoom) => ClientRoom,
): ClientState {
	const existing = state.rooms[name] ?? {
		name,
		members: [],
		coordinator: null,
		transcript: [],
		run: { phase: "idle" as const },
		lastOutcome: null,
		deliverable: null,
	};
	return {
		...state,
		rooms: { ...state.rooms, [name]: update(existing) },
	};
}

function mergeBotStates(
	current: Record<string, BotState>,
	incoming: BotState[],
): Record<string, BotState> {
	const merged = { ...current };
	for (const state of incoming) {
		merged[state.bot] = state;
	}
	return merged;
}

function setBotStatus(
	state: ClientState,
	bot: string,
	status: BotStatus,
): ClientState {
	const existing = state.botStates[bot];
	return {
		...state,
		botStates: {
			...state.botStates,
			[bot]: existing
				? { ...existing, status }
				: {
						bot,
						status,
						messageCount: 0,
						pending: 0,
						lastMessage: null,
						usage: { input: 0, output: 0 },
					},
		},
	};
}

function appendMessage(
	transcript: TranscriptMessage[],
	message: Omit<TranscriptMessage, "id">,
): TranscriptMessage[] {
	return [...transcript, { ...message, id: nextId(transcript) }];
}

// Server transcripts use sequential ids, but compaction can shift them; derive
// the next id from the max already present so optimistic appends stay unique.
function nextId(transcript: TranscriptMessage[]): number {
	let max = 0;
	for (const message of transcript) {
		if (message.id > max) max = message.id;
	}
	return max + 1;
}

const BASH_COMMAND_MAX_CHARS = 80;
const UNKNOWN_JSON_MAX_CHARS = 60;

// Local copy of src/tui/summarize.ts so the web build has no dependency on the
// Node-side module graph.
function summarizeArgs(name: string, args: unknown): string {
	switch (name) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return argString(args, "path") ?? "";
		case "bash": {
			const command = argString(args, "command") ?? "";
			return command.slice(0, BASH_COMMAND_MAX_CHARS);
		}
		case "glob":
			return argString(args, "pattern") ?? "";
		case "grep": {
			const pattern = argString(args, "pattern") ?? "";
			const path = argString(args, "path");
			return path === undefined || path === ""
				? pattern
				: `${pattern} in ${path}`;
		}
		case "web_fetch":
			return argString(args, "url") ?? "";
		case "web_search":
			return argString(args, "query") ?? "";
		case "task":
			return argString(args, "task") ?? "";
		default:
			return JSON.stringify(args ?? {}).slice(0, UNKNOWN_JSON_MAX_CHARS);
	}
}

function argString(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
