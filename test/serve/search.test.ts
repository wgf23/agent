import { describe, expect, it } from "vitest";
import {
	ROOM_MAX_MEMBERS,
	ROOM_MIN_MEMBERS,
	type RoomView,
} from "../../src/rob/room.js";
import {
	MAX_SESSION_MATCHES,
	matchText,
	roomMatches,
	snippet,
} from "../../src/serve/search.js";

describe("matchText", () => {
	it("finds a match case-insensitively", () => {
		expect(matchText("Hello World", "WORLD")).toEqual([{ start: 6, end: 11 }]);
		expect(matchText("Hello World", "hello")).toEqual([{ start: 0, end: 5 }]);
	});

	it("returns null for a non-match", () => {
		expect(matchText("Hello World", "planet")).toBeNull();
	});

	it("returns null when the query is longer than the text", () => {
		expect(matchText("short", "a much longer query")).toBeNull();
	});

	it("returns null for a blank query rather than matching everything", () => {
		expect(matchText("Hello World", "")).toBeNull();
	});
});

describe("snippet", () => {
	it("keeps the exact query intact and bounded when the match is at the start", () => {
		const text = `needle${"x".repeat(500)}`;
		const result = snippet(text, "NEEDLE", 10);
		expect(result.toLowerCase()).toContain("needle");
		// The literal length bound: query length plus a radius on each side.
		expect(result.length).toBeLessThanOrEqual("NEEDLE".length + 10 * 2);
	});

	it("keeps the exact query intact and bounded when the match is at the end", () => {
		const text = `${"x".repeat(500)}needle`;
		const result = snippet(text, "needle", 10);
		expect(result).toContain("needle");
		expect(result.length).toBeLessThanOrEqual("needle".length + 10 * 2);
	});
});

function room(name: string, transcript: RoomView["transcript"]): RoomView {
	return {
		name,
		members: ["alpha", "beta"],
		coordinator: null,
		transcript,
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
}

// A room yields one session-shaped match named like the room, and a member's
// entry maps to the assistant role because the member is the room's voice.
describe("roomMatches", () => {
	it("maps a room transcript's roles and keeps the entry order", () => {
		const shipIt = room("ship-it", [
			{ id: 1, at: 7, kind: "user", text: "the needle in chat" },
			{ id: 2, at: 8, kind: "member", from: "alpha", text: "a needle answer" },
			{ id: 3, at: 9, kind: "system", text: "unrelated" },
		]);
		const silent = room("silent", [
			{ id: 1, at: 10, kind: "user", text: "nothing to see" },
		]);

		expect(roomMatches([shipIt, silent], "NEEDLE")).toEqual([
			{
				room: "ship-it",
				matches: [
					{
						sessionId: "ship-it",
						title: "ship-it",
						firstUserText: "the needle in chat",
						hits: [
							{ role: "user", text: "the needle in chat", at: 7 },
							{ role: "assistant", text: "a needle answer", at: 8 },
						],
					},
				],
			},
		]);
	});

	it("omits every room when nothing matches", () => {
		expect(roomMatches([room("ship-it", [])], "absent")).toEqual([]);
	});

	it("orders rooms by their newest matching entry", () => {
		const older = room("older", [
			{ id: 1, at: 100, kind: "user", text: "needle here" },
		]);
		const newer = room("newer", [
			{ id: 1, at: 100, kind: "user", text: "needle too" },
			{ id: 2, at: 200, kind: "member", from: "beta", text: "needle again" },
		]);

		expect(roomMatches([older, newer], "needle").map((r) => r.room)).toEqual([
			"newer",
			"older",
		]);
	});

	it("caps the result at the newest MAX_SESSION_MATCHES rooms", () => {
		const rooms = Array.from({ length: MAX_SESSION_MATCHES + 5 }, (_, index) =>
			room(`room-${index}`, [
				{ id: 1, at: index, kind: "user", text: "needle" },
			]),
		);

		const matches = roomMatches(rooms, "needle");
		expect(matches).toHaveLength(MAX_SESSION_MATCHES);
		// The newest five rooms (the tail of the input order) are the ones kept.
		expect(matches[0]?.room).toBe(`room-${MAX_SESSION_MATCHES + 4}`);
		expect(matches.at(-1)?.room).toBe("room-5");
	});
});
