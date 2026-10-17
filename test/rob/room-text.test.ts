import { describe, expect, it } from "vitest";
import {
	ROOM_MAX_MEMBERS,
	ROOM_MIN_MEMBERS,
	type RoomEntry,
	type RoomView,
} from "../../src/rob/room.js";
import {
	parseRoomMentions,
	renderAbsentMembers,
	renderDeliverableFailure,
	renderDeliverableNotice,
	renderRoomOutcome,
	renderRoomTurn,
	renderRoomWrapUp,
	renderTranscriptSummary,
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

	it("addresses every member for @all and drops it from the body", () => {
		expect(parseRoomMentions("@all stand up", members)).toEqual({
			body: "stand up",
			addressed: ["planner", "builder", "reviewer"],
		});
	});

	it("unions @all with a named mention in membership order", () => {
		expect(parseRoomMentions("@all @builder take a look", members)).toEqual({
			body: "take a look",
			addressed: ["planner", "builder", "reviewer"],
		});
		expect(parseRoomMentions("@builder @all take a look", members)).toEqual({
			body: "take a look",
			addressed: ["planner", "builder", "reviewer"],
		});
	});

	it("treats @all as a plain member when a member is named all", () => {
		const team: readonly RobName[] = ["all", "builder"];
		expect(parseRoomMentions("@all go", team)).toEqual({
			body: "go",
			addressed: ["all"],
		});
		expect(parseRoomMentions("@all @builder go", team)).toEqual({
			body: "go",
			addressed: ["all", "builder"],
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

describe("renderRoomWrapUp", () => {
	it("states the ending, the task, and the unseen window", () => {
		expect(
			renderRoomWrapUp({
				room: "ship-it",
				rounds: 2,
				outcome: "settled",
				task: "ship the parser",
				unseen: [userLine, memberLine],
				truncated: false,
			}),
		).toBe(
			[
				'The run in room "ship-it" ended after 2 rounds: settled.',
				"Compile the final deliverable now.",
				"Reply with room_reply; your reply becomes the deliverable body, and the room writes the file.",
				"",
				"Task: ship the parser",
				"",
				"Since your last turn:",
				"  user: is the parser safe on CRLF?",
				"  reviewer: one gap: the reader splits on LF only.",
			].join("\n"),
		);
	});

	it("marks a truncated window and an empty task", () => {
		expect(
			renderRoomWrapUp({
				room: "ship-it",
				rounds: 1,
				outcome: "message_cap",
				task: "",
				unseen: [],
				truncated: true,
			}),
		).toBe(
			[
				'The run in room "ship-it" ended after 1 round: message_cap.',
				"Compile the final deliverable now.",
				"Reply with room_reply; your reply becomes the deliverable body, and the room writes the file.",
				"",
				"Task: (unspecified)",
				"",
				"Since your last turn:",
				"  (earlier messages omitted)",
				"  (nothing new)",
			].join("\n"),
		);
	});
});

describe("renderTranscriptSummary", () => {
	it("counts speakers in order and samples the first lines", () => {
		expect(renderTranscriptSummary([userLine, memberLine, systemLine])).toBe(
			'[3 earlier entries compacted: user 1, reviewer 1, system 1; first lines: user: "is the parser safe on CRLF?" | reviewer: "one gap: the reader splits on LF only." | system: "planner timed out."]',
		);
	});

	it("truncates a long first line and takes at most three samples", () => {
		const long: RoomEntry = {
			id: 4,
			at: 0,
			kind: "user",
			text: `${"x".repeat(70)}\nsecond line`,
		};
		const fourth: RoomEntry = { id: 5, at: 0, kind: "user", text: "later" };
		expect(renderTranscriptSummary([long, userLine, memberLine, fourth])).toBe(
			`[4 earlier entries compacted: user 3, reviewer 1; first lines: user: "${"x".repeat(60)}..." | user: "is the parser safe on CRLF?" | reviewer: "one gap: the reader splits on LF only."]`,
		);
	});
});

describe("deliverable notice text", () => {
	it("names the written path and the failure reason", () => {
		expect(renderDeliverableNotice("docs/deliverables/x.md")).toBe(
			"The deliverable was written to docs/deliverables/x.md.",
		);
		expect(renderDeliverableFailure("disk full")).toBe(
			"The deliverable was not written: disk full",
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
			minMembers: ROOM_MIN_MEMBERS,
			maxMembers: ROOM_MAX_MEMBERS,
			maxRounds: 3,
			maxMessagesPerRun: 10,
			maxQueuedSends: 5,
		},
	};

	it("renders each status and reason as its own literal line", () => {
		const cases: Array<[Parameters<typeof renderRoomOutcome>[0], string]> = [
			[{ status: "started", entry: userLine }, 'Posted to room "ship-it".'],
			[{ status: "posted", entry: memberLine }, 'Posted to room "ship-it".'],
			[
				{ status: "queued", entry: userLine, waiting: 2 },
				'Queued for room "ship-it" (2 waiting).',
			],
			[{ status: "passed" }, 'Passed in room "ship-it".'],
			[
				{ status: "ok", members: ["planner", "builder"], coordinator: null },
				'Room "ship-it" now has members: planner, builder.',
			],
			[
				{
					status: "ok",
					members: ["planner", "builder"],
					coordinator: "planner",
				},
				'Room "ship-it" now has members: planner, builder. Coordinator: planner.',
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
				{ status: "rejected", reason: "queue_full" },
				'Room "ship-it" reached its send queue cap.',
			],
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
				`A room needs ${ROOM_MIN_MEMBERS} to ${ROOM_MAX_MEMBERS} members.`,
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
				{ status: "rejected", reason: "coordinator_not_member" },
				"The coordinator must be a member of the room.",
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

describe("renderAbsentMembers", () => {
	it("names the members that left the team", () => {
		expect(renderAbsentMembers(["ghost", "phantom"])).toBe(
			"No longer on the team: @ghost, @phantom.",
		);
	});
});
