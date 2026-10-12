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
			bots: BotInfo[];
			states: BotState[];
			sessions: SessionSummaryInfo[];
			activeSessionId: string | null;
			transcript: TranscriptMessage[];
			approvals: ApprovalRequestInfo[];
			allowAll: boolean;
	  }
	| { type: "bots"; bots: BotInfo[]; states: BotState[] }
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
