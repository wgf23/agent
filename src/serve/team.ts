import type {
	AllowAllMode,
	ApprovalChoice,
	BotContextResponse,
	BotInfo,
	BotState,
	BotTranscriptResponse,
	BotWake,
	MemoryEntryView,
	MemoryListResponse,
	RoomEventInfo,
	RoomInfo,
	RoomMatches,
	RoomMessageView,
	RoomRunView,
	ServerEvent,
	SessionSummaryInfo,
} from "../../shared/protocol.js";
import { assembleContext, type ThreadView } from "../bot/context.js";
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
import { DEFAULT_CONTEXT_BUDGET } from "../rob/rob.js";
import type {
	RoomConfig,
	RoomCreateOutcome,
	RoomEntry,
	RoomEvent,
	RoomRun,
	RoomSendOutcome,
	RoomView,
} from "../rob/room.js";
import { type LoadChannelResult, Team, UnknownRobError } from "../rob/team.js";
import type { RobConfig, RobStatusEntry } from "../rob/types.js";
import type { Tool } from "../tools/types.js";
import { FilesChangedTracker } from "./files-changed.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";
import { parseImages } from "./images.js";
import {
	type ApplyRuntimeResult,
	fallbackProviderView,
	type RuntimeSnapshot,
	UNCONFIGURED_MESSAGE,
} from "./runtime.js";
import { roomMatches } from "./search.js";
import { toTranscript } from "./solo.js";

// A memory id the bot's record does not carry. The route turns this into a 404
// instead of reporting a no-op success.
export class UnknownMemoryEntryError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Unknown memory entry: ${id}`);
		this.name = "UnknownMemoryEntryError";
		this.id = id;
	}
}

export interface TeamHubOptions extends HubOptions {
	robs: RobConfig[];
	rooms?: readonly RoomConfig[];
	providerEnv: Record<string, string>;
	// MCP tools grouped by server, so each rob gets only the servers it
	// enables. Optional: without it no filtering happens.
	mcpToolsByServer?: Readonly<Record<string, readonly Tool[]>>;
	// Optional so existing test literals keep compiling; production shares the
	// one durable global ledger.
	store?: BotStore;
	clock?: Clock;
	timer?: Timer;
}

export class TeamHub extends EventBus implements Hub {
	private readonly options: TeamHubOptions;
	private team: Team;
	private readonly roster: RobConfig[];
	// Built once so reconfigure reuses the same ledger handle.
	private readonly store: BotStore;
	// One tracker per rob: a `tool_finished` names no args, so the tracker
	// remembers that rob's `tool_started` until its write finishes.
	private readonly filesChanged = new Map<string, FilesChangedTracker>();

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
			rooms: this.options.rooms,
			defaultModel: this.options.settings.model,
			providerFactory: () => this.options.provider,
			workspaceRoot: this.options.workspaceRoot,
			permissions: this.options.permissions,
			providerEnv: this.options.providerEnv,
			extraTools: this.options.extraTools,
			mcpToolsByServer: this.options.mcpToolsByServer,
			hooks: this.options.hooks,
			store: this.store,
			clock: this.options.clock ?? systemClock,
			timer: this.options.timer ?? systemTimer,
			consolidate: this.options.consolidate === true,
			authorizerFactory: ({ name, rules, approval, sessionId }) =>
				createAuthorizer({
					workspaceRoot: this.options.workspaceRoot,
					rules,
					approval,
					yesAll: false,
					allowAll: this.options.allowAll,
					sessionId,
					onAutoApproved: (request) =>
						this.emit({
							type: "notice",
							bot: name,
							text: `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`,
						}),
				}),
		});
	}

	// Refuses while any rob is mid-turn or any room runs: a live Team cannot
	// swap a provider under a running turn. Otherwise it stops the old Team and
	// rebuilds it from the same roster with the new provider and default model.
	async reconfigure(next: RuntimeSnapshot): Promise<ApplyRuntimeResult> {
		if (this.team.busy()) {
			return {
				ok: false,
				error: "A turn or room run is in flight; wait for it to finish.",
			};
		}
		await this.team.stop();
		this.options.provider = next.provider;
		this.options.settings = next.settings;
		this.options.providerEnv = next.providerEnv;
		this.team = this.createTeam();
		// The rebuilt Team starts every rob's run fresh; drop the old trackers
		// so a stale started-args entry cannot name a file for a new turn.
		this.filesChanged.clear();
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
			rooms: this.rooms(),
			sessions: [],
			activeSessionId: null,
			transcript: [],
			approvals: [],
			allowAll: this.options.allowAll.state(),
		};
	}

	// Adds a rob to the roster and starts its run loop. The caller persists the
	// config first; a duplicate name throws before the roster changes.
	addBot(config: RobConfig): void {
		this.team.addRob(config);
		this.roster.push(config);
	}

	// Tears down a bot's runtime and drops its ledger, then announces the new
	// roster. The ledger is the only step that can fail, so it runs first: a
	// store failure leaves the runtime and roster intact and emits no `bots`
	// event claiming the bot is gone, and the caller still owns the config.
	// False when the roster has no such bot, so the route can answer 404
	// without reaching the runtime.
	async removeBot(name: string): Promise<boolean> {
		if (!this.hasBot(name)) return false;
		await this.store.remove(name);
		this.team.removeRob(name);
		const index = this.roster.findIndex((rob) => rob.name === name);
		if (index !== -1) this.roster.splice(index, 1);
		this.emit({ type: "bots", bots: this.bots(), states: this.states() });
		return true;
	}

	// Restarts a bot's runtime from the new config and announces the roster.
	// The caller persists the config first and keeps the wake in `config`.
	// UnknownRobError names a bot the roster never had.
	replaceBot(name: string, config: RobConfig): BotInfo {
		if (!this.hasBot(name)) throw new UnknownRobError(name);
		this.team.updateRob(config);
		const index = this.roster.findIndex((rob) => rob.name === name);
		if (index !== -1) this.roster[index] = config;
		this.emit({ type: "bots", bots: this.bots(), states: this.states() });
		const updated = this.bots().find((bot) => bot.name === name);
		if (updated === undefined) throw new UnknownRobError(name);
		return updated;
	}

	private hasBot(bot: string): boolean {
		return this.roster.some((candidate) => candidate.name === bot);
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

	rooms(): RoomInfo[] {
		return this.team.rooms().map(toRoomInfo);
	}

	createRoom(config: RoomConfig): RoomCreateOutcome {
		return this.team.createRoom(config);
	}

	sendToRoom(room: string, text: string): RoomSendOutcome {
		return this.team.sendToRoom(room, text);
	}

	interruptRoom(room: string): void {
		this.team.interruptRoom(room);
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		try {
			this.team.resolveApproval(id, decision);
		} catch (error) {
			this.emit({ type: "error", message: errorMessage(error) });
		}
	}

	setAllowAll(mode: AllowAllMode, sessionId: string | null): void {
		this.options.allowAll.setMode(mode, sessionId);
		this.emit({ type: "allow_all", allowAll: this.options.allowAll.state() });
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
			this.emitBotStatus(bot);
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
		this.emitBotStatus(bot);
		await this.emitSessions(bot);
	}

	async closeSession(bot: string, id: string): Promise<void> {
		try {
			this.team.closeChannel(bot, id);
		} catch (error) {
			this.reportError(bot, error);
			return;
		}
		this.emitBotStatus(bot);
		await this.emitSessions(bot);
	}

	// Drops one session from the bot's ledger. Deleting the current channel
	// opens a fresh one, so the bot always has somewhere to write. False when
	// the bot is unknown or the ledger has no such session (the route's 404).
	async deleteSession(bot: string, id: string): Promise<boolean> {
		if (!this.hasBot(bot)) return false;
		const result = await this.store.removeSession(bot, id);
		if (!result.ok) return false;
		if (this.team.currentChannel(bot).id === id) {
			const session = this.team.openChannel(bot);
			this.emit({
				type: "session_opened",
				bot,
				sessionId: session.id,
				messages: [],
			});
		}
		await this.emitSessions(bot);
		return true;
	}

	// Relabels one session. A label change never touches the turns, so the
	// projection's updatedAt is unchanged. False like deleteSession.
	async renameSession(
		bot: string,
		id: string,
		title: string,
	): Promise<boolean> {
		if (!this.hasBot(bot)) return false;
		const result = await this.store.renameSession(bot, id, title);
		if (!result.ok) return false;
		await this.emitSessions(bot);
		return true;
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

	// Recomputes the turn's assembled context for observability. It loads the
	// ledger, reads the current thread's rolling summary, and runs the same pure
	// assembleContext the turn does with an empty inbound and the default budget,
	// so the same record always reads back the same layers. No provider call and
	// no write. Null for an unknown bot (404).
	async readContext(bot: string): Promise<BotContextResponse | null> {
		const rob = this.roster.find((candidate) => candidate.name === bot);
		if (rob === undefined) return null;
		const loaded = await this.store.load(bot, {
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const threadId = this.team.currentChannel(bot).id;
		const thread: ThreadView = {
			id: threadId,
			summary: loaded.record.threads?.[threadId]?.summary ?? "",
		};
		const assembled = assembleContext({
			record: loaded.record,
			thread,
			inbound: [],
			workspaceRoot: this.options.workspaceRoot,
			budget: DEFAULT_CONTEXT_BUDGET,
		});
		const { l1, l2, l3, l4 } = assembled.layers;
		return {
			layers: { ...assembled.layers, included: l1 + l2 + l3 + l4 },
			dropped: assembled.dropped,
			summary: thread.summary,
		};
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
		return loaded.ok
			? summarizeSessions(loaded.record.turns, loaded.record.sessionTitles)
			: [];
	}

	// The room half of a search: every room's transcript for this workspace.
	// Read-only, so it neither emits an event nor changes a status.
	async search(query: string): Promise<RoomMatches[]> {
		return roomMatches(this.team.rooms(), query);
	}

	async dispose(): Promise<void> {
		await this.team.stop();
	}

	private handle(event: TeamEvent): void {
		switch (event.kind) {
			case "rob_event": {
				this.emit({ type: "agent_event", bot: event.rob, event: event.event });
				// A successful write tells the tree to refresh; a bash run
				// refreshes blindly because its paths are unknown.
				const tracker =
					this.filesChanged.get(event.rob) ?? new FilesChangedTracker();
				this.filesChanged.set(event.rob, tracker);
				const paths = tracker.onEvent(this.options.workspaceRoot, event.event);
				if (paths !== null) this.emit({ type: "files_changed", paths });
				return;
			}
			case "rob_status":
				this.emitBotStatus(event.rob);
				return;
			case "notice":
				this.emit({ type: "notice", bot: event.rob, text: event.text });
				return;
			case "dm":
				this.emit({ type: "dm", entry: event.entry });
				return;
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
						expiresAt: event.expiresAt ?? null,
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
				// Addressed to the bot that delegated, so the web keys its feed
				// by the parent name.
				this.emit({
					type: "subagent",
					bot: event.entry.parent,
					entry: event.entry,
				});
				return;
			case "room":
				this.emit({ type: "room", event: toRoomEventInfo(event.event) });
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
				kind: "rob",
				role: rob.role,
				model: rob.model ?? this.options.settings.model,
				backend:
					rob.backend?.kind === "cli" ? ("cli" as const) : ("native" as const),
			};
			if (rob.backend?.kind === "cli") {
				info.command = rob.backend.command;
				if (rob.backend.provider !== undefined) {
					info.provider = rob.backend.provider;
				}
				if (rob.backend.model !== undefined) {
					info.backendModel = rob.backend.model;
				}
			}
			// Echoed as stored: a field the config never set stays off the
			// wire, so the panel can tell "default" from "explicitly empty".
			if (rob.skills !== undefined) info.skills = [...rob.skills];
			if (rob.skillsConfigured !== undefined) {
				info.skillsConfigured = rob.skillsConfigured;
			}
			if (rob.mcp !== undefined) info.mcp = [...rob.mcp];
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

// A bot's "sessions" are a read-side projection over its ledger turns: the
// distinct session ids, newest first, with the same summary shape the workspace
// chat uses.
export function summarizeSessions(
	turns: readonly Turn[],
	titles: Readonly<Record<string, string>> = {},
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
				title: titles[turn.sessionId] ?? null,
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

// The wire view drops the ledger-only provenance fields.
function toMemoryEntryView(entry: MemoryEntry): MemoryEntryView {
	return {
		id: entry.id,
		at: entry.at,
		kind: entry.kind,
		text: entry.text,
	};
}

// hello.rooms is windowed so a reload replays a bound, not the whole history.
export const ROOM_INFO_WINDOW = 100;

export function toRoomInfo(view: RoomView): RoomInfo {
	return {
		name: view.name,
		members: [...view.members],
		coordinator: view.coordinator,
		transcript: view.transcript.slice(-ROOM_INFO_WINDOW).map(toRoomMessageView),
		run: toRoomRunView(view.run),
		pending: view.pending,
		deliverable: view.deliverable === null ? null : { ...view.deliverable },
		limits: { ...view.limits },
	};
}

export function toRoomEventInfo(event: RoomEvent): RoomEventInfo {
	switch (event.kind) {
		case "entry":
			return {
				kind: "entry",
				room: event.room,
				entry: toRoomMessageView(event.entry),
			};
		case "run":
			return {
				kind: "run",
				room: event.room,
				run: toRoomRunView(event.run),
			};
		case "run_ended":
			return {
				kind: "run_ended",
				room: event.room,
				run: toRoomRunView(event.run),
				outcome: event.outcome,
			};
		case "turn":
			return {
				kind: "turn",
				room: event.room,
				member: event.member,
				round: event.round,
				state: event.state,
			};
		case "members":
			return {
				kind: "members",
				room: event.room,
				members: [...event.members],
			};
	}
}

function toRoomMessageView(entry: RoomEntry): RoomMessageView {
	switch (entry.kind) {
		case "user":
			return { id: entry.id, at: entry.at, kind: "user", text: entry.text };
		case "member":
			return {
				id: entry.id,
				at: entry.at,
				kind: "member",
				from: entry.from,
				text: entry.text,
			};
		case "system":
			return { id: entry.id, at: entry.at, kind: "system", text: entry.text };
	}
}

function toRoomRunView(run: RoomRun): RoomRunView {
	if (run.phase === "idle") return { phase: "idle" };
	return {
		phase: "running",
		round: run.round,
		rounds: run.rounds,
		current: run.current,
		posted: run.posted,
		remaining: run.remaining,
		addressed: [...run.addressed],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { ServerEvent };
