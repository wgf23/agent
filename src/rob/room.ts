import { z } from "zod";
import {
	parseRoomMentions,
	ROOM_PASS_SENTINEL,
	renderRoomTurn,
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
export const ROOM_TURN_TIMEOUT_MS = 120_000;
export const ROOM_RUN_TIMEOUT_MS = 300_000;

/** How much of a member's unseen history one room turn carries. Older entries
 *  are dropped, not replayed, so a long room still hands over a bounded prompt. */
export const ROOM_MAX_UNSEEN_ENTRIES = 20;

/** "user" and "system" are the transcript's own voices; refusing them as member
 *  names is what keeps an entry's speaker unambiguous. */
export const RESERVED_ROOM_SPEAKERS = ["user", "system"] as const;

/** One room as config states it. The file shape and the runtime shape are the
 *  same, so Team.createRoom takes the validated value directly. Which members
 *  exist, and how many, is not a schema fact: validateRoomMembers holds it. */
export const roomConfigSchema = z
	.object({ name: roomNameSchema, members: z.array(robNameSchema) })
	.strict();
export type RoomConfig = z.infer<typeof roomConfigSchema>;

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
}

/** The plain-data snapshot surfaces render. Fresh copies; callers never see the
 *  room's mutable state and never see the internal per-member cursors. */
export interface RoomView {
	readonly name: RoomName;
	readonly members: readonly RobName[]; // membership order = turn order
	readonly transcript: readonly RoomEntry[];
	readonly run: RoomRun;
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
 *  produced by Team.sendToRoom, the only public sender. */
export type RoomSendOutcome =
	| { readonly status: "started"; readonly entry: RoomEntry }
	| {
			readonly status: "rejected";
			readonly reason: "unknown_room" | "busy" | "stopped" | "empty";
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
	| { readonly status: "ok"; readonly members: readonly RobName[] }
	| { readonly status: "rejected"; readonly reason: RoomMembershipReason };

export type RoomCreateReason =
	| "duplicate"
	| "invalid_name"
	| "name_taken"
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
	emit(event: RoomEvent): void;
	now(): number;
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
	current: RobName | null;
	posted: number;
	spokeThisRound: number;
	repliedThisTurn: boolean;
	turnController: AbortController | null;
	readonly deadline: number;
}

export class Room {
	readonly name: RoomName;

	private readonly host: RoomHost;
	private members: Member[];
	private readonly transcript: RoomEntry[] = [];
	private nextId = 1;
	private live: LiveRun | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	private readonly stoppedPromise: Promise<void>;
	private releaseStop: () => void = () => undefined;

	/** `members` must already satisfy validateRoomMembers; Team is the only
	 *  constructor caller and validates before constructing. */
	constructor(options: {
		name: RoomName;
		members: readonly RobName[];
		host: RoomHost;
	}) {
		this.name = options.name;
		this.host = options.host;
		this.members = options.members.map((name) => ({ name, seen: 0 }));
		this.stoppedPromise = new Promise((resolve) => {
			this.releaseStop = resolve;
		});
	}

	/** A fresh copy. The only read surface; no caller mutates room state. */
	view(): RoomView {
		return {
			name: this.name,
			members: this.memberNames(),
			transcript: this.transcript.map((entry) => ({ ...entry })),
			run: this.live === null ? { phase: "idle" } : this.runSnapshot(this.live),
			limits: {
				minMembers: ROOM_MIN_MEMBERS,
				maxMembers: ROOM_MAX_MEMBERS,
				maxRounds: ROOM_MAX_ROUNDS,
				maxMessagesPerRun: ROOM_MAX_MESSAGES_PER_RUN,
			},
		};
	}

	/** Appends the user's entry (mentions and all), scopes the run to the
	 *  mentions, and starts the bounded rounds. One run at a time: a send while a
	 *  run is live is rejected, not queued. */
	send(text: string): RoomSendOutcome {
		if (this.stopped) return { status: "rejected", reason: "stopped" };
		if (this.live !== null) return { status: "rejected", reason: "busy" };
		if (text.trim() === "") return { status: "rejected", reason: "empty" };

		const entry = this.append({ kind: "user", text });
		const run: LiveRun = {
			round: 1,
			rounds: ROOM_MAX_ROUNDS,
			addressed: parseRoomMentions(text, this.memberNames()).addressed,
			current: null,
			posted: 0,
			spokeThisRound: 0,
			repliedThisTurn: false,
			turnController: null,
			deadline: this.host.now() + ROOM_RUN_TIMEOUT_MS,
		};
		this.live = run;
		this.emitRun(run);
		this.start(run);
		return { status: "started", entry: { ...entry } };
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
		if (run.posted >= ROOM_MAX_MESSAGES_PER_RUN) {
			return { status: "rejected", reason: "message_cap" };
		}
		if (text.trim() === ROOM_PASS_SENTINEL) return { status: "passed" };

		const entry = this.append({ kind: "member", from, text });
		run.posted += 1;
		run.spokeThisRound += 1;
		run.repliedThisTurn = true;
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
		this.emit({
			kind: "members",
			room: this.name,
			members: this.memberNames(),
		});
		return { status: "ok", members: this.memberNames() };
	}

	/** Ends the live run with `interrupted`; the room stays usable. */
	interrupt(): void {
		if (this.live !== null) this.finish(this.live, "interrupted");
	}

	/** Terminal, idempotent. Resolves when the run loop has exited, so Team.stop
	 *  can await it before stopping robs. */
	stop(): Promise<void> {
		if (this.stopped) return this.stoppedPromise;
		this.stopped = true;
		if (this.live !== null) this.finish(this.live, "stopped");
		if (this.running === null) this.releaseStop();
		return this.stoppedPromise;
	}

	private start(run: LiveRun): void {
		const task: Promise<void> = this.runRounds(run).finally(() => {
			if (this.running === task) this.running = null;
			if (this.stopped && this.running === null) this.releaseStop();
		});
		this.running = task;
	}

	private async runRounds(run: LiveRun): Promise<void> {
		try {
			while (this.live === run) {
				if (this.host.now() >= run.deadline) {
					this.finish(run, "run_timeout");
					return;
				}
				run.spokeThisRound = 0;
				for (const member of this.participants(run)) {
					if (this.live !== run) return;
					if (this.host.now() >= run.deadline) {
						this.finish(run, "run_timeout");
						return;
					}
					run.current = member.name;
					this.emitRun(run);
					const result = await this.takeTurn(run, member);
					if (this.live !== run) return;
					run.current = null;
					member.seen = this.nextId - 1;
					this.emitTurn(
						run,
						member.name,
						turnState(result, run.repliedThisTurn),
					);
					if (result === "stopped") {
						this.finish(run, "stopped");
						return;
					}
					if (run.posted >= ROOM_MAX_MESSAGES_PER_RUN) {
						this.finish(run, "message_cap");
						return;
					}
				}
				if (run.spokeThisRound === 0) {
					this.finish(run, "settled");
					return;
				}
				if (run.round >= run.rounds) {
					this.finish(run, "max_rounds");
					return;
				}
				run.round += 1;
			}
		} catch {
			this.finish(run, "error");
		}
	}

	private participants(run: LiveRun): readonly Member[] {
		const addressed = new Set(run.addressed);
		if (addressed.size === 0) return this.members;
		return this.members.filter((member) => addressed.has(member.name));
	}

	private async takeTurn(
		run: LiveRun,
		member: Member,
	): Promise<RoomTurnResult> {
		const controller = new AbortController();
		run.turnController = controller;
		run.repliedThisTurn = false;
		let expired = false;
		const budget = Math.min(
			ROOM_TURN_TIMEOUT_MS,
			Math.max(0, run.deadline - this.host.now()),
		);
		const timer = setTimeout(() => {
			expired = true;
			controller.abort();
		}, budget);
		try {
			const result = await this.host.runTurn(member.name, {
				room: this.name,
				round: run.round,
				text: this.turnText(run, member),
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

	private turnText(run: LiveRun, member: Member): string {
		const unseen = this.transcript.filter((entry) => entry.id > member.seen);
		const truncated = unseen.length > ROOM_MAX_UNSEEN_ENTRIES;
		return renderRoomTurn({
			room: this.name,
			round: run.round,
			rounds: run.rounds,
			remaining: ROOM_MAX_MESSAGES_PER_RUN - run.posted,
			addressed: run.addressed,
			unseen: truncated ? unseen.slice(-ROOM_MAX_UNSEEN_ENTRIES) : unseen,
			truncated,
		});
	}

	private append(
		entry:
			| { kind: "user"; text: string }
			| { kind: "member"; from: RobName; text: string },
	): RoomEntry {
		const at = this.host.now();
		const row: RoomEntry =
			entry.kind === "user"
				? { id: this.nextId, at, kind: "user", text: entry.text }
				: {
						id: this.nextId,
						at,
						kind: "member",
						from: entry.from,
						text: entry.text,
					};
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
