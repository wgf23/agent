import type {
	ApprovalRequestInfo,
	BotInfo,
	BotState,
	ServerEvent,
	SessionSummaryInfo,
	TranscriptMessage,
} from "../../shared/protocol.js";
import { runAgent } from "../agent/agent.js";
import { COMPACTED_SUMMARY_PREFIX } from "../agent/compact.js";
import type { AgentEvent } from "../agent/events.js";
import type { AllowAll } from "../permissions/allow-all.js";
import {
	type ApprovalChoice,
	type ApprovalDecision,
	type ApprovalRequest,
	createAuthorizer,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import type { Message } from "../providers/types.js";
import {
	listSessions,
	loadSession,
	newSession,
	type SessionSummary,
	type StoredSession,
	saveSession,
	withoutSystem,
} from "../session/store.js";
import { createTaskTool } from "../tools/task.js";
import { summarizeArgs } from "../tui/summarize.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";
import { fallbackProviderView, UNCONFIGURED_MESSAGE } from "./runtime.js";

export const DEFAULT_BOT = "assistant";
const DEFAULT_BOT_ROLE = "Your coding agent. Reads, edits, and runs things.";

// The plan's deferred-start rule: a reconnect replays the current transcript
// through the hello snapshot, and the live tail through subscribe. Both read
// the same in-memory session, so no disk read lands between them.
export class SoloHub extends EventBus implements Hub {
	private readonly options: HubOptions;
	private readonly allowAll: AllowAll;
	private session: StoredSession;
	private sessions: SessionSummaryInfo[];
	private status: BotState["status"] = "idle";
	private readonly queue: string[] = [];
	private controller: AbortController | null = null;
	private disposed = false;
	private approvalSeq = 0;
	private readonly pendingApprovals = new Map<
		string,
		{
			request: ApprovalRequestInfo;
			resolve: (decision: ApprovalDecision) => void;
		}
	>();

	constructor(
		options: HubOptions,
		initial: { session: StoredSession; sessions: SessionSummary[] },
	) {
		super();
		this.options = options;
		this.allowAll = options.allowAll;
		this.session = initial.session;
		this.sessions = initial.sessions.map(toSessionSummaryInfo);
	}

	hello(): HelloEvent {
		return {
			type: "hello",
			workspaceRoot: this.options.workspaceRoot,
			model: this.options.settings.model,
			provider:
				this.options.runtime?.view() ??
				fallbackProviderView(this.options.settings),
			bots: [this.botInfo()],
			states: [this.state()],
			sessions: this.sessions,
			activeSessionId: this.session.id,
			transcript: toTranscript(this.session.messages),
			approvals: [...this.pendingApprovals.values()].map((p) => p.request),
			allowAll: this.allowAll.get(),
		};
	}

	dispatch(bot: string, text: string): void {
		if (bot !== DEFAULT_BOT) {
			this.emit({
				type: "error",
				bot,
				message: `Unknown bot: ${bot}`,
			});
			return;
		}
		if (text.trim() === "") return;
		if (this.options.runtime?.isConfigured() === false) {
			this.emit({ type: "error", bot, message: UNCONFIGURED_MESSAGE });
			return;
		}
		if (this.status === "working" || this.status === "waiting_approval") {
			this.queue.push(text);
			return;
		}
		void this.startRun(text);
	}

	interrupt(bot: string): void {
		if (bot !== DEFAULT_BOT) return;
		this.queue.length = 0;
		this.controller?.abort();
		this.denyPending(
			"The turn was interrupted before the approval was answered.",
		);
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		const entry = this.pendingApprovals.get(id);
		if (entry === undefined) {
			this.emit({ type: "error", message: `Unknown approval: ${id}` });
			return;
		}
		this.pendingApprovals.delete(id);
		entry.resolve(decision);
		this.setStatus("working");
		this.emit({ type: "approval_resolved", id, decision });
	}

	setAllowAll(on: boolean): void {
		this.allowAll.set(on);
		this.emit({ type: "allow_all", on });
	}

	async newSession(bot: string): Promise<void> {
		if (bot !== DEFAULT_BOT) return;
		this.session = newSession(
			this.options.workspaceRoot,
			this.options.settings.model,
		);
		this.setStatus("idle");
		this.emit({
			type: "session_opened",
			bot: DEFAULT_BOT,
			sessionId: this.session.id,
			messages: [],
		});
		await this.refreshSessions();
	}

	async openSession(bot: string, id: string): Promise<void> {
		if (bot !== DEFAULT_BOT) return;
		if (this.status === "working" || this.status === "waiting_approval") {
			this.emit({
				type: "error",
				bot,
				message:
					"Wait for the current turn to finish before switching sessions.",
			});
			return;
		}
		const loaded = await loadSession(this.options.workspaceRoot, id);
		if (!loaded.ok) {
			this.emit({ type: "error", bot, message: loaded.error });
			return;
		}
		this.session = loaded.session;
		this.setStatus("idle");
		this.emit({
			type: "session_opened",
			bot: DEFAULT_BOT,
			sessionId: this.session.id,
			messages: toTranscript(this.session.messages),
		});
		this.emit({ type: "bot_status", state: this.state() });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.controller?.abort();
		this.denyPending("my-agent stopped before the approval was answered.");
	}

	private async startRun(prompt: string): Promise<void> {
		if (this.disposed) return;
		const controller = new AbortController();
		this.controller = controller;
		this.setStatus("working");

		const deepseek = this.options.settings.preset === "deepseek";
		const authorize = createAuthorizer({
			workspaceRoot: this.options.workspaceRoot,
			rules: { ...defaultRules(), ...this.options.permissions },
			approval: (request) => this.requestApproval(request),
			yesAll: false,
			allowAll: this.allowAll,
			onAutoApproved: (request) =>
				this.emit({
					type: "notice",
					bot: DEFAULT_BOT,
					text: `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`,
				}),
		});

		const thinking = deepseek ? this.options.settings.thinking : undefined;
		const reasoningEffort = deepseek
			? this.options.settings.reasoningEffort
			: undefined;
		// The sub-agent inherits the parent's provider, model, workspace,
		// authorize, and thinking, and receives the standard tools only, so it
		// cannot recurse.
		const taskTool = createTaskTool({
			depth: 0,
			run: (task, signal) =>
				runAgent({
					provider: this.options.provider,
					model: this.options.settings.model,
					workspaceRoot: this.options.workspaceRoot,
					prompt: task,
					history: [],
					signal,
					authorize,
					thinking,
					reasoningEffort,
					onEvent: () => {},
				}).then((result) => lastAssistantText(result.messages) ?? ""),
		});

		try {
			const result = await runAgent({
				provider: this.options.provider,
				model: this.options.settings.model,
				workspaceRoot: this.options.workspaceRoot,
				prompt,
				history: this.session.messages,
				maxSteps: this.options.settings.maxSteps,
				thinking,
				reasoningEffort,
				signal: controller.signal,
				authorize,
				compaction: this.options.compaction,
				extraTools: [...this.options.extraTools, taskTool],
				drainInput: () => {
					const queued = this.queue.splice(0);
					return queued.map((text) => ({ role: "user", content: text }));
				},
				onEvent: (event: AgentEvent) => {
					this.emit({ type: "agent_event", bot: DEFAULT_BOT, event });
				},
			});

			this.session.messages = withoutSystem(result.messages);
			this.session.usage = {
				input: this.session.usage.input + result.usage.inputTokens,
				output: this.session.usage.output + result.usage.outputTokens,
			};
			this.session.model = this.options.settings.model;
			this.session.updatedAt = Date.now();
			const saved = await saveSession(this.session);
			if (!saved.ok) this.emit({ type: "error", message: saved.error });
		} catch (error) {
			this.emit({ type: "error", message: errorMessage(error) });
		} finally {
			this.controller = null;
			this.setStatus("idle");
			await this.refreshSessions();
			// A message that arrived after the last step boundary is still
			// queued; run it as a fresh turn so an interjection is never lost.
			const next = this.queue.shift();
			if (next !== undefined && !this.disposed) void this.startRun(next);
		}
	}

	private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		const id = `ws-approval-${this.approvalSeq}`;
		this.approvalSeq += 1;
		const info: ApprovalRequestInfo = { id, bot: DEFAULT_BOT, ...request };
		return new Promise<ApprovalDecision>((resolve) => {
			this.pendingApprovals.set(id, { request: info, resolve });
			this.setStatus("waiting_approval");
			this.emit({ type: "approval_requested", request: info });
		});
	}

	private denyPending(reason: string): void {
		for (const [id, entry] of [...this.pendingApprovals]) {
			this.pendingApprovals.delete(id);
			entry.resolve({ deny: reason });
			this.emit({ type: "approval_resolved", id, decision: "deny" });
		}
	}

	private async refreshSessions(): Promise<void> {
		const summaries = await listSessions(this.options.workspaceRoot);
		this.sessions = summaries.map(toSessionSummaryInfo);
		this.emit({ type: "sessions", sessions: this.sessions });
		this.emit({ type: "bot_status", state: this.state() });
	}

	private setStatus(status: BotState["status"]): void {
		this.status = status;
		this.emit({ type: "bot_status", state: this.state() });
	}

	private botInfo(): BotInfo {
		return {
			name: DEFAULT_BOT,
			kind: "workspace",
			role: DEFAULT_BOT_ROLE,
			model: this.options.settings.model,
			backend: "native" as const,
		};
	}

	private state(): BotState {
		return {
			bot: DEFAULT_BOT,
			status: this.status,
			messageCount: this.session.messages.length,
			pending: this.queue.length,
			lastMessage: lastAssistantText(this.session.messages),
			usage: { ...this.session.usage },
		};
	}
}

function toSessionSummaryInfo(summary: SessionSummary): SessionSummaryInfo {
	return {
		id: summary.id,
		updatedAt: summary.updatedAt,
		messageCount: summary.messageCount,
		firstUserText: summary.firstUserText,
	};
}

// Folds tool results back onto their assistant call and collapses a compacted
// summary to a stub, matching what the TUI shows on resume.
export function toTranscript(messages: Message[]): TranscriptMessage[] {
	const toolResults = new Map<string, { content: string; isError: boolean }>();
	for (const message of messages) {
		if (message.role === "tool") {
			toolResults.set(message.toolCallId, {
				content: message.content,
				isError: message.isError === true,
			});
		}
	}

	const out: TranscriptMessage[] = [];
	let id = 1;
	for (const message of messages) {
		if (message.role === "user") {
			if (message.content.startsWith(COMPACTED_SUMMARY_PREFIX)) {
				const summary = message.content
					.slice(COMPACTED_SUMMARY_PREFIX.length)
					.replace(/^\n/, "");
				out.push({
					id: id++,
					role: "system",
					text: `compacted summary (${summary.length} chars)`,
					reasoning: "",
					tools: [],
				});
				continue;
			}
			out.push({
				id: id++,
				role: "user",
				text: message.content,
				reasoning: "",
				tools: [],
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		out.push({
			id: id++,
			role: "assistant",
			text: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
			reasoning: message.content
				.filter((block) => block.type === "reasoning")
				.map((block) => block.text)
				.join(""),
			tools: message.content
				.filter((block) => block.type === "tool_call")
				.map((block) => {
					const result = toolResults.get(block.id);
					return {
						id: block.id,
						name: block.name,
						args: block.args,
						summary: summarizeArgs(block.name, block.args),
						status:
							result?.isError === true ? ("error" as const) : ("ok" as const),
						output: result?.content ?? "",
					};
				}),
		});
	}
	return out;
}

function lastAssistantText(messages: Message[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		return text;
	}
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { ServerEvent };
