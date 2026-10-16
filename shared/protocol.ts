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
			command: RobCommand;
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

export type CreateBotBody = BotDraft;
