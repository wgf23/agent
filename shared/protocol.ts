// Wire types shared by the my-agent server (src/serve) and the web client
// (web/). This file has no imports: tsc and Vite both read it directly.
// AgentEvent mirrors src/agent/events.ts.

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
			reason: "finished" | "max_steps" | "aborted" | "error";
			steps: number;
	  };

export type BotKind = "workspace" | "rob";
export type BotStatus = "idle" | "working" | "waiting_approval" | "stopped";
export type BackendKind = "native" | "cli";
export type ApprovalChoice = "allow_once" | "allow_always" | "deny";

export const WORKSPACE_BOT = "assistant";

export interface BotInfo {
	name: string;
	kind: BotKind;
	role: string;
	model: string;
	backend: BackendKind;
}

export type BotBackendDraft =
	| { kind: "native" }
	| {
			kind: "cli";
			command: "pi" | "opencode";
			provider?: string;
			model?: string;
	  };

export interface BotDraft {
	name: string;
	role: string;
	model?: string;
	backend?: BotBackendDraft;
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

export interface ApprovalRequestInfo {
	id: string;
	bot: string;
	toolName: string;
	subject: string;
	dangerous: boolean;
	rule: string | null;
}

export interface SessionSummaryInfo {
	id: string;
	updatedAt: number;
	messageCount: number;
	firstUserText: string;
}

export interface DmInfo {
	from: string;
	to: string;
	text: string;
	at: number;
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
			allowAll: boolean;
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
	| { type: "bot_status"; state: BotState }
	| { type: "agent_event"; bot: string; event: AgentEvent }
	| { type: "approval_requested"; request: ApprovalRequestInfo }
	| { type: "approval_resolved"; id: string; decision: ApprovalChoice }
	| { type: "notice"; bot: string; text: string }
	| { type: "dm"; entry: DmInfo }
	| { type: "room"; event: RoomEventInfo }
	| { type: "allow_all"; on: boolean }
	| { type: "error"; bot?: string; message: string };

export interface SendBody {
	bot: string;
	text: string;
}

export interface InterruptBody {
	bot: string;
}

export interface ApprovalBody {
	id: string;
	decision: ApprovalChoice;
}

export interface AllowAllBody {
	on: boolean;
}

export interface SessionNewBody {
	bot: string;
}

export interface SessionOpenBody {
	bot: string;
	id: string;
}

export type CreateBotBody = BotDraft;
