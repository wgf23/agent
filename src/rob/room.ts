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

/** A `PASS` line is a pass, not a transcript entry, so it has its own status
 *  rather than wearing a rejection. */
export type RoomReplyOutcome =
	| { readonly status: "posted"; readonly entry: RoomEntry }
	| { readonly status: "passed" }
	| {
			readonly status: "rejected";
			readonly reason:
				| "not_a_member"
				| "not_your_turn"
				| "message_cap"
				| "stopped";
	  };

export type RoomMembershipReason =
	| "member_count"
	| "unknown_member"
	| "duplicate_member"
	| "reserved_member"
	| "busy";

export type RoomMembershipOutcome =
	| { readonly status: "ok"; readonly members: readonly RobName[] }
	| { readonly status: "rejected"; readonly reason: RoomMembershipReason };

export type RoomCreateReason =
	| "duplicate"
	| "invalid_name"
	| RoomMembershipReason
	| "team_stopped";

export type RoomCreateOutcome =
	| { readonly status: "created"; readonly room: RoomView }
	| { readonly status: "rejected"; readonly reason: RoomCreateReason };

/** The one membership rule, used by config load, Team.createRoom and
 *  Room.setMembers, so the three paths cannot drift. "busy" is a run-state fact
 *  and is never a validation result. */
export function validateRoomMembers(
	members: readonly string[],
	roster: readonly RobName[],
):
	| { status: "ok"; members: readonly RobName[] }
	| { status: "rejected"; reason: Exclude<RoomMembershipReason, "busy"> } {
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
