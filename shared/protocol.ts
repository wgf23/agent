// Wire types shared by the my-agent server (src/serve) and the web client
// (web/). This file has no runtime imports: its only import is the erased
// type-only `RobCommand` from ./agents.js, so tsc and Vite both read it
// directly. AgentEvent mirrors src/agent/events.ts.

import type { AgentId, RobCommand } from "./agents.js";

export const DEFAULT_PORT = 4317;

export type AgentEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_started"; id: string; name: string; args: unknown }
	| {
			type: "tool_finished";
			id: string;
			name: string;
			ok: boolean;
			status: "ok" | "error" | "blocked";
			summary: string;
			output: string;
	  }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cacheHitTokens?: number;
			cacheMissTokens?: number;
			reasoningTokens?: number;
	  }
	| { type: "compacted"; removedMessages: number; summaryChars: number }
	| { type: "error"; message: string }
	| {
			type: "done";
			reason: "finished" | "max_steps" | "aborted" | "error" | "budget";
			steps: number;
	  };

export type BotKind = "workspace" | "rob";
export type BotStatus = "idle" | "working" | "waiting_approval" | "stopped";
export type BackendKind = "native" | "cli";
export type ApprovalChoice = "allow_once" | "allow_always" | "deny";

export const WORKSPACE_BOT = "assistant";

// The configured interval that wakes a bot; the schedule is config-owned, so
// this rides on BotInfo rather than the ledger.
export interface BotWake {
	everyMs: number;
	prompt: string;
}

export interface BotInfo {
	name: string;
	kind: BotKind;
	role: string;
	model: string;
	backend: BackendKind;
	// The cli backend's command, provider, and model, when it has one, so the
	// edit panel can prefill its fields and round-trip them. The command is a
	// plain string on the wire; the server validated it against the catalog.
	command?: string;
	provider?: string;
	backendModel?: string;
	// The configured interval that wakes the bot; absent when it has none.
	wake?: BotWake | null;
	// The bot's scope, echoed back so the edit panel can prefill it. Absent
	// means the config never set it, which the panel shows as the default;
	// it is not the same as an empty list.
	skills?: string[];
	skillsConfigured?: boolean;
	mcp?: string[];
}

export type BotBackendDraft =
	| { kind: "native" }
	| {
			kind: "cli";
			command: RobCommand;
			provider?: string;
			model?: string;
	  };

export interface BotDraft {
	name: string;
	role: string;
	model?: string;
	backend?: BotBackendDraft;
	// The bot's skill whitelist and its confirmation flag. They travel
	// together-or-absent: the write layer is what reconciles them, so this
	// type only has to carry what the panel sent.
	skills?: string[];
	skillsConfigured?: boolean;
	// The MCP servers this bot may use. Absent means none, unlike skills
	// (design §10 U6).
	mcp?: string[];
}

// One installed skill, as the panel needs it. Deliberately no `dir`: the
// local absolute path never crosses to the client, and the panel has no use
// for it.
export interface SkillInfo {
	name: string;
	description: string;
	packageName: string;
	version: string;
}

// One configured MCP server, as the panel needs it. Two things are deliberately
// absent. `env` never appears, not even its values: the keys alone let the panel
// say a server needs secrets without learning them. The arguments appear only as
// a count, because they are a place a token can be written in full
// (--token=ghp_…), and the route is not restricted to the loopback interface.
// The command is projected to the executable alone for the same reason.
export interface McpServerInfo {
	name: string;
	command: string;
	argsCount: number;
	envKeys: string[];
}

export type ProviderPresetName = "deepseek" | "openai";

// Everything the browser may know about the provider. Deliberately has no key
// field: the key never crosses back to the client.
export interface ProviderView {
	configured: boolean;
	preset: ProviderPresetName;
	model: string;
	baseURL: string;
	apiKeyEnv: string;
	apiKeySource: "env" | "credentials" | null;
}

export interface PresetInfo {
	name: ProviderPresetName;
	baseURL: string;
	apiKeyEnv: string;
	defaultModel: string;
}

export interface SaveProviderBody {
	preset: ProviderPresetName;
	model: string;
	baseURL?: string;
	apiKeyEnv?: string;
	// Omit to keep the current key. Empty string is rejected.
	apiKey?: string;
	// false saves without verifying the key (the dialog's "save anyway").
	verify?: boolean;
}

export interface SettingsResponse {
	provider: ProviderView;
	presets: PresetInfo[];
}

export type SaveProviderResponse =
	| { ok: true; provider: ProviderView; warning?: string }
	| { ok: false; error: string };

// The install lifecycle, declared once: src/agents/job.ts imports this so the
// wire and the domain can never disagree about the phase names.
export type InstallPhase =
	| "queued"
	| "installing"
	| "verifying"
	| "installed"
	| "unverified"
	| "failed"
	| "cancelled";

// The wire view of an InstallJob: the domain job without its timestamps.
export interface AgentJobView {
	id: string;
	agent: AgentId;
	phase: InstallPhase;
	detail: string;
	error: string | null;
}

// One catalog row folded together with its detected presence and live job.
export interface AgentStatusView {
	id: AgentId;
	label: string;
	command: string;
	npmPackage: string;
	installed: boolean;
	onPath: boolean;
	path: string | null;
	version: string | null;
	error: string | null;
	robBackend: boolean;
	needsProviderAndModel: boolean;
	robBlockedReason: string;
	testedVersion: string;
	job: AgentJobView | null;
}

export interface AgentListResponse {
	agents: AgentStatusView[];
}

export interface InstallAgentBody {
	id: string;
	confirm: boolean;
}

export interface CancelAgentBody {
	id: string;
}

export type InstallAgentStartResponse = {
	ok: true;
	job: AgentJobView;
	alreadyRunning: boolean;
};

export interface UsageTotals {
	input: number;
	output: number;
}

export interface BotState {
	bot: string;
	status: BotStatus;
	messageCount: number;
	pending: number;
	lastMessage: string | null;
	usage: UsageTotals;
}

// One attachment on a message: the same part the provider expands into an
// OpenAI image_url data URL, declared here so the wire has no runtime import
// of the provider module.
export interface ImagePart {
	type: "image";
	mediaType: string;
	data: string;
}

export interface ApprovalRequestInfo {
	id: string;
	bot: string;
	toolName: string;
	subject: string;
	dangerous: boolean;
	rule: string | null;
	// When the server denies this request unanswered, in epoch milliseconds,
	// or null when nothing is armed. A request still queued behind another one
	// has no deadline yet: its window starts when it is promoted to the head,
	// and the server re-emits it with the deadline then.
	expiresAt: number | null;
}

export interface SessionSummaryInfo {
	id: string;
	updatedAt: number;
	messageCount: number;
	firstUserText: string;
	// An owner-set label; null until the session is renamed.
	title: string | null;
}

export interface DmInfo {
	from: string;
	to: string;
	text: string;
	at: number;
}

// One message that carries the query: its role, a bounded snippet with the
// match intact, and the time it belongs to.
export interface SearchHit {
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	at: number;
}

// Every hit for one conversation, with the same summary fields the sidebar
// lists, so a search result can be opened like any other session. A room's
// conversation carries its name as both the id and the title.
export interface SessionMatch {
	sessionId: string;
	title: string | null;
	firstUserText: string;
	hits: SearchHit[];
}

// One room's matches, present only when the room has at least one.
export interface RoomMatches {
	room: string;
	matches: SessionMatch[];
}

// The whole answer to one read-only search: the query echoed back, the chat's
// matches, and each room's matches.
export interface SearchResponse {
	query: string;
	chat: SessionMatch[];
	rooms: RoomMatches[];
}

// One sub-agent event, mirrored from src/rob/types.ts's SubagentEntry so the
// web feed can render the same lines the TUI's SubagentView does.
export interface SubagentView {
	parent: string;
	id: string;
	at: number;
	event: AgentEvent;
}

// One entry in a directory listing. `path` is relative to the workspace root
// in posix form; a directory reports size 0 and a symlink reports its own link
// stats rather than its target's.
export interface FileEntry {
	name: string;
	path: string;
	kind: "file" | "dir" | "symlink";
	size: number;
	mtime: number;
}

// The whole answer to one directory read: the requested path (relative, posix;
// "" is the root), the entries the flags keep, the ones a filter held back so
// the UI can reveal them without a second request, and whether `limit` clipped
// the visible list.
export interface FileListResponse {
	path: string;
	entries: FileEntry[];
	ignored: FileEntry[];
	truncated: boolean;
}

// One subdirectory in a filesystem browse listing. `path` is absolute so the
// browser can enter it directly; `name` is the basename shown in the list.
export interface FsDirEntry {
	name: string;
	path: string;
}

// The answer to one browse read: the absolute path that was read, its
// containing directory when that is still inside a browse root (null at a root
// with no allowed parent), and the subdirectories, sorted by name.
export interface FsDirsResponse {
	path: string;
	parent: string | null;
	dirs: FsDirEntry[];
}

// A preview of an OOXML office document, extracted server-side from the zip
// container. The union is the domain: a spreadsheet is a grid, a document is a
// block sequence, and a deck is a list of slides. Only text and grid cells
// cross the boundary, so untrusted markup can never reach the DOM as HTML.
export interface SheetPreview {
	kind: "sheet";
	sheets: Array<{ name: string; rows: string[][] }>;
	// True when a sheet, row, or column cap clipped the extraction.
	truncated: boolean;
}

// One block of a document: a heading, a list item, or a paragraph. The client
// maps `style` to an element; `text` is plain, already entity-decoded.
export interface DocBlock {
	style: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "p";
	text: string;
}

export interface DocPreview {
	kind: "doc";
	blocks: DocBlock[];
	truncated: boolean;
}

export interface SlidePreview {
	kind: "slides";
	slides: Array<{ title: string; lines: string[] }>;
	truncated: boolean;
}

export type OfficePreview = SheetPreview | DocPreview | SlidePreview;

// The answer to one office preview read: the requested workspace-relative path
// and its extracted preview.
export interface FilePreviewResponse {
	path: string;
	preview: OfficePreview;
}

// Room wire types mirror src/rob/room.ts: the server maps domain events at the
// hub boundary, exactly as AgentEvent is mapped, and the client only renders.

export type RoomMessageView =
	| { id: number; at: number; kind: "user"; text: string }
	| { id: number; at: number; kind: "member"; from: string; text: string }
	| { id: number; at: number; kind: "system"; text: string };

export type RoomRunView =
	| { phase: "idle" }
	| {
			phase: "running";
			round: number;
			rounds: number;
			current: string | null;
			posted: number;
			remaining: number;
			addressed: string[];
	  };

export interface RoomDeliverableInfo {
	at: number;
	path: string;
	coordinator: string;
}

export interface RoomInfo {
	name: string;
	members: string[];
	coordinator: string | null;
	transcript: RoomMessageView[];
	run: RoomRunView;
	pending: number;
	deliverable: RoomDeliverableInfo | null;
	limits: {
		minMembers: number;
		maxMembers: number;
		maxRounds: number;
		maxMessagesPerRun: number;
		maxQueuedSends: number;
	};
}

export type RoomEventInfo =
	| { kind: "entry"; room: string; entry: RoomMessageView }
	| { kind: "run"; room: string; run: RoomRunView }
	| {
			kind: "run_ended";
			room: string;
			run: RoomRunView;
			outcome:
				| "settled"
				| "max_rounds"
				| "message_cap"
				| "run_timeout"
				| "interrupted"
				| "stopped"
				| "error";
	  }
	| {
			kind: "turn";
			room: string;
			member: string;
			round: number;
			state: "replied" | "passed" | "timed_out" | "failed";
	  }
	| { kind: "members"; room: string; members: string[] };

export interface CreateRoomBody {
	name: string;
	members: string[];
	coordinator?: string;
}

export interface RoomSendBody {
	room: string;
	text: string;
}

export interface RoomInterruptBody {
	room: string;
}

export type ToolStatus = "running" | "ok" | "error" | "blocked";

export interface ToolCallView {
	id: string;
	name: string;
	args: unknown;
	summary: string;
	status: ToolStatus;
	output: string;
}

export interface TranscriptMessage {
	id: number;
	role: "user" | "assistant" | "system";
	text: string;
	reasoning: string;
	tools: ToolCallView[];
}

// The memory view omits supersedes/source: the browser edits entries by id and
// never needs the ledger's provenance fields.
export interface MemoryEntryView {
	id: string;
	at: number;
	kind: "fact" | "preference" | "commitment" | "digest";
	text: string;
}

export interface MemoryListResponse {
	bot: string;
	entries: MemoryEntryView[];
}

// One read answers both questions the sidebar asks when a bot is selected: the
// current transcript and the bot's own session list, so no second request is
// needed (the list is the same projection `bot_sessions` carries).
export interface BotTranscriptResponse {
	bot: string;
	sessionId: string;
	messages: TranscriptMessage[];
	sessions: SessionSummaryInfo[];
}

// The assembled-context readout for one bot. `l0` is the ceiling left for the
// system prompt and memory; `l1`..`l4` are the token costs of the message
// layers the budget actually admitted. `included` is their sum. `dropped` names
// the layers the budget had to cut. Read-only: the route recomputes the whole
// view from the ledger and never calls the provider.
export interface BotContextLayers {
	l0: number;
	l1: number;
	l2: number;
	l3: number;
	l4: number;
	included: number;
}

export interface BotContextDrop {
	layer: string;
	reason: string;
}

export interface BotContextResponse {
	layers: BotContextLayers;
	dropped: BotContextDrop[];
	summary: string;
}

export type ServerEvent =
	| {
			type: "hello";
			workspaceRoot: string;
			model: string;
			provider: ProviderView;
			bots: BotInfo[];
			states: BotState[];
			rooms: RoomInfo[];
			sessions: SessionSummaryInfo[];
			activeSessionId: string | null;
			transcript: TranscriptMessage[];
			approvals: ApprovalRequestInfo[];
			allowAll: AllowAllState;
	  }
	| { type: "bots"; bots: BotInfo[]; states: BotState[] }
	| { type: "settings"; provider: ProviderView }
	| {
			type: "session_opened";
			bot: string;
			sessionId: string;
			messages: TranscriptMessage[];
	  }
	| { type: "sessions"; sessions: SessionSummaryInfo[] }
	| {
			type: "bot_sessions";
			bot: string;
			sessions: SessionSummaryInfo[];
			currentSessionId: string | null;
	  }
	| { type: "bot_status"; state: BotState }
	| { type: "agent_event"; bot: string; event: AgentEvent }
	| { type: "subagent"; bot: string; entry: SubagentView }
	| { type: "approval_requested"; request: ApprovalRequestInfo }
	| { type: "approval_resolved"; id: string; decision: ApprovalChoice }
	| { type: "notice"; bot: string; text: string }
	| { type: "dm"; entry: DmInfo }
	| { type: "room"; event: RoomEventInfo }
	| { type: "allow_all"; allowAll: AllowAllState }
	| { type: "agents"; agents: AgentStatusView[] }
	| { type: "agent_job"; job: AgentJobView }
	// An agent wrote to the workspace. An empty `paths` means "refresh whatever
	// is expanded"; a non-empty list names workspace-relative posix paths that
	// changed, so the tree can also highlight them.
	| { type: "files_changed"; paths: string[] }
	| { type: "error"; bot?: string; message: string };

export interface SendBody {
	bot: string;
	text: string;
	// Optional attachments, already encoded by the client as base64. The route
	// rejects a bad media type, an over-cap payload, or too many of them.
	images?: ImagePart[];
}

export interface InterruptBody {
	bot: string;
}

export interface ApprovalBody {
	id: string;
	decision: ApprovalChoice;
}

export type AllowAllMode = "off" | "session" | "all";

// The runtime allow-all scope. `session` applies only to sessionId; `all`
// applies everywhere; `off` applies nowhere. In-memory only.
export interface AllowAllState {
	mode: AllowAllMode;
	sessionId: string | null;
}

export interface AllowAllBody {
	mode: AllowAllMode;
	sessionId?: string | null;
}

export interface SessionNewBody {
	bot: string;
}

export interface SessionOpenBody {
	bot: string;
	id: string;
}

export interface RenameSessionBody {
	bot: string;
	id: string;
	title: string;
}

export interface SessionCloseBody {
	bot: string;
	id: string;
}

// A wake write either sets the interval or clears it; the route rejects a body
// that is neither.
export interface SetWakeBody {
	everyMs?: number;
	prompt?: string;
	clear?: boolean;
}

export interface ForgetMemoryBody {
	id: string;
}

export type CreateBotBody = BotDraft;

// The edit route takes the name from the path, so its body is the draft without
// one.
export type UpdateBotBody = Omit<BotDraft, "name">;
