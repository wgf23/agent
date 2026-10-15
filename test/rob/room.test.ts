import { describe, expect, it, vi } from "vitest";
import {
	ROOM_TURN_TIMEOUT_MS,
	Room,
	type RoomEvent,
	type RoomHost,
	type RoomReplyOutcome,
	type RoomTurn,
	type RoomTurnResult,
	validateRoomMembers,
} from "../../src/rob/room.js";
import type { RobName } from "../../src/rob/types.js";
import { waitFor } from "./helpers.js";

type TurnAction =
	| { readonly kind: "post"; readonly texts: readonly string[] }
	| { readonly kind: "pass" }
	| { readonly kind: "hang" }
	| { readonly kind: "stop" };

const post = (...texts: string[]): TurnAction => ({ kind: "post", texts });
const pass: TurnAction = { kind: "pass" };
const hang: TurnAction = { kind: "hang" };
const stop: TurnAction = { kind: "stop" };

// A scripted host: per-member action queues, a shared fallback, and a clock.
// `hang` never answers on its own, so the room's timeout is the only way out.
class FakeRoomHost implements RoomHost {
	readonly events: RoomEvent[] = [];
	readonly turns: Array<{ readonly member: RobName; readonly turn: RoomTurn }> =
		[];
	readonly replies: Array<{
		readonly from: RobName;
		readonly outcome: RoomReplyOutcome;
	}> = [];
	peakInFlight = 0;
	inFlight = 0;

	private readonly rosterNames: readonly RobName[];
	private readonly scripts = new Map<RobName, TurnAction[]>();
	private readonly fallback: TurnAction;
	private readonly clock: () => number;
	private room: Room | null = null;

	constructor(options: {
		readonly roster: readonly RobName[];
		readonly scripts?: Partial<Record<RobName, TurnAction[]>>;
		readonly fallback?: TurnAction;
		readonly clock?: () => number;
	}) {
		this.rosterNames = options.roster;
		this.fallback = options.fallback ?? pass;
		this.clock = options.clock ?? (() => 1000);
		for (const [member, actions] of Object.entries(options.scripts ?? {})) {
			this.scripts.set(member, [...(actions ?? [])]);
		}
	}

	attach(room: Room): void {
		this.room = room;
	}

	members(): readonly RobName[] {
		return this.rosterNames;
	}

	now(): number {
		return this.clock();
	}

	emit(event: RoomEvent): void {
		this.events.push(event);
	}

	async runTurn(member: RobName, turn: RoomTurn): Promise<RoomTurnResult> {
		this.turns.push({ member, turn });
		this.inFlight += 1;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
		try {
			const action = this.scripts.get(member)?.shift() ?? this.fallback;
			switch (action.kind) {
				case "pass":
					return "completed";
				case "stop":
					return "stopped";
				case "post": {
					const room = this.room;
					if (room === null) throw new Error("the fake host has no room");
					for (const text of action.texts) {
						this.replies.push({
							from: member,
							outcome: room.post(member, text),
						});
					}
					return "completed";
				}
				case "hang":
					await new Promise<void>((resolve) => {
						if (turn.signal.aborted) {
							resolve();
							return;
						}
						turn.signal.addEventListener("abort", () => resolve(), {
							once: true,
						});
					});
					return "completed";
			}
		} finally {
			this.inFlight -= 1;
		}
	}
}

function makeRoom(
	options: {
		readonly members?: readonly RobName[];
		readonly roster?: readonly RobName[];
		readonly scripts?: Partial<Record<RobName, TurnAction[]>>;
		readonly fallback?: TurnAction;
		readonly clock?: () => number;
	} = {},
): { room: Room; host: FakeRoomHost } {
	const members = options.members ?? ["planner", "builder", "reviewer"];
	const host = new FakeRoomHost({
		roster: options.roster ?? members,
		scripts: options.scripts,
		fallback: options.fallback,
		clock: options.clock,
	});
	const room = new Room({ name: "ship-it", members, host });
	host.attach(room);
	return { room, host };
}

async function settle(room: Room): Promise<void> {
	await waitFor(() => room.view().run.phase === "idle", "the room to settle");
}

// Fake timers do not drive the room's promise chain; drain it by hand so each
// step of a timeout test is deterministic.
async function drain(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("Room", () => {
	it("takes one turn per member in membership order and settles a silent round", async () => {
		const { room, host } = makeRoom();

		const outcome = room.send("status?");
		expect(outcome).toEqual({
			status: "started",
			entry: { id: 1, at: 1000, kind: "user", text: "status?" },
		});
		await settle(room);

		expect(host.peakInFlight).toBe(1);
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
			"reviewer",
		]);
		expect(host.events).toEqual([
			{
				kind: "entry",
				room: "ship-it",
				entry: { id: 1, at: 1000, kind: "user", text: "status?" },
			},
			{
				kind: "run",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: null,
					posted: 0,
					remaining: 10,
					addressed: [],
				},
			},
			{
				kind: "run",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: "planner",
					posted: 0,
					remaining: 10,
					addressed: [],
				},
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "planner",
				round: 1,
				state: "passed",
			},
			{
				kind: "run",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: "builder",
					posted: 0,
					remaining: 10,
					addressed: [],
				},
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "builder",
				round: 1,
				state: "passed",
			},
			{
				kind: "run",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: "reviewer",
					posted: 0,
					remaining: 10,
					addressed: [],
				},
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "reviewer",
				round: 1,
				state: "passed",
			},
			{
				kind: "run_ended",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: null,
					posted: 0,
					remaining: 10,
					addressed: [],
				},
				outcome: "settled",
			},
		]);
		expect(room.view()).toEqual({
			name: "ship-it",
			members: ["planner", "builder", "reviewer"],
			transcript: [{ id: 1, at: 1000, kind: "user", text: "status?" }],
			run: { phase: "idle" },
			limits: {
				minMembers: 2,
				maxMembers: 6,
				maxRounds: 3,
				maxMessagesPerRun: 10,
			},
		});
	});

	it("posts a reply, shows it to the next member, then settles on a silent round", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: {
				planner: [post("I can take the parser fix."), pass],
				builder: [pass, pass],
			},
		});

		room.send("who takes the parser?");
		await settle(room);

		expect(room.view().transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "who takes the parser?" },
			{
				id: 2,
				at: 1000,
				kind: "member",
				from: "planner",
				text: "I can take the parser fix.",
			},
		]);
		expect(host.replies).toEqual([
			{
				from: "planner",
				outcome: {
					status: "posted",
					entry: {
						id: 2,
						at: 1000,
						kind: "member",
						from: "planner",
						text: "I can take the parser fix.",
					},
				},
			},
		]);
		expect(host.events.filter((event) => event.kind === "turn")).toEqual([
			{
				kind: "turn",
				room: "ship-it",
				member: "planner",
				round: 1,
				state: "replied",
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "builder",
				round: 1,
				state: "passed",
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "planner",
				round: 2,
				state: "passed",
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "builder",
				round: 2,
				state: "passed",
			},
		]);
		expect(host.turns[1].turn.text).toContain(
			"  planner: I can take the parser fix.",
		);
		expect(host.turns[2].turn.text).toContain("[room:ship-it round 2/3]");
		expect(host.turns[2].turn.text).toContain("  (nothing new)");
		expect(host.events.at(-1)).toEqual({
			kind: "run_ended",
			room: "ship-it",
			run: {
				phase: "running",
				round: 2,
				rounds: 3,
				current: null,
				posted: 1,
				remaining: 9,
				addressed: [],
			},
			outcome: "settled",
		});
	});

	it("scopes every round to the mentioned member and keeps the mention in the entry", async () => {
		const { room, host } = makeRoom({
			scripts: {
				reviewer: [post("one gap: the reader splits on LF only."), pass],
			},
		});

		room.send("@reviewer is the parser safe on CRLF?");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual([
			"reviewer",
			"reviewer",
		]);
		expect(room.view().transcript[0]).toEqual({
			id: 1,
			at: 1000,
			kind: "user",
			text: "@reviewer is the parser safe on CRLF?",
		});
		expect(host.turns[0].turn.text).toBe(
			[
				"[room:ship-it round 1/3]",
				"Addressed: @reviewer.",
				"Since your last turn:",
				"  user: @reviewer is the parser safe on CRLF?",
				"10 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		);
		expect(host.turns[1].turn.text).toBe(
			[
				"[room:ship-it round 2/3]",
				"Addressed: @reviewer.",
				"Since your last turn:",
				"  (nothing new)",
				"9 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		);
		expect(host.events.filter((event) => event.kind === "turn")).toEqual([
			{
				kind: "turn",
				room: "ship-it",
				member: "reviewer",
				round: 1,
				state: "replied",
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "reviewer",
				round: 2,
				state: "passed",
			},
		]);
	});

	it("keeps an unknown mention as text and asks every member", async () => {
		const { room, host } = makeRoom({ members: ["planner", "builder"] });

		room.send("@nobody any idea?");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
		]);
		expect(room.view().transcript[0]).toEqual({
			id: 1,
			at: 1000,
			kind: "user",
			text: "@nobody any idea?",
		});
		expect(host.events[1]).toEqual({
			kind: "run",
			room: "ship-it",
			run: {
				phase: "running",
				round: 1,
				rounds: 3,
				current: null,
				posted: 0,
				remaining: 10,
				addressed: [],
			},
		});
	});

	it("ends the run after the tenth posted message", async () => {
		const { room, host } = makeRoom({
			members: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
			fallback: post("ok"),
		});

		room.send("go");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual([
			"alpha",
			"bravo",
			"charlie",
			"delta",
			"echo",
			"foxtrot",
			"alpha",
			"bravo",
			"charlie",
			"delta",
		]);
		expect(host.turns[9].turn.text).toContain("1 message left in this send.");
		expect(room.view().transcript.map((entry) => entry.text)).toEqual([
			"go",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
			"ok",
		]);
		expect(host.events.filter((event) => event.kind === "entry")).toHaveLength(
			11,
		);
		expect(host.events.at(-1)).toEqual({
			kind: "run_ended",
			room: "ship-it",
			run: {
				phase: "running",
				round: 2,
				rounds: 3,
				current: null,
				posted: 10,
				remaining: 0,
				addressed: [],
			},
			outcome: "message_cap",
		});
	});

	it("rejects a reply above the cap inside a turn and counts ten", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: {
				planner: [
					post(
						...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`),
					),
				],
			},
		});

		room.send("go");
		await settle(room);

		expect(
			host.replies.filter((reply) => reply.outcome.status === "posted"),
		).toHaveLength(10);
		expect(host.replies.at(-1)).toEqual({
			from: "planner",
			outcome: { status: "rejected", reason: "message_cap" },
		});
		expect(host.events.at(-1)).toEqual({
			kind: "run_ended",
			room: "ship-it",
			run: {
				phase: "running",
				round: 1,
				rounds: 3,
				current: null,
				posted: 10,
				remaining: 0,
				addressed: [],
			},
			outcome: "message_cap",
		});
	});

	it("times out a turn that never comes back and settles the silent round", async () => {
		vi.useFakeTimers();
		try {
			const { room, host } = makeRoom({
				members: ["planner", "builder"],
				scripts: { planner: [hang], builder: [hang] },
			});

			room.send("anyone?");
			await drain();
			expect(host.turns).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(ROOM_TURN_TIMEOUT_MS);
			await drain();
			await vi.advanceTimersByTimeAsync(ROOM_TURN_TIMEOUT_MS);
			await drain();

			expect(host.peakInFlight).toBe(1);
			expect(host.turns.map((entry) => entry.member)).toEqual([
				"planner",
				"builder",
			]);
			expect(host.turns[0].turn.signal.aborted).toBe(true);
			expect(host.turns[1].turn.signal.aborted).toBe(true);
			expect(host.events.filter((event) => event.kind === "turn")).toEqual([
				{
					kind: "turn",
					room: "ship-it",
					member: "planner",
					round: 1,
					state: "timed_out",
				},
				{
					kind: "turn",
					room: "ship-it",
					member: "builder",
					round: 1,
					state: "timed_out",
				},
			]);
			expect(host.events.at(-1)).toEqual({
				kind: "run_ended",
				room: "ship-it",
				run: {
					phase: "running",
					round: 1,
					rounds: 3,
					current: null,
					posted: 0,
					remaining: 10,
					addressed: [],
				},
				outcome: "settled",
			});
			expect(room.view().run).toEqual({ phase: "idle" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends the run when the run budget expires mid-round", async () => {
		vi.useFakeTimers();
		try {
			const { room, host } = makeRoom({
				members: ["planner", "builder", "charlie"],
				clock: () => Date.now(),
				scripts: {
					planner: [post("one"), post("two")],
					builder: [hang, hang],
					charlie: [hang],
				},
			});

			room.send("go");
			await drain();
			await vi.advanceTimersByTimeAsync(ROOM_TURN_TIMEOUT_MS);
			await drain();
			await vi.advanceTimersByTimeAsync(ROOM_TURN_TIMEOUT_MS);
			await drain();
			await vi.advanceTimersByTimeAsync(ROOM_TURN_TIMEOUT_MS / 2);
			await drain();

			expect(host.turns.map((entry) => entry.member)).toEqual([
				"planner",
				"builder",
				"charlie",
				"planner",
				"builder",
			]);
			expect(host.events.filter((event) => event.kind === "turn")).toEqual([
				{
					kind: "turn",
					room: "ship-it",
					member: "planner",
					round: 1,
					state: "replied",
				},
				{
					kind: "turn",
					room: "ship-it",
					member: "builder",
					round: 1,
					state: "timed_out",
				},
				{
					kind: "turn",
					room: "ship-it",
					member: "charlie",
					round: 1,
					state: "timed_out",
				},
				{
					kind: "turn",
					room: "ship-it",
					member: "planner",
					round: 2,
					state: "replied",
				},
				{
					kind: "turn",
					room: "ship-it",
					member: "builder",
					round: 2,
					state: "timed_out",
				},
			]);
			expect(host.events.at(-1)).toEqual({
				kind: "run_ended",
				room: "ship-it",
				run: {
					phase: "running",
					round: 2,
					rounds: 3,
					current: null,
					posted: 2,
					remaining: 8,
					addressed: [],
				},
				outcome: "run_timeout",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("interrupt ends the live run and the room stays usable", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang, pass] },
		});

		room.send("first");
		await drain();
		expect(host.turns).toHaveLength(1);

		room.interrupt();
		expect(room.view().run).toEqual({ phase: "idle" });
		expect(host.events.at(-1)).toEqual({
			kind: "run_ended",
			room: "ship-it",
			run: {
				phase: "running",
				round: 1,
				rounds: 3,
				current: "planner",
				posted: 0,
				remaining: 10,
				addressed: [],
			},
			outcome: "interrupted",
		});
		await waitFor(() => host.inFlight === 0, "the aborted turn to end");

		room.send("second");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"planner",
			"builder",
		]);
		expect(
			host.events
				.filter((event) => event.kind === "run_ended")
				.map((event) => event.outcome),
		).toEqual(["interrupted", "settled"]);
	});

	it("ends the run when the host reports the turn stopped", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [stop, pass] },
		});

		room.send("go");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual(["planner"]);
		expect(host.events.filter((event) => event.kind === "turn")).toEqual([
			{
				kind: "turn",
				room: "ship-it",
				member: "planner",
				round: 1,
				state: "failed",
			},
		]);
		expect(host.events.at(-1)).toMatchObject({
			kind: "run_ended",
			outcome: "stopped",
		});

		room.send("retry");
		await settle(room);
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"planner",
			"builder",
		]);
		expect(host.events.at(-1)).toMatchObject({
			kind: "run_ended",
			outcome: "settled",
		});
	});

	it("rejects a second send while live and a whitespace-only send", async () => {
		const { room } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang] },
		});

		room.send("one");
		expect(room.send("two")).toEqual({ status: "rejected", reason: "busy" });
		expect(room.send("   ")).toEqual({ status: "rejected", reason: "busy" });
		await room.stop();

		const fresh = makeRoom();
		expect(fresh.room.send("   ")).toEqual({
			status: "rejected",
			reason: "empty",
		});
		expect(fresh.host.turns).toEqual([]);
		expect(fresh.room.view().transcript).toEqual([]);
	});

	it("rejects a post from a stranger or when it is not the member's turn", async () => {
		const { room } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang] },
		});

		expect(room.post("planner", "hello")).toEqual({
			status: "rejected",
			reason: "not_your_turn",
		});

		room.send("one");
		await drain();
		expect(room.post("ghost", "hello")).toEqual({
			status: "rejected",
			reason: "not_a_member",
		});
		expect(room.post("builder", "hello")).toEqual({
			status: "rejected",
			reason: "not_your_turn",
		});
		await room.stop();
	});

	it("accepts an explicit PASS as a pass, not an entry", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [post(" PASS ")], builder: [pass] },
		});

		room.send("who can take it?");
		await settle(room);

		expect(host.replies).toEqual([
			{ from: "planner", outcome: { status: "passed" } },
		]);
		expect(room.view().transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "who can take it?" },
		]);
		expect(host.events.filter((event) => event.kind === "turn")).toEqual([
			{
				kind: "turn",
				room: "ship-it",
				member: "planner",
				round: 1,
				state: "passed",
			},
			{
				kind: "turn",
				room: "ship-it",
				member: "builder",
				round: 1,
				state: "passed",
			},
		]);
	});

	it("stops idempotently, releasing only after the run loop has exited", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang] },
		});

		room.send("go");
		await drain();
		const stopping = room.stop();

		expect(room.view().run).toEqual({ phase: "idle" });
		expect(host.events.at(-1)).toMatchObject({
			kind: "run_ended",
			outcome: "stopped",
		});
		await stopping;
		expect(host.inFlight).toBe(0);
		expect(room.stop()).toBe(stopping);

		expect(room.send("more")).toEqual({
			status: "rejected",
			reason: "stopped",
		});
		expect(room.post("planner", "hello")).toEqual({
			status: "rejected",
			reason: "stopped",
		});
		expect(host.turns).toHaveLength(1);
	});

	it("replaces membership wholesale and turns in the new order", async () => {
		const { room, host } = makeRoom({
			roster: ["planner", "builder", "reviewer"],
		});

		expect(room.setMembers(["builder", "reviewer"])).toEqual({
			status: "ok",
			members: ["builder", "reviewer"],
		});
		expect(host.events.at(-1)).toEqual({
			kind: "members",
			room: "ship-it",
			members: ["builder", "reviewer"],
		});

		room.send("go");
		await settle(room);
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"builder",
			"reviewer",
		]);
	});

	it("validates membership before replacing and rejects a change while live", async () => {
		const { room } = makeRoom({
			roster: ["planner", "builder", "reviewer"],
			scripts: { planner: [hang] },
		});

		expect(room.setMembers(["planner"])).toEqual({
			status: "rejected",
			reason: "member_count",
		});
		expect(room.setMembers(["planner", "planner"])).toEqual({
			status: "rejected",
			reason: "duplicate_member",
		});
		expect(room.setMembers(["planner", "ghost"])).toEqual({
			status: "rejected",
			reason: "unknown_member",
		});
		expect(room.setMembers(["planner", "user"])).toEqual({
			status: "rejected",
			reason: "reserved_member",
		});
		expect(room.view().members).toEqual(["planner", "builder", "reviewer"]);

		room.send("go");
		expect(room.setMembers(["builder", "reviewer"])).toEqual({
			status: "rejected",
			reason: "busy",
		});
		await room.stop();
	});
});

describe("validateRoomMembers", () => {
	it("accepts a known roster in the order it was given", () => {
		expect(
			validateRoomMembers(["builder", "planner"], ["planner", "builder"]),
		).toEqual({ status: "ok", members: ["builder", "planner"] });
	});

	it("rejects member counts above six", () => {
		expect(
			validateRoomMembers(
				["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"],
				["alpha"],
			),
		).toEqual({ status: "rejected", reason: "member_count" });
	});

	it("rejects a repeated member", () => {
		expect(validateRoomMembers(["planner", "planner"], ["planner"])).toEqual({
			status: "rejected",
			reason: "duplicate_member",
		});
	});

	it("rejects a member that is not on the roster", () => {
		expect(validateRoomMembers(["planner", "ghost"], ["planner"])).toEqual({
			status: "rejected",
			reason: "unknown_member",
		});
	});

	it("rejects user and system even when the roster carries the name", () => {
		expect(
			validateRoomMembers(["planner", "user"], ["planner", "user"]),
		).toEqual({ status: "rejected", reason: "reserved_member" });
		expect(
			validateRoomMembers(["planner", "system"], ["planner", "system"]),
		).toEqual({ status: "rejected", reason: "reserved_member" });
	});
});
