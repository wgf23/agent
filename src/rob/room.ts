import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import {
	parseRoomMentions,
	ROOM_PASS_SENTINEL,
	renderAbsentMembers,
	renderDeliverableFailure,
	renderDeliverableNotice,
	renderRestartNotice,
	renderRoomTurn,
	renderRoomWrapUp,
	renderStorageFailure,
} from "./room-text.js";
import { type RobName, robNameSchema } from "./types.js";

/** Rooms and robs share one name rule, so a mention or a selection list can
 *  never be ambiguous between the two. */
export const roomNameSchema = robNameSchema;
export type RoomName = RobName;

// The Hermes defaults, declared once. They travel to surfaces inside
// RoomView.limits, so no TUI or web module re-declares them.
export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 6;
export const ROOM_MAX_ROUNDS = 3;
export const ROOM_MAX_MESSAGES_PER_RUN = 10;
export const ROOM_MAX_QUEUED_SENDS = 5;
export const ROOM_TURN_TIMEOUT_MS = 120_000;
export const ROOM_RUN_TIMEOUT_MS = 300_000;

/** The coordinator gets one turn to write the deliverable after the room runs
 *  out of conversation; the run deadline still caps it. */
export const ROOM_WRAP_UP_TIMEOUT_MS = 180_000;

/** How much of a member's unseen history one room turn carries. Older entries
 *  are dropped, not replayed, so a long room still hands over a bounded prompt. */
export const ROOM_MAX_UNSEEN_ENTRIES = 20;

/** "user" and "system" are the transcript's own voices; refusing them as member
 *  names is what keeps an entry's speaker unambiguous. */
export const RESERVED_ROOM_SPEAKERS = ["user", "system"] as const;

/** One room as config states it. The file shape and the runtime shape are the
 *  same, so Team.createRoom takes the validated value directly. Which members
 *  exist, how many, and whether the coordinator is one of them is not a schema
 *  fact: validateRoomMembers and validateRoomCoordinator hold those. */
export const roomConfigSchema = z
	.object({
		name: roomNameSchema,
		members: z.array(robNameSchema),
		coordinator: robNameSchema.optional(),
	})
	.strict();
export type RoomConfig = z.infer<typeof roomConfigSchema>;

/** One user send waiting for the live run to end. The entry is already in the
 *  transcript; only the run it would start is deferred, so the queue stores an
 *  id and never a second copy of the text. */
export interface QueuedSend {
	readonly entryId: number;
	readonly at: number;
}

export const queuedSendSchema: z.ZodType<QueuedSend> = z.object({
	entryId: z.number(),
	at: z.number(),
});

/** One shared, id-ordered transcript row. Ids are assigned by the room, monotonic,
 *  never reused; a surface that applies `entry` events cannot reorder a room. */
export type RoomEntry =
	| {
			readonly id: number;
			readonly at: number;
			readonly kind: "user";
			readonly text: string;
	  }
	| {
			readonly id: number;
			readonly at: number;
			readonly kind: "member";
			readonly from: RobName;
			readonly text: string;
	  }
	| {
			readonly id: number;
			readonly at: number;
			readonly kind: "system";
			readonly text: string;
	  };

// Typed against the union so the schema and the type fail together when either
// changes; the ledger is the only untrusted input and parses through this.
export const roomEntrySchema: z.ZodType<RoomEntry> = z.discriminatedUnion(
	"kind",
	[
		z.object({
			id: z.number(),
			at: z.number(),
			kind: z.literal("user"),
			text: z.string(),
		}),
		z.object({
			id: z.number(),
			at: z.number(),
			kind: z.literal("member"),
			from: robNameSchema,
			text: z.string(),
		}),
		z.object({
			id: z.number(),
			at: z.number(),
			kind: z.literal("system"),
			text: z.string(),
		}),
	],
);

/** Where the last deliverable landed. `path` is workspace-relative. */
export interface RoomDeliverableRef {
	readonly at: number;
	readonly path: string;
	readonly coordinator: RobName;
}

export const deliverableRefSchema: z.ZodType<RoomDeliverableRef> = z.object({
	at: z.number(),
	path: z.string(),
	coordinator: robNameSchema,
});

/** What the room asks its host to write. Text and naming facts only: the room
 *  never sees the workspace path policy or the filesystem. `transcript` is the
 *  slice this run appended, which the room's own caps already bound. */
export interface RoomDeliverableDraft {
	readonly room: RoomName;
	readonly coordinator: RobName;
	readonly task: string; // mention-stripped body of the send that opened the run
	readonly outcome: RunOutcome;
	readonly participants: readonly RobName[];
	readonly transcript: readonly RoomEntry[];
	readonly body: string; // the coordinator's reply
	readonly at: number;
}

export type DeliverableOutcome =
	| { readonly status: "written"; readonly path: string }
	| { readonly status: "failed"; readonly reason: string };

/** The durable shape of one room: everything a restart needs, and nothing the
 *  scheduler can rebuild. `seen` cursors and the last outcome are not here on
 *  purpose; `runOpen` is only a marker that a run must not be restored. */
export interface RoomState {
	readonly name: RoomName;
	readonly createdAt: number;
	readonly members: readonly RobName[]; // membership order = turn order
	readonly coordinator: RobName | null; // null = no wrap-up step
	readonly transcript: readonly RoomEntry[];
	readonly queue: readonly QueuedSend[];
	readonly runOpen: boolean; // a run was live when this state was captured
	readonly deliverable: RoomDeliverableRef | null;
}

/** The room is idle or running exactly one bounded run; there is no third state. */
export type RoomRun =
	| { readonly phase: "idle" }
	| {
			readonly phase: "running";
			readonly round: number; // 1-based round in progress
			readonly rounds: number; // cap, echoed for surfaces
			readonly current: RobName | null; // whose turn is open
			readonly posted: number;
			readonly remaining: number; // cap minus posted
			readonly addressed: readonly RobName[]; // empty = everyone
	  };

export interface RoomLimits {
	readonly minMembers: number;
	readonly maxMembers: number;
	readonly maxRounds: number;
	readonly maxMessagesPerRun: number;
	readonly maxQueuedSends: number; // travels to surfaces, like the rest
}

/** The plain-data snapshot surfaces render. Fresh copies; callers never see the
 *  room's mutable state and never see the internal per-member cursors. */
export interface RoomView {
	readonly name: RoomName;
	readonly members: readonly RobName[]; // membership order = turn order
	readonly coordinator: RobName | null;
	readonly transcript: readonly RoomEntry[];
	readonly run: RoomRun;
	readonly pending: number; // queued sends, not entry ids
	readonly deliverable: RoomDeliverableRef | null;
	readonly limits: RoomLimits;
}

/** Why a run stopped. `settled` is the Hermes silence rule: one full round in
 *  which no member spoke. */
export type RunOutcome =
	| "settled"
	| "max_rounds"
	| "message_cap"
	| "run_timeout"
	| "interrupted"
	| "stopped"
	| "error";

/** The outcomes after which the coordinator is asked for a deliverable: the
 *  room finished thinking (settled) or spent its own budget (max_rounds,
 *  message_cap). Not interrupted/stopped/run_timeout/error: those are the
 *  user's or the host's decision. */
export function wantsDeliverable(outcome: RunOutcome): boolean {
	return (
		outcome === "settled" ||
		outcome === "max_rounds" ||
		outcome === "message_cap"
	);
}

export type TurnState = "replied" | "passed" | "timed_out" | "failed";

/** What the room tells the world. `entry` is the only way a row appears in a
 *  transcript; the rest annotates the run; `turn` is per-member outcome. */
export type RoomEvent =
	| {
			readonly kind: "entry";
			readonly room: RoomName;
			readonly entry: RoomEntry;
	  }
	| { readonly kind: "run"; readonly room: RoomName; readonly run: RoomRun }
	| {
			readonly kind: "run_ended";
			readonly room: RoomName;
			readonly run: RoomRun;
			readonly outcome: RunOutcome;
	  }
	| {
			readonly kind: "turn";
			readonly room: RoomName;
			readonly member: RobName;
			readonly round: number;
			readonly state: TurnState;
	  }
	| {
			readonly kind: "members";
			readonly room: RoomName;
			readonly members: readonly RobName[];
	  };

/** Machine-readable outcomes, in the shape DeliveryOutcome already uses. Text for
 *  models and users is rendered in one place (room-text.ts). `unknown_room` is
 *  produced by Team.sendToRoom, the only public sender. Sending never refuses
 *  because a run is live: the id is assigned and the entry appended in both
 *  live cases, so a "queued" send is a real message. */
export type RoomSendOutcome =
	| { readonly status: "started"; readonly entry: RoomEntry }
	| {
			readonly status: "queued";
			readonly entry: RoomEntry;
			readonly waiting: number; // queue length including this send
	  }
	| {
			readonly status: "rejected";
			readonly reason: "unknown_room" | "stopped" | "empty" | "queue_full";
	  };

/** The machine reasons a room reply can be refused; the gateway and the team
 *  tool carry them verbatim so no surface re-words a rejection. */
export type RoomReplyReason =
	| "not_a_member"
	| "not_your_turn"
	| "message_cap"
	| "stopped";

/** A `PASS` line is a pass, not a transcript entry, so it has its own status
 *  rather than wearing a rejection. */
export type RoomReplyOutcome =
	| { readonly status: "posted"; readonly entry: RoomEntry }
	| { readonly status: "passed" }
	| { readonly status: "rejected"; readonly reason: RoomReplyReason };

export type RoomMembershipReason =
	| "member_count"
	| "unknown_member"
	| "duplicate_member"
	| "reserved_member"
	| "unknown_room"
	| "busy";

export type RoomMembershipOutcome =
	| {
			readonly status: "ok";
			readonly members: readonly RobName[];
			/** The coordinator after the change; null when none, or when the
			 *  new list dropped the previous one. */
			readonly coordinator: RobName | null;
	  }
	| { readonly status: "rejected"; readonly reason: RoomMembershipReason };

export type RoomCreateReason =
	| "duplicate"
	| "invalid_name"
	| "name_taken"
	| "coordinator_not_member"
	| RoomMembershipReason
	| "team_stopped";

export type RoomCreateOutcome =
	| { readonly status: "created"; readonly room: RoomView }
	| { readonly status: "rejected"; readonly reason: RoomCreateReason };

/** The one membership rule, used by config load, Team.createRoom and
 *  Room.setMembers, so the three paths cannot drift. "busy" is a run-state fact
 *  and "unknown_room" a lookup fact; neither is a validation result. */
export function validateRoomMembers(
	members: readonly string[],
	roster: readonly RobName[],
):
	| { status: "ok"; members: readonly RobName[] }
	| {
			status: "rejected";
			reason: Exclude<RoomMembershipReason, "busy" | "unknown_room">;
	  } {
	if (members.length < ROOM_MIN_MEMBERS || members.length > ROOM_MAX_MEMBERS) {
		return { status: "rejected", reason: "member_count" };
	}
	const seen = new Set<string>();
	for (const member of members) {
		if ((RESERVED_ROOM_SPEAKERS as readonly string[]).includes(member)) {
			return { status: "rejected", reason: "reserved_member" };
		}
		if (seen.has(member)) {
			return { status: "rejected", reason: "duplicate_member" };
		}
		if (!roster.includes(member)) {
			return { status: "rejected", reason: "unknown_member" };
		}
		seen.add(member);
	}
	return { status: "ok", members: [...members] };
}

/** The coordinator rule, checked where a coordinator is *stated* (config load,
 *  createRoom). setMembers does not call it: there, dropping a member is a
 *  stated intent, so the coordinator is cleared and reported instead. */
export function validateRoomCoordinator(
	coordinator: RobName | undefined,
	members: readonly RobName[],
): { status: "ok" } | { status: "rejected"; reason: "coordinator_not_member" } {
	if (coordinator === undefined || members.includes(coordinator)) {
		return { status: "ok" };
	}
	return { status: "rejected", reason: "coordinator_not_member" };
}

export interface RoomTurn {
	readonly room: RoomName;
	readonly round: number;
	readonly text: string; // composed by renderRoomTurn
	/** Aborted when the room's turn budget or run budget expires, or when the
	 *  room stops; the host ends the turn and resolves once it fires. */
	readonly signal: AbortSignal;
}

export type RoomTurnResult =
	| "completed"
	| "timeout"
	| "stopped"
	| "unknown_member";

/** Everything the room needs from the live team. The room never sees Team, Rob,
 *  an Inbound, or a bridge; the team adapts at this seam. One method replaces
 *  polling: the room cannot advance until it knows the member's turn is over. */
export interface RoomHost {
	/** The live roster, in configuration order. */
	members(): readonly RobName[];
	/** Gives `member` one room turn and resolves when the turn that carried it has
	 *  closed. Implementations wait for the rob to be between turns first, bind the
	 *  room reply tool to the turn, and end the turn when `turn.signal` aborts. */
	runTurn(member: RobName, turn: RoomTurn): Promise<RoomTurnResult>;
	/** Writes the coordinator's deliverable into the workspace. The host owns
	 *  the path policy and the atomic write; the room only supplies the text. */
	writeDeliverable(draft: RoomDeliverableDraft): Promise<DeliverableOutcome>;
	emit(event: RoomEvent): void;
	now(): number;
}

/** The one persistence port. One method, whole-state: the file is never a
 *  partial patch, so no caller can write a room halfway. Team owns the store
 *  and hands the room this adapter; the room never touches the file itself. */
export interface RoomLedger {
	/** Orders and coalesces this room's writes. The promise settles when this
	 *  state or a newer one is on disk; it rejects with the write error. */
	save(state: RoomState): Promise<void>;
	/** Resolves when nothing is in flight; the room flushes on stop. */
	flush(): Promise<void>;
}

/** Internal: membership order plus how much of the transcript this member has
 *  already been shown. The cursor is the rob's room context, since Rob keeps one
 *  shared history and shares no state with the room. */
interface Member {
	readonly name: RobName;
	seen: number; // last entry id delivered to this member
}

/** Internal: one live run. Pure scheduler state; never leaves the room. */
interface LiveRun {
	round: number;
	readonly rounds: number;
	readonly addressed: readonly RobName[];
	readonly task: string; // mention-stripped send body, for the deliverable
	readonly taskEntryId: number; // the run's first transcript entry
	current: RobName | null;
	posted: number;
	spokeThisRound: number;
	repliedThisTurn: boolean;
	turnController: AbortController | null;
	/** The last entry id the prompt of the current turn can contain. Entries
	 *  appended after this while the turn is in flight (a queued send) must
	 *  stay unseen for members who were not shown them. */
	through: number;
	readonly deadline: number;
	wrapUp: boolean;
	reply: string | null; // the wrap-up turn's reply, if any
}

export class Room {
	readonly name: RoomName;

	private readonly host: RoomHost;
	private readonly ledger: RoomLedger;
	private readonly createdAt: number;
	private members: Member[];
	private coordinator: RobName | null;
	private readonly transcript: RoomEntry[];
	private readonly queue: QueuedSend[];
	private deliverable: RoomDeliverableRef | null;
	private nextId: number;
	private live: LiveRun | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	private storageFailed = false;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped: () => void = () => undefined;

	/** `state` is the ledger's record (validated by the store on load) or the
	 *  seed Team built from config; Team is the only constructor caller. A
	 *  notice and a still-open run both land as system entries, because the
	 *  room is the transcript's only writer. */
	constructor(options: {
		state: RoomState;
		host: RoomHost;
		ledger: RoomLedger;
		notice?: string;
	}) {
		this.name = options.state.name;
		this.host = options.host;
		this.ledger = options.ledger;
		this.createdAt = options.state.createdAt;
		this.members = options.state.members.map((name) => ({ name, seen: 0 }));
		this.coordinator = options.state.coordinator;
		this.transcript = options.state.transcript.map((entry) => ({ ...entry }));
		this.queue = options.state.queue.map((send) => ({ ...send }));
		this.deliverable =
			options.state.deliverable === null
				? null
				: { ...options.state.deliverable };
		this.nextId =
			this.transcript.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		if (options.notice !== undefined) {
			this.append({ kind: "system", text: options.notice });
		}
		if (options.state.runOpen) {
			this.append({ kind: "system", text: renderRestartNotice() });
		}
		if (options.notice !== undefined || options.state.runOpen) this.persist();
	}

	/** A fresh copy. The only read surface; no caller mutates room state. */
	view(): RoomView {
		return {
			name: this.name,
			members: this.memberNames(),
			coordinator: this.coordinator,
			transcript: this.transcript.map((entry) => ({ ...entry })),
			run: this.live === null ? { phase: "idle" } : this.runSnapshot(this.live),
			pending: this.queue.length,
			deliverable: this.deliverable === null ? null : { ...this.deliverable },
			limits: {
				minMembers: ROOM_MIN_MEMBERS,
				maxMembers: ROOM_MAX_MEMBERS,
				maxRounds: ROOM_MAX_ROUNDS,
				maxMessagesPerRun: ROOM_MAX_MESSAGES_PER_RUN,
				maxQueuedSends: ROOM_MAX_QUEUED_SENDS,
			},
		};
	}

	/** The durable shape, a fresh copy. `runOpen` marks a live run so load can
	 *  annotate it without restoring it. */
	state(): RoomState {
		return {
			name: this.name,
			createdAt: this.createdAt,
			members: this.memberNames(),
			coordinator: this.coordinator,
			transcript: this.transcript.map((entry) => ({ ...entry })),
			queue: this.queue.map((send) => ({ ...send })),
			runOpen: this.live !== null,
			deliverable: this.deliverable === null ? null : { ...this.deliverable },
		};
	}

	/** Appends the user's entry always; starts a run when idle, queues one when
	 *  a run is live. Only `empty` and `queue_full` refuse. */
	send(text: string): RoomSendOutcome {
		if (this.stopped) return { status: "rejected", reason: "stopped" };
		if (text.trim() === "") return { status: "rejected", reason: "empty" };
		if (this.live !== null && this.queue.length >= ROOM_MAX_QUEUED_SENDS) {
			return { status: "rejected", reason: "queue_full" };
		}

		const idle = this.live === null;
		const entry = this.append({ kind: "user", text });
		if (idle) {
			this.startRun(text, entry.id);
		} else {
			this.queue.push({ entryId: entry.id, at: this.host.now() });
		}
		this.persist();
		return idle
			? { status: "started", entry: { ...entry } }
			: {
					status: "queued",
					entry: { ...entry },
					waiting: this.queue.length,
				};
	}

	/** Starts the next queued send, if any. Idempotent: a no-op while stopped or
	 *  while a run is live, so Team.start and the run loop's tail can both call
	 *  it without coordination. The only drain path, so queued work never
	 *  overlaps a live run. */
	resume(): void {
		if (this.stopped || this.live !== null) return;
		const next = this.queue.shift();
		if (next === undefined) return;
		const entry = this.transcript.find((row) => row.id === next.entryId);
		if (entry?.kind !== "user") return; // ids only; a miss cannot happen
		this.startRun(entry.text, entry.id);
		this.persist();
	}

	/** The room_reply path. Accepts only the member whose turn is open, only while
	 *  a run is live, and only below the message cap. */
	post(from: RobName, text: string): RoomReplyOutcome {
		if (!this.isMember(from)) {
			return { status: "rejected", reason: "not_a_member" };
		}
		if (this.stopped) return { status: "rejected", reason: "stopped" };
		const run = this.live;
		if (run === null || run.current !== from) {
			return { status: "rejected", reason: "not_your_turn" };
		}
		// The wrap-up reply is the artifact, not another room message, so the
		// conversation's message cap does not gate it.
		if (run.posted >= ROOM_MAX_MESSAGES_PER_RUN && !run.wrapUp) {
			return { status: "rejected", reason: "message_cap" };
		}
		if (text.trim() === ROOM_PASS_SENTINEL) return { status: "passed" };

		const entry = this.append({ kind: "member", from, text });
		if (run.wrapUp) run.reply = text;
		run.posted += 1;
		run.spokeThisRound += 1;
		run.repliedThisTurn = true;
		this.persist();
		return { status: "posted", entry: { ...entry } };
	}

	/** Replaces membership wholesale (one way, not add/remove). Rejects while a
	 *  run is live so a round's participant list can never change under it. */
	setMembers(members: readonly string[]): RoomMembershipOutcome {
		if (this.live !== null) return { status: "rejected", reason: "busy" };
		const validation = validateRoomMembers(members, this.host.members());
		if (validation.status === "rejected") return validation;
		const cursors = new Map(
			this.members.map((member) => [member.name, member.seen]),
		);
		this.members = validation.members.map((name) => ({
			name,
			seen: cursors.get(name) ?? 0,
		}));
		if (
			this.coordinator !== null &&
			!validation.members.includes(this.coordinator)
		) {
			this.coordinator = null;
		}
		this.emit({
			kind: "members",
			room: this.name,
			members: this.memberNames(),
		});
		this.persist();
		return {
			status: "ok",
			members: this.memberNames(),
			coordinator: this.coordinator,
		};
	}

	/** Ends the live run with `interrupted`; the room stays usable. */
	interrupt(): void {
		if (this.live !== null) this.finish(this.live, "interrupted");
	}

	/** Terminal, idempotent. Resolves once the run loop has exited and the
	 *  ledger has no write in flight, so Team.stop cannot outrun the last
	 *  save before it stops the robs. */
	stop(): Promise<void> {
		if (this.stopped) return this.stoppedPromise;
		this.stopped = true;
		if (this.live !== null) this.finish(this.live, "stopped");
		void this.completeStop();
		return this.stoppedPromise;
	}

	private async completeStop(): Promise<void> {
		if (this.running !== null) await this.running.catch(() => undefined);
		await this.ledger.flush();
		this.resolveStopped();
	}

	private start(run: LiveRun): void {
		const task: Promise<void> = this.runRounds(run).finally(() => {
			if (this.running === task) this.running = null;
		});
		this.running = task;
	}

	/** One path for a fresh send and a dequeued send, so they cannot diverge. */
	private startRun(text: string, entryId: number): void {
		const mentions = parseRoomMentions(text, this.memberNames());
		const run: LiveRun = {
			round: 1,
			rounds: ROOM_MAX_ROUNDS,
			addressed: mentions.addressed,
			task: mentions.body,
			taskEntryId: entryId,
			current: null,
			posted: 0,
			spokeThisRound: 0,
			repliedThisTurn: false,
			turnController: null,
			through: 0,
			deadline: this.host.now() + ROOM_RUN_TIMEOUT_MS,
			wrapUp: false,
			reply: null,
		};
		// A member that left the team is not a participant; name any absentees
		// once, so a round that nobody can answer has an explanation.
		const wanted =
			run.addressed.length > 0 ? run.addressed : this.memberNames();
		const absent = wanted.filter((name) => !this.host.members().includes(name));
		if (absent.length > 0) {
			this.append({ kind: "system", text: renderAbsentMembers(absent) });
		}
		this.live = run;
		this.emitRun(run);
		this.start(run);
	}

	/** The run's tail: the coordinator's deliverable, then the finish, then the
	 *  queue. The tail is one of the two resume() callers, and resume() is a
	 *  no-op while a run is live, so a send that arrived mid-run cannot be lost
	 *  or overlapped. */
	private async runRounds(run: LiveRun): Promise<void> {
		let outcome: RunOutcome = "error";
		try {
			outcome = await this.rounds(run);
		} catch {
			outcome = "error";
		}
		if (this.live === run) {
			if (this.shouldWrapUp(run, outcome)) await this.wrapUp(run, outcome);
			if (this.live === run) this.finish(run, outcome);
		}
		if (!this.stopped) this.resume();
	}

	/** The v1 round loop verbatim, returning its reason instead of finishing. */
	private async rounds(run: LiveRun): Promise<RunOutcome> {
		while (this.live === run) {
			if (this.host.now() >= run.deadline) return "run_timeout";
			run.spokeThisRound = 0;
			for (const member of this.participants(run)) {
				if (this.live !== run) return "error";
				if (this.host.now() >= run.deadline) return "run_timeout";
				run.current = member.name;
				this.emitRun(run);
				const result = await this.takeTurn(run, member, {
					text: this.turnText(run, member),
					timeoutMs: ROOM_TURN_TIMEOUT_MS,
				});
				if (this.live !== run) return "error";
				run.current = null;
				member.seen = this.seenThrough(member, run.through);
				this.emitTurn(run, member.name, turnState(result, run.repliedThisTurn));
				if (result === "stopped") return "stopped";
				if (run.posted >= ROOM_MAX_MESSAGES_PER_RUN) return "message_cap";
			}
			if (run.spokeThisRound === 0) return "settled";
			if (run.round >= run.rounds) return "max_rounds";
			run.round += 1;
		}
		return "error";
	}

	private participants(run: LiveRun): readonly Member[] {
		const addressed = new Set(run.addressed);
		const roster = this.host.members();
		const members = this.members.filter((member) =>
			roster.includes(member.name),
		);
		if (addressed.size === 0) return members;
		return members.filter((member) => addressed.has(member.name));
	}

	/** One turn, whoever asked for it: a round turn and the wrap-up share the
	 *  controller, the deadline budget, the abort rule, and the reply binding. */
	private async takeTurn(
		run: LiveRun,
		member: Member,
		turn: { readonly text: string; readonly timeoutMs: number },
	): Promise<RoomTurnResult> {
		const controller = new AbortController();
		run.turnController = controller;
		run.repliedThisTurn = false;
		let expired = false;
		const budget = Math.min(
			turn.timeoutMs,
			Math.max(0, run.deadline - this.host.now()),
		);
		const timer = setTimeout(() => {
			expired = true;
			controller.abort();
		}, budget);
		run.through = this.nextId - 1;
		try {
			const result = await this.host.runTurn(member.name, {
				room: this.name,
				round: run.round,
				text: turn.text,
				signal: controller.signal,
			});
			return expired ? "timeout" : result;
		} catch (error) {
			if (expired) return "timeout";
			throw error;
		} finally {
			clearTimeout(timer);
			run.turnController = null;
		}
	}

	/** The last entry id this member has been shown, plus any they authored
	 *  after it. The plain v1 rule (`nextId - 1`) would swallow an entry that a
	 *  user appended while the turn was in flight, so the queued send's own run
	 *  would ask the member to answer something they never saw. */
	private seenThrough(member: Member, through: number): number {
		let seen = Math.max(member.seen, through);
		for (const entry of this.transcript) {
			if (entry.id <= seen) continue;
			if (entry.kind === "member" && entry.from === member.name) {
				seen = entry.id;
				continue;
			}
			break;
		}
		return seen;
	}

	/** The bounded window of entries this member has not been shown. Older
	 *  entries are dropped, not replayed, so a long room still hands over a
	 *  bounded prompt. */
	private unseenWindow(member: Member): {
		readonly unseen: readonly RoomEntry[];
		readonly truncated: boolean;
	} {
		const unseen = this.transcript.filter((entry) => entry.id > member.seen);
		const truncated = unseen.length > ROOM_MAX_UNSEEN_ENTRIES;
		return {
			unseen: truncated ? unseen.slice(-ROOM_MAX_UNSEEN_ENTRIES) : unseen,
			truncated,
		};
	}

	private turnText(run: LiveRun, member: Member): string {
		const { unseen, truncated } = this.unseenWindow(member);
		return renderRoomTurn({
			room: this.name,
			round: run.round,
			rounds: run.rounds,
			remaining: ROOM_MAX_MESSAGES_PER_RUN - run.posted,
			addressed: run.addressed,
			unseen,
			truncated,
		});
	}

	/** The wrap-up prompt, composed with the same bounded unseen window a round
	 *  turn uses. */
	private wrapUpText(
		run: LiveRun,
		member: Member,
		outcome: RunOutcome,
	): string {
		const { unseen, truncated } = this.unseenWindow(member);
		return renderRoomWrapUp({
			room: this.name,
			rounds: run.round,
			outcome,
			task: run.task,
			unseen,
			truncated,
		});
	}

	/** The deliverable is for a finished conversation: the run must have ended
	 *  quietly or on its own budget, nothing else may be queued, and the
	 *  coordinator must still be reachable inside the run deadline. */
	private shouldWrapUp(run: LiveRun, outcome: RunOutcome): boolean {
		return (
			this.coordinator !== null &&
			wantsDeliverable(outcome) &&
			this.queue.length === 0 &&
			!this.stopped &&
			this.host.members().includes(this.coordinator) &&
			this.host.now() < run.deadline
		);
	}

	/** One extra turn inside the same run: the coordinator posts, the room
	 *  writes the file, and the transcript records where it landed. */
	private async wrapUp(run: LiveRun, outcome: RunOutcome): Promise<void> {
		const member = this.members.find(
			(entry) => entry.name === this.coordinator,
		);
		if (member === undefined) return;
		run.wrapUp = true;
		run.current = member.name;
		this.emitRun(run);
		const result = await this.takeTurn(run, member, {
			text: this.wrapUpText(run, member, outcome),
			timeoutMs: ROOM_WRAP_UP_TIMEOUT_MS,
		});
		run.wrapUp = false;
		// An interrupt or stop finishes the run while this turn is in flight;
		// a conversation the user cut short gets no deliverable.
		if (this.live !== run) return;
		run.current = null;
		this.emitTurn(run, member.name, turnState(result, run.repliedThisTurn));
		const body = run.reply;
		run.reply = null;
		if (body === null) return; // passed or timed out: no deliverable, no file
		const written = await this.host.writeDeliverable({
			room: this.name,
			coordinator: member.name,
			task: run.task,
			outcome,
			participants: this.participants(run).map((entry) => entry.name),
			transcript: this.transcript.filter(
				(entry) => entry.id >= run.taskEntryId,
			),
			body,
			at: this.host.now(),
		});
		this.append(
			written.status === "written"
				? { kind: "system", text: renderDeliverableNotice(written.path) }
				: {
						kind: "system",
						text: renderDeliverableFailure(written.reason),
					},
		);
		if (written.status === "written") {
			this.deliverable = {
				at: this.host.now(),
				path: written.path,
				coordinator: member.name,
			};
		}
		this.persist();
	}

	private append(
		entry:
			| { kind: "user"; text: string }
			| { kind: "member"; from: RobName; text: string }
			| { kind: "system"; text: string },
	): RoomEntry {
		const at = this.host.now();
		let row: RoomEntry;
		switch (entry.kind) {
			case "user":
				row = { id: this.nextId, at, kind: "user", text: entry.text };
				break;
			case "member":
				row = {
					id: this.nextId,
					at,
					kind: "member",
					from: entry.from,
					text: entry.text,
				};
				break;
			case "system":
				row = { id: this.nextId, at, kind: "system", text: entry.text };
				break;
		}
		this.nextId += 1;
		this.transcript.push(row);
		this.emit({ kind: "entry", room: this.name, entry: { ...row } });
		return row;
	}

	/** The one writer of a live run's end; safe to call while the scheduler is
	 *  suspended inside a turn. */
	private finish(run: LiveRun, outcome: RunOutcome): void {
		if (this.live !== run) return;
		this.live = null;
		run.turnController?.abort();
		run.turnController = null;
		this.emit({
			kind: "run_ended",
			room: this.name,
			run: this.runSnapshot(run),
			outcome,
		});
		// The run boundary is durable state too: without it a crash after a
		// clean finish would still look like a run that was open.
		this.persist();
	}

	/** Hands the newest state to the ledger, coalesced. Each public mutation
	 *  offers one save at its end, so one user action is one save offer. A write
	 *  failure becomes one system entry per failure streak, so it is visible
	 *  where the user looks and cannot loop. */
	private persist(): void {
		void this.ledger.save(this.state()).then(
			() => {
				this.storageFailed = false;
			},
			(error: unknown) => {
				if (this.storageFailed) return;
				this.storageFailed = true;
				this.append({
					kind: "system",
					text: renderStorageFailure(errorMessage(error)),
				});
			},
		);
	}

	private runSnapshot(run: LiveRun): RoomRun {
		return {
			phase: "running",
			round: run.round,
			rounds: run.rounds,
			current: run.current,
			posted: run.posted,
			remaining: ROOM_MAX_MESSAGES_PER_RUN - run.posted,
			addressed: [...run.addressed],
		};
	}

	private emitRun(run: LiveRun): void {
		this.emit({ kind: "run", room: this.name, run: this.runSnapshot(run) });
	}

	private emitTurn(run: LiveRun, member: RobName, state: TurnState): void {
		this.emit({
			kind: "turn",
			room: this.name,
			member,
			round: run.round,
			state,
		});
	}

	private emit(event: RoomEvent): void {
		this.host.emit(event);
	}

	private memberNames(): readonly RobName[] {
		return this.members.map((member) => member.name);
	}

	private isMember(name: RobName): boolean {
		return this.members.some((member) => member.name === name);
	}
}

function turnState(result: RoomTurnResult, replied: boolean): TurnState {
	if (result === "timeout") return "timed_out";
	if (result !== "completed") return "failed";
	return replied ? "replied" : "passed";
}
