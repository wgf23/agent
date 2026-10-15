import type {
	RoomCreateOutcome,
	RoomEntry,
	RoomMembershipOutcome,
	RoomName,
	RoomReplyOutcome,
	RoomSendOutcome,
} from "./room.js";
import type { RobName } from "./types.js";

/** The literal a member may send through room_reply instead of staying silent;
 *  absence of the call is still the primary way to pass. */
export const ROOM_PASS_SENTINEL = "PASS";

/** Splits `@name` mentions out of a user line. Only exact member names count, so
 *  a typo stays in the text and never silently drops a member. The token `all`
 *  addresses every member unless a member is named "all", in which case
 *  exact-name matching wins as for any other token. Named mentions union with
 *  `@all`, and the result keeps membership order. `body` drops the known
 *  mentions and collapses the leftover whitespace; the transcript keeps the raw
 *  line. Pure. */
export function parseRoomMentions(
	text: string,
	members: readonly RobName[],
): { body: string; addressed: readonly RobName[] } {
	const known = new Set(members);
	const mentioned = new Set<RobName>();
	let everyone = false;
	let body = "";
	let last = 0;
	for (const match of text.matchAll(/@([a-z][a-z0-9-]*)/g)) {
		if (match.index === undefined) continue;
		const name = match[1];
		const broadcast = name === "all" && !known.has(name);
		if (!known.has(name) && !broadcast) continue;
		body += text.slice(last, match.index);
		last = match.index + match[0].length;
		if (broadcast) everyone = true;
		else mentioned.add(name);
	}
	body += text.slice(last);
	return {
		body: body.replace(/\s+/g, " ").trim(),
		addressed: everyone
			? [...members]
			: members.filter((member) => mentioned.has(member)),
	};
}

/** The one composer of a member's room-turn prompt: header, the entries this
 *  member has not seen, the reply/pass contract, and the budget left. Pure. */
export function renderRoomTurn(input: {
	room: RoomName;
	round: number;
	rounds: number;
	remaining: number;
	addressed: readonly RobName[];
	unseen: readonly RoomEntry[];
	truncated: boolean;
}): string {
	// The room name rides in the inbound header (`headerFor`); this line carries
	// the round, which the flat `Inbound` has no field for.
	const lines = [`Round ${input.round}/${input.rounds}.`];
	if (input.addressed.length > 0) {
		lines.push(
			`Addressed: ${input.addressed.map((member) => `@${member}`).join(", ")}.`,
		);
	}
	lines.push("Since your last turn:");
	if (input.truncated) lines.push("  (earlier messages omitted)");
	if (input.unseen.length === 0) lines.push("  (nothing new)");
	for (const entry of input.unseen) {
		lines.push(`  ${speakerOf(entry)}: ${entry.text}`);
	}
	lines.push(
		`${input.remaining} message${input.remaining === 1 ? "" : "s"} left in this send.`,
		"",
		"Reply with room_reply if you have something brief to add.",
		"End your turn without calling room_reply to pass.",
	);
	return lines.join("\n");
}

/** Names a run the process was inside when the room was last saved. Load
 *  annotates it once and never restores the run. */
export function renderRestartNotice(): string {
	return "Run interrupted by a restart.";
}

/** Names the fields where my-agent.json and a saved room disagree. The saved
 *  room is the source of truth, so this is a notice, not a correction. */
export function renderConfigDrift(differences: readonly string[]): string {
	return `my-agent.json disagrees with this room's saved state (${differences.join("; ")}). The saved state is used; edit the room to change it.`;
}

export function renderStorageFailure(detail: string): string {
	return `Saving this room failed: ${detail}`;
}

/** Names room members that are no longer on the team, once per run. */
export function renderAbsentMembers(members: readonly RobName[]): string {
	return `No longer on the team: ${members.map((name) => `@${name}`).join(", ")}.`;
}

/** The one renderer of room outcome text; the TUI, the serve routes and the
 *  room_reply tool all read their wording from here, so no surface invents its
 *  own phrasing for a rejection. */
export function renderRoomOutcome(
	outcome:
		| RoomSendOutcome
		| RoomReplyOutcome
		| RoomMembershipOutcome
		| RoomCreateOutcome,
	room: string,
): string {
	switch (outcome.status) {
		case "started":
		case "posted":
			return `Posted to room "${room}".`;
		case "queued":
			return `Queued for room "${room}" (${outcome.waiting} waiting).`;
		case "passed":
			return `Passed in room "${room}".`;
		case "ok": {
			const members = `Room "${room}" now has members: ${outcome.members.join(", ")}.`;
			return outcome.coordinator === null
				? members
				: `${members} Coordinator: ${outcome.coordinator}.`;
		}
		case "created":
			return `Created room "${room}".`;
		case "rejected":
			break;
	}
	switch (outcome.reason) {
		case "unknown_room":
			return `Unknown room "${room}".`;
		case "busy":
			return `Room "${room}" is busy.`;
		case "stopped":
			return `Room "${room}" is stopped.`;
		case "empty":
			return "The room message was empty.";
		case "queue_full":
			return `Room "${room}" reached its send queue cap.`;
		case "not_a_member":
			return `You are not a member of room "${room}".`;
		case "not_your_turn":
			return `It is not your turn in room "${room}".`;
		case "message_cap":
			return `Room "${room}" reached its message cap.`;
		case "member_count":
			return "A room needs 2 to 6 members.";
		case "unknown_member":
			return "A listed member is not on the team.";
		case "duplicate_member":
			return "A member was listed twice.";
		case "reserved_member":
			return '"user" and "system" cannot be room members.';
		case "coordinator_not_member":
			return "The coordinator must be a member of the room.";
		case "duplicate":
			return `A room named "${room}" already exists.`;
		case "name_taken":
			return `A rob named "${room}" already exists; room and rob names must differ.`;
		case "invalid_name":
			return `Invalid room name "${room}".`;
		case "team_stopped":
			return "The team is stopped.";
	}
}

export function speakerOf(entry: RoomEntry): string {
	switch (entry.kind) {
		case "user":
			return "user";
		case "member":
			return entry.from;
		case "system":
			return "system";
	}
}
