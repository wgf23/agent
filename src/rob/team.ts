import { randomBytes } from "node:crypto";
import { WORKSPACE_BOT } from "../../shared/protocol.js";
import type { AgentEvent } from "../agent/events.js";
import { ChannelRegistry, type ChannelSession } from "../bot/channel.js";
import { replay } from "../bot/record.js";
import { type BotStore, createBotStore } from "../bot/store.js";
import type { HooksConfig } from "../hooks/hooks.js";
import type {
	ApprovalChoice,
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import { defaultRules, type PermissionRules } from "../permissions/rules.js";
import type { ImagePart, Message, Provider } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { ApprovalQueue } from "./approvals.js";
import { writeRoomDeliverable } from "./deliverable.js";
import type { TeamEvent, TeamListener } from "./events.js";
import {
	startTeamGateway,
	type TeamBridge,
	type TeamGateway,
} from "./gateway/server.js";
import { gatewayEnv } from "./gateway/wire.js";
import { type AuthorizerFactory, Rob } from "./rob.js";
import {
	Room,
	type RoomConfig,
	type RoomCreateOutcome,
	type RoomHost,
	type RoomLedger,
	type RoomMembershipOutcome,
	type RoomName,
	type RoomReplyOutcome,
	type RoomSendOutcome,
	type RoomState,
	type RoomTurn,
	type RoomTurnResult,
	type RoomView,
	roomConfigSchema,
	validateRoomCoordinator,
	validateRoomMembers,
} from "./room.js";
import {
	createRoomStore,
	ledgerFor,
	newRoomState,
	type RoomStore,
	type StoredRoom,
} from "./room-store.js";
import { renderConfigDrift, renderStorageFailure } from "./room-text.js";
import {
	createTeamOperations,
	robToolRules,
	roomTools,
	teamTools,
} from "./tools.js";
import type {
	BridgePort,
	DeliveryOutcome,
	DmEntry,
	RobConfig,
	RobName,
	RobStatus,
	RobStatusEntry,
	SubagentEntry,
	Teammate,
	TeamPort,
	TurnHost,
} from "./types.js";

export const TEAM_STOPPED_REASON =
	"The team stopped before this approval was answered.";

export const TURN_INTERRUPTED_REASON =
	"The turn was interrupted before the approval was answered.";

// The gap between polls for a rob that is finishing an earlier turn.
const ROOM_TURN_POLL_MS = 10;

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
	rooms?: readonly RoomConfig[];
	// An unanswered approval expires and is denied after this long, so a rob
	// cannot wait on an approval nobody answers. Defaults in ApprovalQueue.
	approvalTimeoutMs?: number;
	// Optional so existing callers keep compiling; a team without an injected
	// store still gets the durable global ledger.
	store?: BotStore;
	clock?: () => number;
}

export type LoadChannelResult =
	| { ok: true; messages: Message[] }
	| { ok: false; error: string };

interface SessionRecord {
	readonly rob: RobName;
	readonly secret: string;
	active: TeamBridge | null;
}

/** Internal: one room turn waiting for the bridge that carries it. The room's
 *  serial loop and the between-turns wait guarantee at most one per rob. */
interface PendingRoomTurn {
	readonly room: RoomName;
	resolve(result: RoomTurnResult): void;
}

export class Team implements TeamPort {
	private readonly options: TeamOptions;
	private readonly robs = new Map<RobName, Rob>();
	private readonly loops = new Map<RobName, Promise<void>>();
	private readonly sessions = new Map<RobName, SessionRecord>();
	private readonly dms: DmEntry[] = [];
	private readonly subagents: SubagentEntry[] = [];
	private readonly store: BotStore;
	// One registry for the whole team, so every rob shares the same channel
	// bookkeeping and a bot can only ever be current in one place.
	private readonly channels: ChannelRegistry;
	private readonly approvals = new ApprovalQueue({
		// A queued request has no window until it becomes the head, so re-emit
		// it the moment it does: a client counting down needs the deadline, not
		// the fact that one exists.
		onArm: (request, expiresAt) => {
			this.emit({ kind: "approval_requested", request, expiresAt });
		},
	});
	private readonly listeners = new Set<TeamListener>();
	private readonly roomRegistry = new Map<RoomName, Room>();
	private readonly roomTurns = new Map<RobName, PendingRoomTurn>();
	private readonly roomStore: RoomStore;
	// The room's only persistence handle; built once from the store.
	private readonly roomLedger: RoomLedger;
	private readonly startupProblems: string[] = [];
	private readonly roomHost: RoomHost = {
		members: () => [...this.robs.keys()],
		now: () => Date.now(),
		emit: (event) => this.emit({ kind: "room", event }),
		runTurn: (member, turn) => this.runRoomTurn(member, turn),
		writeDeliverable: (draft) =>
			writeRoomDeliverable(this.options.workspaceRoot, draft),
	};
	private gateway: { port: TeamGateway; started: Promise<void> } | null = null;
	private started = false;
	private stopping = false;

	constructor(options: TeamOptions) {
		this.options = options;
		this.store = options.store ?? createBotStore();
		this.channels = new ChannelRegistry({ clock: options.clock });
		for (const config of options.robs) {
			this.robs.set(config.name, this.createRob(config));
		}
		this.roomStore = createRoomStore({
			workspaceRoot: options.workspaceRoot,
		});
		this.roomLedger = ledgerFor(this.roomStore);
		this.openRooms();
	}

	// Adds a rob at runtime and starts its loop when the team is already
	// running. A duplicate name is an error; the caller validates first.
	addRob(config: RobConfig): void {
		if (this.robs.has(config.name)) {
			throw new DuplicateRobError(config.name);
		}
		const rob = this.createRob(config);
		this.robs.set(config.name, rob);
		if (this.started && !this.stopping) {
			this.loops.set(config.name, rob.run());
		}
	}

	private createRob(config: RobConfig): Rob {
		this.sessions.set(config.name, {
			rob: config.name,
			secret: randomBytes(24).toString("hex"),
			active: null,
		});
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
			clock: this.options.clock,
		});
	}

	/** One synchronous pass over the union of configured rooms and ledgers: a
	 *  ledger is the room's state once it exists, and only a room with no
	 *  ledger is seeded from config (and writes its first ledger). */
	private openRooms(): void {
		const seeded = new Map<RoomName, RoomConfig>();
		for (const config of this.options.rooms ?? []) {
			if (seeded.has(config.name)) {
				throw new Error(`Duplicate room "${config.name}" in TeamOptions.`);
			}
			seeded.set(config.name, config);
		}
		const { records, failed } = this.roomStore.readAll();
		const ledgers = new Map(records.map((record) => [record.name, record]));
		const names = new Set<string>([
			...seeded.keys(),
			...ledgers.keys(),
			...failed.map((entry) => entry.name),
		]);
		for (const name of names) {
			const config = seeded.get(name);
			const record = ledgers.get(name);
			if (record !== undefined) {
				const { version, workspaceRoot, updatedAt, ...state } = record;
				this.roomRegistry.set(
					name,
					new Room({
						state,
						host: this.roomHost,
						ledger: this.roomLedger,
						notice:
							config === undefined ? undefined : configDrift(config, record),
					}),
				);
				continue;
			}
			const read = this.roomStore.read(name);
			if (config === undefined) {
				// A runtime-created room whose ledger cannot be read: its file is
				// left in place and the problem is reported once, at start().
				const reason = read.ok
					? "the ledger disappeared between listing and reading"
					: read.error;
				this.startupProblems.push(
					`Room "${name}" could not be read (${reason}); its file was left in place.`,
				);
				continue;
			}
			const room = new Room({
				state: this.seedState(name, config),
				host: this.roomHost,
				ledger: this.roomLedger,
				notice: read.ok ? undefined : renderStorageFailure(read.error),
			});
			this.roomRegistry.set(name, room);
			this.offerSeed(room);
		}
	}

	/** Validates a config room before it becomes a seed, preserving the v1
	 *  constructor guard for callers that build TeamOptions directly. */
	private seedState(name: RoomName, config: RoomConfig): RoomState {
		const parsed = roomConfigSchema.safeParse(config);
		if (!parsed.success) {
			throw new Error(`Invalid room "${name}" in TeamOptions: invalid_name.`);
		}
		if (this.robs.has(name)) {
			throw new Error(`Invalid room "${name}" in TeamOptions: name_taken.`);
		}
		const validation = validateRoomMembers(parsed.data.members, [
			...this.robs.keys(),
		]);
		if (validation.status === "rejected") {
			throw new Error(
				`Invalid room "${name}" in TeamOptions: ${validation.reason}.`,
			);
		}
		const coordinator = validateRoomCoordinator(
			parsed.data.coordinator,
			validation.members,
		);
		if (coordinator.status === "rejected") {
			throw new Error(
				`Invalid room "${name}" in TeamOptions: ${coordinator.reason}.`,
			);
		}
		return newRoomState(
			name,
			this.roomHost.now(),
			validation.members,
			parsed.data.coordinator ?? null,
		);
	}

	/** The first ledger write. A failure is left to the room's next save, which
	 *  reports it in the transcript; startup must not throw. */
	private offerSeed(room: Room): void {
		void this.roomLedger.save(room.state()).catch(() => undefined);
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
		void this.ensureGateway().catch(() => undefined);
		for (const [name, rob] of this.robs) {
			this.loops.set(name, rob.run());
		}
		// Listeners subscribe before start() (TeamHub, runTeamCommand), so the
		// startup problems reach them; no new TeamEvent arm is needed.
		for (const text of this.startupProblems) {
			this.emit({ kind: "notice", rob: WORKSPACE_BOT, text });
		}
		for (const room of this.roomRegistry.values()) {
			room.resume();
		}
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

	// Opens a fresh session for the named rob: the live transcript is dropped and
	// the next committed turn carries the new channel id. Memory is untouched.
	openChannel(name: string): ChannelSession {
		const rob = this.requireRob(name);
		rob.openChannel();
		return this.channels.current(name);
	}

	// Closes the named session when it is the rob's current one, then opens a
	// fresh one. Returns whether the id matched.
	closeChannel(name: string, id: string): boolean {
		const rob = this.requireRob(name);
		if (this.channels.current(name).id !== id) return false;
		rob.closeCurrentChannel();
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
		return {
			ok: true,
			messages: replay(turns, this.options.workspaceRoot, id),
		};
	}

	/** Creates a room, validating the name against the roster and every member
	 *  through validateRoomMembers. The only place a Room is constructed. */
	createRoom(config: RoomConfig): RoomCreateOutcome {
		if (this.stopping) return { status: "rejected", reason: "team_stopped" };
		const parsed = roomConfigSchema.safeParse(config);
		if (!parsed.success) return { status: "rejected", reason: "invalid_name" };
		const { name, members, coordinator } = parsed.data;
		if (this.roomRegistry.has(name))
			return { status: "rejected", reason: "duplicate" };
		if (this.robs.has(name))
			return { status: "rejected", reason: "name_taken" };
		const validation = validateRoomMembers(members, [...this.robs.keys()]);
		if (validation.status === "rejected") return validation;
		const coordinatorCheck = validateRoomCoordinator(
			coordinator,
			validation.members,
		);
		if (coordinatorCheck.status === "rejected") return coordinatorCheck;
		const room = new Room({
			state: newRoomState(
				name,
				this.roomHost.now(),
				validation.members,
				coordinator ?? null,
			),
			host: this.roomHost,
			ledger: this.roomLedger,
		});
		this.roomRegistry.set(name, room);
		this.emit({
			kind: "room",
			event: { kind: "members", room: name, members: validation.members },
		});
		this.offerSeed(room);
		return { status: "created", room: room.view() };
	}

	rooms(): readonly RoomView[] {
		return [...this.roomRegistry.values()].map((room) => room.view());
	}

	sendToRoom(room: RoomName, text: string): RoomSendOutcome {
		const target = this.roomRegistry.get(room);
		if (target === undefined) {
			return { status: "rejected", reason: "unknown_room" };
		}
		return target.send(text);
	}

	setRoomMembers(
		room: RoomName,
		members: readonly RobName[],
	): RoomMembershipOutcome {
		const target = this.roomRegistry.get(room);
		if (target === undefined) {
			return { status: "rejected", reason: "unknown_room" };
		}
		return target.setMembers(members);
	}

	interruptRoom(room: RoomName): void {
		this.roomRegistry.get(room)?.interrupt();
	}

	/** True while any room runs or any rob is mid-turn. A provider swap is gated
	 *  on this so a rebuild cannot land between two rounds. */
	busy(): boolean {
		for (const room of this.roomRegistry.values()) {
			if (room.view().run.phase === "running") return true;
		}
		return this.statuses().some(
			(entry) =>
				entry.status === "working" || entry.status === "waiting_approval",
		);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.approvals.denyAll(TEAM_STOPPED_REASON);
		// Rooms first: a live room turn resolves only after its rob's turn ends,
		// so stopping robs first would leave the room waiting on a dead rob.
		await Promise.all(
			[...this.roomRegistry.values()].map((room) => room.stop()),
		);
		for (const rob of this.robs.values()) {
			rob.stop();
		}
		await Promise.all([...this.loops.values()]);
		if (this.gateway !== null) {
			const { port } = this.gateway;
			this.gateway = null;
			await port.stop();
		}
	}

	// Ends the rob's current turn and keeps the rob alive for the next dispatch.
	interrupt(name: string): void {
		const rob = this.requireRob(name);
		rob.abortTurn();
		this.approvals.denyRob(name, TURN_INTERRUPTED_REASON);
	}

	/** Opens the bridge for one turn of `rob`. Rejects a second concurrent turn
	 *  and resolves only once the gateway is listening. A pending room turn for
	 *  the rob decides whether this bridge also serves that room's reply tool. */
	async beginTurn(rob: RobName, host: TurnHost): Promise<BridgePort> {
		const session = this.sessions.get(rob);
		if (session === undefined) throw new UnknownRobError(rob);
		const gateway = await this.ensureGateway();
		// The check and the claim share one synchronous block after the await,
		// so two callers cannot both pass the check.
		if (session.active !== null) {
			throw new Error(`Rob "${rob}" already has a turn in flight.`);
		}
		const pending = this.roomTurns.get(rob);
		const bridge = this.createBridge(
			session,
			host,
			gateway.socketPath,
			pending?.room,
		);
		session.active = bridge;
		return bridge;
	}

	roster(): readonly Teammate[] {
		return [...this.robs.values()].map((rob) => ({
			name: rob.name,
			role: rob.role,
		}));
	}

	postDm(from: RobName, to: RobName, text: string): DeliveryOutcome {
		if (from === to) return { status: "rejected", reason: "self" };
		const target = this.robs.get(to);
		if (target === undefined) {
			return { status: "rejected", reason: "unknown_target" };
		}
		if (this.stopping) return { status: "rejected", reason: "team_stopped" };
		const at = Date.now();
		const entry: DmEntry = { from, to, text, at };
		this.dms.push(entry);
		this.emit({ kind: "dm", entry: { ...entry } });
		target.deliver({ kind: "dm", from, text, at });
		return { status: "queued" };
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

	private ensureGateway(): Promise<TeamGateway> {
		if (this.gateway === null) {
			const port = startTeamGateway({
				lookup: (secret) => this.bridgeForSecret(secret),
			});
			const started = port.start();
			// start() fires this off without awaiting, so keep a rejection from
			// surfacing there; beginTurn still awaits and reports it.
			void started.catch(() => undefined);
			this.gateway = { port, started };
		}
		const { port, started } = this.gateway;
		return started.then(() => port);
	}

	private bridgeForSecret(secret: string): TeamBridge | null | undefined {
		for (const session of this.sessions.values()) {
			if (session.secret === secret) return session.active;
		}
		return undefined;
	}

	private createBridge(
		session: SessionRecord,
		host: TurnHost,
		socketPath: string,
		room?: RoomName,
	): TeamBridge {
		const operations = createTeamOperations({
			team: this,
			from: session.rob,
			runSubagent: host.runSubagent,
		});
		const tools =
			room === undefined
				? teamTools(operations)
				: [
						...teamTools(operations),
						...roomTools({
							room,
							reply: (text) => this.replyToRoom(room, session.rob, text),
						}),
					];
		let closed = false;

		const bridge: TeamBridge = {
			rob: session.rob,
			tools,
			roster: () =>
				this.roster().filter((teammate) => teammate.name !== session.rob),
			childEnv: () => gatewayEnv({ socketPath, secret: session.secret }),
			close: () => {
				if (closed) return;
				closed = true;
				if (session.active === bridge) session.active = null;
				this.finishRoomTurn(session.rob, room);
			},
			invoke: async (toolName, args) => {
				if (closed) {
					return {
						ok: false,
						reason: "turn_closed",
						text: "The turn ended before this call was served.",
					};
				}
				const tool = tools.find((candidate) => candidate.name === toolName);
				if (tool === undefined) {
					return {
						ok: false,
						reason: "unknown_tool",
						text: `Unknown team tool: ${toolName}`,
					};
				}
				const schema = tool.schema;
				const parsed =
					schema === undefined ? undefined : schema.safeParse(args);
				if (parsed !== undefined && !parsed.success) {
					return {
						ok: false,
						reason: "invalid_args",
						text: `Invalid arguments for ${toolName}.`,
					};
				}
				const callArgs = parsed?.success === true ? parsed.data : args;
				const decision = await host.authorize(
					{ id: `team-${toolName}`, name: toolName, args: callArgs },
					tool,
				);
				if (!decision.allowed) {
					return { ok: false, reason: "denied", text: decision.reason };
				}
				try {
					return await tool.run(callArgs, {
						workspaceRoot: host.workspaceRoot,
						signal: host.signal,
					});
				} catch (error) {
					return {
						ok: false,
						reason: "failed",
						text: `The ${toolName} call failed: ${errorMessage(error)}`,
					};
				}
			},
		};
		return bridge;
	}

	/** The room_reply path for a bridge bound to `room`. Rooms are never
	 *  deleted, so a miss is a stale bridge; "stopped" is the safe outcome. */
	private replyToRoom(
		room: RoomName,
		from: RobName,
		text: string,
	): RoomReplyOutcome {
		const target = this.roomRegistry.get(room);
		if (target === undefined) {
			return { status: "rejected", reason: "stopped" };
		}
		return target.post(from, text);
	}

	/** Resolves the pending room turn once the bridge that carried it closes. */
	private finishRoomTurn(rob: RobName, room: RoomName | undefined): void {
		if (room === undefined) return;
		const pending = this.roomTurns.get(rob);
		if (pending === undefined || pending.room !== room) return;
		this.roomTurns.delete(rob);
		pending.resolve("completed");
	}

	/** Delivers one room turn to its member and resolves when that turn's bridge
	 *  closes, or when the room aborts the turn and the rob is interrupted. */
	private async runRoomTurn(
		member: RobName,
		turn: RoomTurn,
	): Promise<RoomTurnResult> {
		if (!(await this.waitForBetweenTurns(member, turn.signal))) {
			return "stopped";
		}
		return await new Promise<RoomTurnResult>((resolve) => {
			let settled = false;
			const settle = (result: RoomTurnResult): void => {
				if (settled) return;
				settled = true;
				turn.signal.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = (): void => {
				// The pending entry stays: if this turn still starts, beginTurn
				// must bind room_reply so the inbound is never without a channel.
				this.interrupt(member);
				settle("stopped");
			};
			const pending: PendingRoomTurn = { room: turn.room, resolve: settle };
			this.roomTurns.set(member, pending);
			turn.signal.addEventListener("abort", onAbort, { once: true });
			if (turn.signal.aborted) {
				onAbort();
				return;
			}
			this.requireRob(member).deliver({
				kind: "room",
				from: turn.room,
				text: turn.text,
				at: Date.now(),
			});
		});
	}

	// The rob's loop emits status changes but not an inbox drain, so waiting for
	// a turn boundary is a poll. The check and the delivery share one synchronous
	// block after the last await, so no other turn can slip in between them.
	private async waitForBetweenTurns(
		member: RobName,
		signal: AbortSignal,
	): Promise<boolean> {
		while (!signal.aborted) {
			const rob = this.robs.get(member);
			if (rob === undefined) return false;
			const snapshot = rob.statusSnapshot();
			if (snapshot.status === "idle" && snapshot.pending === 0) return true;
			await sleep(ROOM_TURN_POLL_MS);
		}
		return false;
	}

	private requireRob(name: string): Rob {
		const rob = this.robs.get(name);
		if (rob === undefined) throw new UnknownRobError(name);
		return rob;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Names the fields where my-agent.json and an existing ledger disagree. The
 *  ledger wins, so this only feeds one system entry; no config value is
 *  applied to a room that already exists. */
function configDrift(
	config: RoomConfig,
	record: StoredRoom,
): string | undefined {
	const differences: string[] = [];
	if (!sameNames(config.members, record.members)) {
		differences.push(
			`members are now ${record.members.join(", ")}, not ${config.members.join(", ")}`,
		);
	}
	const coordinator = config.coordinator ?? null;
	if (coordinator !== record.coordinator) {
		differences.push(
			`coordinator is now ${record.coordinator ?? "none"}, not ${coordinator ?? "none"}`,
		);
	}
	return differences.length === 0 ? undefined : renderConfigDrift(differences);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((name, index) => name === right[index])
	);
}
