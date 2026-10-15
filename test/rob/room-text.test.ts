import { describe, expect, it } from "vitest";
import type { RoomEntry, RoomView } from "../../src/rob/room.js";
import {
	parseRoomMentions,
	renderRoomOutcome,
	renderRoomTurn,
} from "../../src/rob/room-text.js";
import type { RobName } from "../../src/rob/types.js";

const members: readonly RobName[] = ["planner", "builder", "reviewer"];

const userLine: RoomEntry = {
	id: 1,
	at: 1_700_000_000_000,
	kind: "user",
	text: "is the parser safe on CRLF?",
};
const memberLine: RoomEntry = {
	id: 2,
	at: 1_700_000_001_000,
	kind: "member",
	from: "reviewer",
	text: "one gap: the reader splits on LF only.",
};
const systemLine: RoomEntry = {
	id: 3,
	at: 1_700_000_002_000,
	kind: "system",
	text: "planner timed out.",
};

describe("parseRoomMentions", () => {
	it("drops a known mention from the body and addresses its member", () => {
		expect(parseRoomMentions("@reviewer is the parser safe?", members)).toEqual(
			{
				body: "is the parser safe?",
				addressed: ["reviewer"],
			},
		);
	});

	it("keeps an unknown mention in the body and addresses nobody", () => {
		expect(parseRoomMentions("@nobody look at this", members)).toEqual({
			body: "@nobody look at this",
			addressed: [],
		});
	});

	it("addresses each known member once, in membership order", () => {
		expect(
			parseRoomMentions("@reviewer @planner @reviewer take a look", members),
		).toEqual({ body: "take a look", addressed: ["planner", "reviewer"] });
	});

	it("keeps punctuation around a mention and leaves plain lines alone", () => {
		expect(parseRoomMentions("@builder, please confirm", members)).toEqual({
			body: ", please confirm",
			addressed: ["builder"],
		});
		expect(parseRoomMentions("what changed?", members)).toEqual({
			body: "what changed?",
			addressed: [],
		});
	});
});

describe("renderRoomTurn", () => {
	it("composes the header, unseen entries, the contract, and the budget", () => {
		expect(
			renderRoomTurn({
				room: "ship-it",
				round: 2,
				rounds: 3,
				remaining: 7,
				addressed: [],
				unseen: [userLine, memberLine],
				truncated: false,
			}),
		).toBe(
			[
				"Round 2/3.",
				"Since your last turn:",
				"  user: is the parser safe on CRLF?",
				"  reviewer: one gap: the reader splits on LF only.",
				"7 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		);
	});

	it("marks a truncated window, the addressed member, and a single message left", () => {
		expect(
			renderRoomTurn({
				room: "ship-it",
				round: 1,
				rounds: 3,
				remaining: 1,
				addressed: ["reviewer"],
				unseen: [systemLine],
				truncated: true,
			}),
		).toBe(
			[
				"Round 1/3.",
				"Addressed: @reviewer.",
				"Since your last turn:",
				"  (earlier messages omitted)",
				"  system: planner timed out.",
				"1 message left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		);
	});

	it("says nothing is new when the member has seen everything", () => {
		expect(
			renderRoomTurn({
				room: "ship-it",
				round: 2,
				rounds: 3,
				remaining: 10,
				addressed: [],
				unseen: [],
				truncated: false,
			}),
		).toBe(
			[
				"Round 2/3.",
				"Since your last turn:",
				"  (nothing new)",
				"10 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		);
	});
});

describe("renderRoomOutcome", () => {
	const view: RoomView = {
		name: "ship-it",
		members: ["planner", "builder"],
		coordinator: null,
		transcript: [],
		run: { phase: "idle" },
		pending: 0,
		deliverable: null,
		limits: {
			minMembers: 2,
			maxMembers: 6,
			maxRounds: 3,
			maxMessagesPerRun: 10,
			maxQueuedSends: 5,
		},
	};

	it("renders each status and reason as its own literal line", () => {
		const cases: Array<[Parameters<typeof renderRoomOutcome>[0], string]> = [
			[{ status: "started", entry: userLine }, 'Posted to room "ship-it".'],
			[{ status: "posted", entry: memberLine }, 'Posted to room "ship-it".'],
			[{ status: "passed" }, 'Passed in room "ship-it".'],
			[
				{ status: "ok", members: ["planner", "builder"] },
				'Room "ship-it" now has members: planner, builder.',
			],
			[{ status: "created", room: view }, 'Created room "ship-it".'],
			[
				{ status: "rejected", reason: "unknown_room" },
				'Unknown room "ship-it".',
			],
			[{ status: "rejected", reason: "busy" }, 'Room "ship-it" is busy.'],
			[{ status: "rejected", reason: "stopped" }, 'Room "ship-it" is stopped.'],
			[{ status: "rejected", reason: "empty" }, "The room message was empty."],
			[
				{ status: "rejected", reason: "not_a_member" },
				'You are not a member of room "ship-it".',
			],
			[
				{ status: "rejected", reason: "not_your_turn" },
				'It is not your turn in room "ship-it".',
			],
			[
				{ status: "rejected", reason: "message_cap" },
				'Room "ship-it" reached its message cap.',
			],
			[
				{ status: "rejected", reason: "member_count" },
				"A room needs 2 to 6 members.",
			],
			[
				{ status: "rejected", reason: "unknown_member" },
				"A listed member is not on the team.",
			],
			[
				{ status: "rejected", reason: "duplicate_member" },
				"A member was listed twice.",
			],
			[
				{ status: "rejected", reason: "reserved_member" },
				'"user" and "system" cannot be room members.',
			],
			[
				{ status: "rejected", reason: "duplicate" },
				'A room named "ship-it" already exists.',
			],
			[
				{ status: "rejected", reason: "invalid_name" },
				'Invalid room name "ship-it".',
			],
			[{ status: "rejected", reason: "team_stopped" }, "The team is stopped."],
		];
		for (const [outcome, expected] of cases) {
			expect(renderRoomOutcome(outcome, "ship-it")).toBe(expected);
		}
	});
});
