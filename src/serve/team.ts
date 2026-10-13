import type {
	ApprovalChoice,
	BotInfo,
	BotState,
	BotTranscriptResponse,
	BotWake,
	MemoryEntryView,
	MemoryListResponse,
	ServerEvent,
	SessionSummaryInfo,
} from "../../shared/protocol.js";
import { replay } from "../bot/record.js";
import type { MemoryEntry, Turn } from "../bot/schema.js";
import { type BotStore, createBotStore } from "../bot/store.js";
import {
	type Clock,
	systemClock,
	systemTimer,
	type Timer,
} from "../bot/wake.js";
import { setRobWake } from "../config/project-file.js";
import { createAuthorizer } from "../permissions/authorizer.js";
import type { ImagePart, Message } from "../providers/types.js";
import type { TeamEvent } from "../rob/events.js";
import { type LoadChannelResult, Team, UnknownRobError } from "../rob/team.js";
import type { RobConfig, RobStatusEntry } from "../rob/types.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";
import { parseImages } from "./images.js";
import {
	type ApplyRuntimeResult,
	fallbackProviderView,
	type RuntimeSnapshot,
	UNCONFIGURED_MESSAGE,
} from "./runtime.js";
import { toTranscript } from "./solo.js";

export interface TeamHubOptions extends HubOptions {
	robs: RobConfig[];
	providerEnv: Record<string, string>;
	// Optional so existing test literals keep compiling; production shares the
	// one durable global ledger.
	store?: BotStore;
	clock?: Clock;
	timer?: Timer;
}

export class UnknownMemoryEntryError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Unknown memory entry: ${id}`);
		this.name = "UnknownMemoryEntryError";
		this.id = id;
	}
}

export class TeamHub extends EventBus implements Hub {
	private readonly options: TeamHubOptions;
	private team: Team;
	private readonly roster: RobConfig[];
	// Built once so reconfigure reuses the same ledger handle.
	private readonly store: BotStore;

	constructor(options: TeamHubOptions) {
		super();
		this.options = options;
		this.roster = [...options.robs];
		this.store = options.store ?? createBotStore();
		this.team = this.createTeam();
		this.team.subscribe((event) => this.handle(event));
		this.team.start();
	}

	// The one place a Team is built, so the constructor and reconfigure cannot
	// drift. The provider factory and default model are read through
	// this.options, which reconfigure mutates in place.
	private createTeam(): Team {
		return new Team({
			robs: this.roster,
			defaultModel: this.options.settings.model,
			providerFactory: () => this.options.provider,
			workspaceRoot: this.options.workspaceRoot,
			permissions: this.options.permissions,
			providerEnv: this.options.providerEnv,
			extraTools: this.options.extraTools,
			hooks: this.options.hooks,
			store: this.store,
			clock: this.options.clock ?? systemClock,
			timer: this.options.timer ?? systemTimer,
			authorizerFactory: ({ name, rules, approval }) =>
				createAuthorizer({
					workspaceRoot: this.options.workspaceRoot,
					rules,
					approval,
					yesAll: false,
					allowAll: this.options.allowAll,
					onAutoApproved: (request) =>
						this.emit({
							type: "notice",
							bot: name,
							text: `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`,
						}),
				}),
		});
	}

	// Refuses while any rob is mid-turn: a live Team cannot swap a provider under
	// a running turn. Otherwise it stops the old Team and rebuilds it from the
	// same roster with the new provider and default model.
	async reconfigure(next: RuntimeSnapshot): Promise<ApplyRuntimeResult> {
		const busy = this.team
			.statuses()
			.some(
				(entry) =>
					entry.status === "working" || entry.status === "waiting_approval",
			);
		if (busy) {
			return {
				ok: false,
				error: "A rob is mid-turn; wait for it to finish before saving.",
			};
		}
		await this.team.stop();
		this.options.provider = next.provider;
		this.options.settings = next.settings;
		this.options.providerEnv = next.providerEnv;
		this.team = this.createTeam();
		this.team.subscribe((event) => this.handle(event));
		this.team.start();
		this.emit({ type: "bots", bots: this.bots(), states: this.states() });
		return { ok: true };
	}

	hello(): HelloEvent {
		return {
			type: "hello",
			workspaceRoot: this.options.workspaceRoot,
			model: this.options.settings.model,
			provider:
				this.options.runtime?.view() ??
				fallbackProviderView(this.options.settings),
			bots: this.bots(),
			states: this.states(),
			workspaces: [],
			sessions: [],
			activeSessionId: null,
			transcript: [],
			approvals: [],
			allowAll: this.options.allowAll.get(),
		};
	}

	// Adds a rob to the roster and starts its run loop. The caller persists the
	// config first; a duplicate name throws before the roster changes.
	addBot(config: RobConfig): void {
		this.team.addRob(config);
		this.roster.push(config);
	}

	dispatch(bot: string, text: string, images?: ImagePart[]): void {
		if (text.trim() === "") return;
		if (this.options.runtime?.isConfigured() === false) {
			this.emit({ type: "error", bot, message: UNCONFIGURED_MESSAGE });
			return;
		}
		// A second gate behind the route's: dispatch is also called in-process,
		// so the caps hold wherever a rob's turn starts.
		const attachments = parseImages(images);
		if (!attachments.ok) {
			this.emit({ type: "error", bot, message: attachments.error });
			return;
		}
		try {
			this.team.dispatch(bot, text, attachments.images);
		} catch (error) {
			this.reportError(bot, error);
		}
	}

	interrupt(bot: string): void {
		try {
			this.team.interrupt(bot);
		} catch (error) {
			this.reportError(bot, error);
		}
	}

	// When the server denies a pending rob approval unanswered, or null while it
	// is still queued behind another one.
	approvalDeadline(id: string): number | null {
		return this.team.approvalDeadline(id);
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		try {
			this.team.resolveApproval(id, decision);
		} catch (error) {
			this.emit({ type: "error", message: errorMessage(error) });
		}
	}

	setAllowAll(on: boolean): void {
		this.options.allowAll.set(on);
		this.emit({ type: "allow_all", on });
	}

	async newSession(bot: string): Promise<void> {
		try {
			const session = this.team.openChannel(bot);
			this.emit({
				type: "session_opened",
				bot,
				sessionId: session.id,
				messages: [],
			});
			await this.emitSessions(bot);
		} catch (error) {
			this.reportError(bot, error);
		}
	}

	async openSession(bot: string, id: string): Promise<void> {
		let loaded: LoadChannelResult;
		try {
			loaded = await this.team.loadChannel(bot, id);
		} catch (error) {
			this.reportError(bot, error);
			return;
		}
		if (!loaded.ok) {
			this.emit({ type: "error", bot, message: loaded.error });
			return;
		}
		this.emit({
			type: "session_opened",
			bot,
			sessionId: id,
			messages: toTranscript(loaded.messages),
		});
		await this.emitSessions(bot);
	}

	async closeSession(bot: string, id: string): Promise<void> {
		try {
			this.team.closeChannel(bot, id);
		} catch (error) {
			this.reportError(bot, error);
			return;
		}
		await this.emitSessions(bot);
	}

	// The current session's transcript, replayed from the ledger so the read
	// never consumes the rob's live history. Unknown bot is null (404).
	async readTranscript(bot: string): Promise<BotTranscriptResponse | null> {
		const rob = this.roster.find((candidate) => candidate.name === bot);
		if (rob === undefined) return null;
		const loaded = await this.store.load(bot, {
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const sessionId = this.team.currentChannel(bot).id;
		const turns = loaded.record.turns.filter(
			(turn) => turn.sessionId === sessionId,
		);
		return {
			bot,
			sessionId,
			messages: toTranscript(
				replay(turns, this.options.workspaceRoot, sessionId),
			),
			// The same summaries `bot_sessions` emits, so the read also fills the
			// sidebar's list without a second request.
			sessions: await this.sessionSummaries(bot),
		};
	}

	async readMemory(bot: string): Promise<MemoryListResponse | null> {
		if (!this.hasBot(bot)) return null;
		const entries = await this.store.memory(bot);
		return { bot, entries: entries.map(toMemoryEntryView) };
	}

	// Forgets one memory entry outside a turn. False when the bot is
	// unknown. An id the bot's record has no entry for throws
	// UnknownMemoryEntryError before anything is written, so the
	// route answers 404 instead of reporting success for a no-op.
	async forgetMemory(bot: string, id: string): Promise<boolean> {
		const rob = this.roster.find((candidate) => candidate.name === bot);
		if (rob === undefined) return false;
		const loaded = await this.store.load(bot, {
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
		});
		if (!loaded.ok) throw new Error(loaded.error);
		if (loaded.record.memory.every((entry) => entry.id !== id)) {
			throw new UnknownMemoryEntryError(id);
		}
		const result = await this.store.saveMemory(bot, {
			upsert: [],
			drop: [id],
		});
		if (!result.ok) throw new Error(result.error);
		return true;
	}

	// Writes the schedule to the project file and re-arms the live timer. False
	// when the bot is unknown.
	async setWake(bot: string, wake: BotWake | null): Promise<boolean> {
		const rob = this.roster.find((candidate) => candidate.name === bot);
		if (rob === undefined) return false;
		const saved = await setRobWake(this.options.workspaceRoot, bot, wake);
		if (!saved.ok) throw new Error(saved.error);
		if (wake === null) delete rob.wake;
		else rob.wake = wake;
		this.team.setWake(bot, wake);
		this.emit({ type: "bots", bots: this.bots(), states: this.states() });
		return true;
	}

	private hasBot(bot: string): boolean {
		return this.roster.some((candidate) => candidate.name === bot);
	}

	// The bot's session list is a read-side projection over its ledger, so it
	// survives a restart with no extra store. It is its own event: the chat's
	// `sessions` event belongs to the workspace and a bot must not clobber it.
	private async emitSessions(bot: string): Promise<void> {
		const sessions = await this.sessionSummaries(bot);
		const rob = this.roster.find((candidate) => candidate.name === bot);
		this.emit({
			type: "bot_sessions",
			bot,
			sessions,
			currentSessionId:
				rob === undefined ? null : this.team.currentChannel(bot).id,
		});
	}

	private async sessionSummaries(bot: string): Promise<SessionSummaryInfo[]> {
		const rob = this.roster.find((candidate) => candidate.name === bot);
		if (rob === undefined) return [];
		const loaded = await this.store.load(bot, {
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
		});
		return loaded.ok ? summarizeSessions(loaded.record.turns) : [];
	}

	async dispose(): Promise<void> {
		await this.team.stop();
	}

	private handle(event: TeamEvent): void {
		switch (event.kind) {
			case "rob_event":
				this.emit({ type: "agent_event", bot: event.rob, event: event.event });
				return;
			case "rob_status":
				this.emitBotStatus(event.rob);
				return;
			case "notice":
				this.emit({ type: "notice", bot: event.rob, text: event.text });
				return;
			case "dm":
				this.emit({ type: "dm", entry: event.entry });
				return;
			// The queue starts an expiry window when a request becomes the head of
			// it, so a request enqueued behind another one has no deadline yet.
			// Both cases emit the same wire event; the client keeps one entry per
			// id and reads the deadline it was last told.
			case "approval_requested":
				this.emit({
					type: "approval_requested",
					request: {
						id: event.request.id,
						bot: event.request.rob,
						toolName: event.request.toolName,
						subject: event.request.subject,
						dangerous: event.request.dangerous,
						rule: event.request.rule,
						expiresAt: this.team.approvalDeadline(event.request.id),
					},
				});
				return;
			case "approval_resolved":
				this.emit({
					type: "approval_resolved",
					id: event.id,
					decision: event.decision,
				});
				return;
			case "subagent":
				return;
			case "channel":
				this.emitBotStatus(event.bot);
				return;
		}
	}

	private emitBotStatus(rob: string): void {
		const state = this.states().find((entry) => entry.bot === rob);
		if (state !== undefined) this.emit({ type: "bot_status", state });
	}

	bots(): BotInfo[] {
		return this.roster.map((rob) => {
			const info: BotInfo = {
				name: rob.name,
				role: rob.role,
				model: rob.model ?? this.options.settings.model,
				backend:
					rob.backend?.kind === "cli" ? ("cli" as const) : ("native" as const),
			};
			const wake = this.team.robWake(rob.name);
			if (wake !== null) info.wake = wake;
			return info;
		});
	}

	states(): BotState[] {
		return this.team.statuses().map(toBotState);
	}

	private reportError(bot: string, error: unknown): void {
		const message =
			error instanceof UnknownRobError
				? `Unknown bot: ${bot}`
				: errorMessage(error);
		this.emit({ type: "error", bot, message });
	}
}

// A bot's "sessions" are a read-side projection over its ledger turns: the
// distinct session ids, newest first, with the same summary shape the workspace
// chat uses.
export function summarizeSessions(
	turns: readonly Turn[],
): SessionSummaryInfo[] {
	const summaries = new Map<string, SessionSummaryInfo>();
	for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
		const existing = summaries.get(turn.sessionId);
		if (existing === undefined) {
			summaries.set(turn.sessionId, {
				id: turn.sessionId,
				updatedAt: turn.at,
				messageCount: turn.messages.length,
				firstUserText: firstUserMessageText(turn.messages),
			});
			continue;
		}
		existing.updatedAt = turn.at;
		existing.messageCount += turn.messages.length;
		if (existing.firstUserText === "") {
			existing.firstUserText = firstUserMessageText(turn.messages);
		}
	}
	return [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function firstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role === "user") return message.content;
	}
	return "";
}

function toBotState(entry: RobStatusEntry): BotState {
	return {
		bot: entry.name,
		status: entry.status,
		messageCount: entry.messageCount,
		pending: entry.pending,
		lastMessage: entry.lastMessage,
		usage: { ...entry.usage },
	};
}

// The wire view drops the ledger-only provenance fields.
function toMemoryEntryView(entry: MemoryEntry): MemoryEntryView {
	return {
		id: entry.id,
		at: entry.at,
		kind: entry.kind,
		text: entry.text,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { ServerEvent };
