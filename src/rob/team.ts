import type { AgentEvent } from "../agent/events.js";
import { ChannelRegistry, type ChannelSession } from "../bot/channel.js";
import { replay } from "../bot/record.js";
import { type BotStore, createBotStore } from "../bot/store.js";
import {
	type Clock,
	systemClock,
	systemTimer,
	type Timer,
	type Wake,
} from "../bot/wake.js";
import type { HooksConfig } from "../hooks/hooks.js";
import type {
	ApprovalChoice,
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import { defaultRules, type PermissionRules } from "../permissions/rules.js";
import type { ImagePart, Message, Provider } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { ApprovalQueue } from "./approvals.js";
import type { TeamEvent, TeamListener } from "./events.js";
import { type AuthorizerFactory, Rob } from "./rob.js";
import { robToolRules } from "./tools.js";
import type {
	DmEntry,
	RobConfig,
	RobName,
	RobStatus,
	RobStatusEntry,
	SubagentEntry,
	TeamPort,
} from "./types.js";

export const TEAM_STOPPED_REASON =
	"The team stopped before this approval was answered.";

export const TURN_INTERRUPTED_REASON =
	"The turn was interrupted before the approval was answered.";

export const ROB_REMOVED_REASON =
	"The bot was removed before this approval was answered.";

export class UnknownRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Unknown rob: ${name}`);
		this.name = "UnknownRobError";
		this.robName = name;
	}
}

export class DuplicateRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Duplicate rob name: ${name}`);
		this.name = "DuplicateRobError";
		this.robName = name;
	}
}

export interface TeamOptions {
	robs: RobConfig[];
	defaultModel: string;
	providerFactory: (rob: RobConfig) => Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
	permissions?: PermissionRules;
	providerEnv?: Record<string, string>;
	// Native robs receive these; cli backends run their own tool registry.
	extraTools?: Tool[];
	hooks?: HooksConfig;
	// Optional so existing callers keep compiling; a team without an injected
	// store still gets the durable global ledger.
	store?: BotStore;
	clock?: Clock;
	timer?: Timer;
	// An unanswered approval expires and is denied after this long, so a
	// proactive wake cannot hang a turn forever. Defaults in ApprovalQueue.
	approvalTimeoutMs?: number;
}

export type LoadChannelResult =
	| { ok: true; messages: Message[] }
	| { ok: false; error: string };

export class Team implements TeamPort {
	private readonly options: TeamOptions;
	private readonly robs = new Map<RobName, Rob>();
	private readonly loops = new Map<RobName, Promise<void>>();
	private readonly dms: DmEntry[] = [];
	private readonly subagents: SubagentEntry[] = [];
	private readonly approvals = new ApprovalQueue({
		// A queued request has no window until it becomes the head, so re-emit
		// it the moment it does: a client counting down needs the deadline, not
		// the fact that one exists.
		onArm: (request, expiresAt) => {
			this.emit({ kind: "approval_requested", request, expiresAt });
		},
	});
	private readonly listeners = new Set<TeamListener>();
	private readonly store: BotStore;
	// One registry for the whole team, so every rob shares the same channel
	// bookkeeping and a bot can only ever be current in one place.
	private readonly channels: ChannelRegistry;
	private readonly clock: Clock;
	private readonly timer: Timer;
	// One cancel per armed interval, keyed by rob, so stop() can disarm them all.
	private readonly wakeTimers = new Map<RobName, () => void>();
	// The live wake per rob, seeded from the roster and replaced by setWake.
	private readonly wakes = new Map<RobName, RobConfig["wake"] | null>();
	private started = false;
	private stopping = false;

	constructor(options: TeamOptions) {
		this.options = options;
		this.store = options.store ?? createBotStore();
		this.clock = options.clock ?? systemClock;
		this.timer = options.timer ?? systemTimer;
		this.channels = new ChannelRegistry({ clock: () => this.clock.now() });
		for (const config of options.robs) {
			this.robs.set(config.name, this.createRob(config));
			this.wakes.set(config.name, config.wake ?? null);
		}
	}

	// Adds a rob at runtime and starts its loop when the team is already
	// running. A duplicate name is an error; the caller validates first.
	addRob(config: RobConfig): void {
		if (this.robs.has(config.name)) {
			throw new DuplicateRobError(config.name);
		}
		const rob = this.createRob(config);
		this.robs.set(config.name, rob);
		this.wakes.set(config.name, config.wake ?? null);
		if (this.started && !this.stopping) {
			this.loops.set(config.name, rob.run());
			this.armWake(config.name, config.wake ?? null);
		}
	}

	// Removes a rob at runtime: its wake timer is disarmed, its loop stops, it
	// leaves every map, and any approval it is still waiting on is denied so a
	// turn cannot hang. An unknown name is UnknownRobError, so the caller never
	// deletes a rob the roster never had.
	removeRob(name: string): void {
		const rob = this.requireRob(name);
		this.disarmWake(name);
		rob.stop();
		this.approvals.denyRob(name, ROB_REMOVED_REASON);
		this.robs.delete(name);
		this.wakes.delete(name);
		this.loops.delete(name);
	}

	// Replaces a rob's config in place: the old runtime is stopped and a fresh
	// one is built from the new config, keeping the same name and, unless the
	// config carries its own, the same wake. start/stop/addRob are untouched.
	updateRob(config: RobConfig): void {
		const existing = this.requireRob(config.name);
		this.disarmWake(config.name);
		existing.stop();
		this.approvals.denyRob(config.name, TURN_INTERRUPTED_REASON);
		const rob = this.createRob(config);
		this.robs.set(config.name, rob);
		const wake = config.wake ?? this.wakes.get(config.name) ?? null;
		this.wakes.set(config.name, wake);
		if (this.started && !this.stopping) {
			this.loops.set(config.name, rob.run());
			this.armWake(config.name, wake);
		}
	}

	private disarmWake(name: RobName): void {
		const cancel = this.wakeTimers.get(name);
		if (cancel === undefined) return;
		cancel();
		this.wakeTimers.delete(name);
	}

	private createRob(config: RobConfig): Rob {
		return new Rob({
			name: config.name,
			role: config.role,
			rules: resolveRobRules(this.options.permissions ?? {}, config),
			model: config.model ?? this.options.defaultModel,
			provider: this.options.providerFactory(config),
			workspaceRoot: this.options.workspaceRoot,
			authorizerFactory: this.options.authorizerFactory,
			team: this,
			backend: config.backend,
			providerEnv: this.options.providerEnv,
			extraTools: this.options.extraTools,
			hooks: this.options.hooks,
			store: this.store,
			channels: this.channels,
			clock: () => this.clock.now(),
		});
	}

	subscribe(listener: TeamListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		for (const [name, rob] of this.robs) {
			this.loops.set(name, rob.run());
		}
		for (const [name, wake] of this.wakes) {
			this.armWake(name, wake);
		}
	}

	// The timer only knows a bot name and a prompt; the wake reaches the rob as
	// an ordinary inbound, so the turn plumbing is untouched.
	private armWake(name: RobName, wake: RobConfig["wake"] | null): void {
		if (wake === undefined || wake === null) return;
		const cancel = this.timer.schedule(
			{ bot: name, everyMs: wake.everyMs, text: wake.prompt },
			(interval) => this.onWake(interval),
		);
		this.wakeTimers.set(name, cancel);
	}

	// Replaces the live schedule in place: cancel whatever is armed, record the
	// new config, then arm it (or nothing). start/stop/addRob are untouched.
	setWake(name: RobName, wake: RobConfig["wake"] | null): void {
		this.requireRob(name);
		const cancel = this.wakeTimers.get(name);
		if (cancel !== undefined) {
			cancel();
			this.wakeTimers.delete(name);
		}
		this.wakes.set(name, wake ?? null);
		if (wake !== undefined && wake !== null) this.armWake(name, wake);
	}

	// The wake the live timer was armed from; null when the rob has none.
	robWake(name: RobName): RobConfig["wake"] | null {
		this.requireRob(name);
		return this.wakes.get(name) ?? null;
	}

	// The rob's current session label; reading it lazily opens the first channel,
	// exactly as a turn would, so a transcript read never disagrees with commit.
	currentChannel(name: RobName): ChannelSession {
		this.requireRob(name);
		return this.channels.current(name);
	}

	private onWake(wake: Wake): void {
		const rob = this.robs.get(wake.bot);
		if (rob === undefined) return;
		this.emitNotice(wake.bot, "woke on interval");
		rob.deliver({
			kind: "interval",
			from: "scheduler",
			text: wake.text,
			at: wake.at,
		});
	}

	dispatch(name: string, text: string, images?: ImagePart[]): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now(), images });
	}

	interject(name: string, text: string): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now() });
	}

	readDms(): readonly DmEntry[] {
		return this.dms.map((entry) => ({ ...entry }));
	}

	readSubagents(robName?: string): readonly SubagentEntry[] {
		const entries =
			robName === undefined
				? this.subagents
				: this.subagents.filter((entry) => entry.parent === robName);
		return entries.map((entry) => structuredClone(entry));
	}

	statuses(): readonly RobStatusEntry[] {
		return [...this.robs.values()].map((rob) => rob.statusSnapshot());
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const cancel of this.wakeTimers.values()) {
			cancel();
		}
		this.wakeTimers.clear();
		this.approvals.denyAll(TEAM_STOPPED_REASON);
		for (const rob of this.robs.values()) {
			rob.stop();
		}
		await Promise.all([...this.loops.values()]);
	}

	// Ends the rob's current turn and keeps the rob alive for the next dispatch.
	interrupt(name: string): void {
		const rob = this.requireRob(name);
		rob.abortTurn();
		this.approvals.denyRob(name, TURN_INTERRUPTED_REASON);
	}

	hasRob(name: string): boolean {
		return this.robs.has(name);
	}

	// Opens a fresh session for the named rob: the live transcript is dropped and
	// the next committed turn carries the new channel id. Memory is untouched.
	openChannel(name: string): ChannelSession {
		const rob = this.requireRob(name);
		rob.openChannel();
		const session = this.channels.current(name);
		this.emit({ kind: "channel", bot: name, session });
		return session;
	}

	// Closes the named session when it is the rob's current one, then opens a
	// fresh one. Returns whether the id matched.
	closeChannel(name: string, id: string): boolean {
		const rob = this.requireRob(name);
		if (this.channels.current(name).id !== id) return false;
		rob.closeCurrentChannel();
		this.emit({
			kind: "channel",
			bot: name,
			session: this.channels.current(name),
		});
		return true;
	}

	listChannels(name: string): readonly ChannelSession[] {
		this.requireRob(name);
		return this.channels.list(name);
	}

	// Loads the ledger, replays the named session into the rob's live transcript,
	// and makes it current so the next turn continues the same session id. The
	// store is the only durable source; the registry only holds the label.
	async loadChannel(name: string, id: string): Promise<LoadChannelResult> {
		const rob = this.requireRob(name);
		const loaded = await this.store.load(name, {
			role: rob.role,
			model: rob.model,
		});
		if (!loaded.ok) return loaded;
		const turns = loaded.record.turns.filter((turn) => turn.sessionId === id);
		if (turns.length === 0) {
			return { ok: false, error: `Unknown session: ${id}` };
		}
		rob.loadChannelHistory(turns);
		this.emit({
			kind: "channel",
			bot: name,
			session: this.channels.current(name),
		});
		return {
			ok: true,
			messages: replay(turns, this.options.workspaceRoot, id),
		};
	}

	postDm(from: RobName, to: RobName, text: string): void {
		const at = Date.now();
		const entry: DmEntry = { from, to, text, at };
		this.dms.push(entry);
		this.emit({ kind: "dm", entry: { ...entry } });
		this.robs.get(to)?.deliver({ kind: "dm", from, text, at });
	}

	recordSubagent(entry: SubagentEntry): void {
		this.subagents.push(entry);
		this.emit({ kind: "subagent", entry: structuredClone(entry) });
	}

	requestApproval(
		rob: RobName,
		request: ApprovalRequest,
	): Promise<ApprovalDecision> {
		const target = this.requireRob(rob);
		// A rob mid-authorize can ask after stop began denying; enqueueing then
		// would wait forever and hang stop(), so deny it here.
		if (this.stopping) {
			return Promise.resolve({ deny: TEAM_STOPPED_REASON });
		}
		const enqueued = this.approvals.request(rob, request, {
			timeoutMs: this.options.approvalTimeoutMs,
		});
		target.markWaitingApproval();
		this.emit({
			kind: "approval_requested",
			request: { ...enqueued.request },
			expiresAt: this.approvals.deadline(enqueued.id) ?? undefined,
		});
		return enqueued.decision.then((decision) => {
			this.emit({
				kind: "approval_resolved",
				id: enqueued.id,
				decision: toChoice(decision),
			});
			target.markWorking();
			return decision;
		});
	}

	resolveApproval(id: string, decision: ApprovalDecision): void {
		this.approvals.resolve(id, decision);
	}

	// When the queue denies this request unanswered, or null while it is still
	// queued behind another one.
	approvalDeadline(id: string): number | null {
		return this.approvals.deadline(id);
	}

	emitRobEvent(rob: RobName, event: AgentEvent): void {
		this.emit({ kind: "rob_event", rob, event: structuredClone(event) });
	}

	emitStatus(rob: RobName, status: RobStatus): void {
		this.emit({ kind: "rob_status", rob, status });
	}

	emitNotice(rob: RobName, text: string): void {
		this.emit({ kind: "notice", rob, text });
	}

	private emit(event: TeamEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private requireRob(name: string): Rob {
		const rob = this.robs.get(name);
		if (rob === undefined) throw new UnknownRobError(name);
		return rob;
	}
}

function toChoice(decision: ApprovalDecision): ApprovalChoice {
	if (typeof decision === "object") return "deny";
	return decision;
}

// One merge for the authorizer and the cli tool allowlist, so a rob's effective
// rules cannot differ between the two.
function resolveRobRules(
	project: PermissionRules,
	rob: RobConfig,
): PermissionRules {
	return {
		...defaultRules(),
		...robToolRules(),
		...project,
		...rob.permissions,
	};
}
