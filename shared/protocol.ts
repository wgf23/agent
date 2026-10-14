// Wire types shared by the my-agent server (src/serve) and the web client
// (web/). This file has no runtime imports: its only import is the erased
// type-only `AgentId` from ./agents.js, so tsc and Vite both read it
// directly. AgentEvent mirrors src/agent/events.ts.

import type { AgentId } from "./agents.js";

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

export type BotStatus = "idle" | "working" | "waiting_approval" | "stopped";
export type BackendKind = "native" | "cli";
export type ApprovalChoice = "allow_once" | "allow_always" | "deny";

export const WORKSPACE_BOT = "assistant";

export interface BotWake {
	everyMs: number;
	prompt: string;
}

export interface BotInfo {
	name: string;
	role: string;
	model: string;
	backend: BackendKind;
	// The configured interval that wakes the bot; absent when it has none.
	wake?: BotWake | null;
}

// One entry in the workspace picker. `active` marks the scope the server is
// currently bound to; `lastOpenedAt` orders the recent list newest first.
export interface WorkspaceOption {
	root: string;
	label: string;
	lastOpenedAt: number;
	active: boolean;
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

// The web Bot surface only offers the built-in backend; a hand-written config
// and the TUI may still carry a `cli` backend, but the API rejects one.
export type BotBackendDraft = { kind: "native" };

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

// One sub-agent event, mirrored from src/rob/types.ts's SubagentEntry so the
// web feed can render the same lines the TUI's SubagentView does.
export interface SubagentView {
	parent: string;
	id: string;
	at: number;
	event: AgentEvent;
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

// One message that carries the query: its role, a bounded snippet with the
// match intact, and the turn (or session) time it belongs to.
export interface SearchHit {
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	at: number;
}

// Every hit for one session, with the same summary fields the sidebar lists, so
// a search result can be opened like any other session.
export interface SessionMatch {
	sessionId: string;
	title: string | null;
	firstUserText: string;
	hits: SearchHit[];
}

// One bot's matches, present only when the bot has at least one.
export interface BotMatches {
	bot: string;
	matches: SessionMatch[];
}

// The whole answer to one read-only search: the query echoed back, the chat's
// matches, and each bot's matches.
export interface SearchResponse {
	query: string;
	chat: SessionMatch[];
	bots: BotMatches[];
}

export type ServerEvent =
	| {
			type: "hello";
			workspaceRoot: string;
			model: string;
			provider: ProviderView;
			bots: BotInfo[];
			states: BotState[];
			workspaces: WorkspaceOption[];
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
	| { type: "allow_all"; on: boolean }
	| { type: "agents"; agents: AgentStatusView[] }
	| { type: "agent_job"; job: AgentJobView }
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

export interface SessionCloseBody {
	bot: string;
	id: string;
}

export interface RenameSessionBody {
	bot: string;
	id: string;
	title: string;
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
