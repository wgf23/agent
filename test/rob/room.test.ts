import { describe, expect, it, vi } from "vitest";
import {
	type DeliverableOutcome,
	ROOM_MAX_MEMBERS,
	ROOM_MAX_STORED_ENTRIES,
	ROOM_MIN_MEMBERS,
	ROOM_TURN_TIMEOUT_MS,
	Room,
	type RoomDeliverableDraft,
	type RoomEntry,
	type RoomEvent,
	type RoomHost,
	type RoomReplyOutcome,
	type RoomState,
	type RoomTurn,
	type RoomTurnResult,
	validateRoomMembers,
} from "../../src/rob/room.js";
import { newRoomState } from "../../src/rob/room-store.js";
import type { RobName } from "../../src/rob/types.js";
import { MemoryRoomLedger, memberNames, waitFor } from "./helpers.js";

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
	readonly deliverableDrafts: RoomDeliverableDraft[] = [];
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

	async writeDeliverable(
		draft: RoomDeliverableDraft,
	): Promise<DeliverableOutcome> {
		this.deliverableDrafts.push(draft);
		return {
			status: "written",
			path: "docs/deliverables/20260101T000000-ship-it.md",
		};
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
		readonly state?: RoomState;
		readonly coordinator?: RobName;
	} = {},
): { room: Room; host: FakeRoomHost; ledger: MemoryRoomLedger } {
	const members = options.members ?? ["planner", "builder", "reviewer"];
	const host = new FakeRoomHost({
		roster: options.roster ?? members,
		scripts: options.scripts,
		fallback: options.fallback,
		clock: options.clock,
	});
	const ledger = new MemoryRoomLedger();
	const room = new Room({
		state:
			options.state ??
			newRoomState("ship-it", 1000, members, options.coordinator ?? null),
		host,
		ledger,
	});
	host.attach(room);
	return { room, host, ledger };
}

/** A transcript that alternates user lines (odd ids) and planner replies, for
 *  the cap tests. */
function longTranscript(count: number): RoomEntry[] {
	return Array.from({ length: count }, (_, index) => {
		const id = index + 1;
		return id % 2 === 1
			? { id, at: 1000, kind: "user" as const, text: `m${id}` }
			: {
					id,
					at: 1000,
					kind: "member" as const,
					from: "planner" as const,
					text: `r${id}`,
				};
	});
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
			coordinator: null,
			transcript: [{ id: 1, at: 1000, kind: "user", text: "status?" }],
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
		expect(host.turns[2].turn.text).toContain("Round 2/3.");
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
				"Round 1/3.",
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
				"Round 2/3.",
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

	it("queues a second send while live and rejects a whitespace-only send", async () => {
		const { room } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang] },
		});

		room.send("one");
		expect(room.send("two")).toEqual({
			status: "queued",
			entry: { id: 2, at: 1000, kind: "user", text: "two" },
			waiting: 1,
		});
		expect(room.send("   ")).toEqual({ status: "rejected", reason: "empty" });
		expect(room.view().pending).toBe(1);
		await room.stop();

		const fresh = makeRoom();
		expect(fresh.room.send("   ")).toEqual({
			status: "rejected",
			reason: "empty",
		});
		expect(fresh.host.turns).toEqual([]);
		expect(fresh.room.view().transcript).toEqual([]);
	});

	it("starts a queued send after the live run ends", async () => {
		const { room, host } = makeRoom({ members: ["planner", "builder"] });

		expect(room.send("first")).toEqual({
			status: "started",
			entry: { id: 1, at: 1000, kind: "user", text: "first" },
		});
		expect(room.send("second")).toEqual({
			status: "queued",
			entry: { id: 2, at: 1000, kind: "user", text: "second" },
			waiting: 1,
		});
		expect(room.view().pending).toBe(1);

		await settle(room);

		expect(host.peakInFlight).toBe(1);
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
			"planner",
			"builder",
		]);
		expect(host.turns[2].turn.text).toContain("  user: second");
		expect(
			host.events
				.filter((event) => event.kind === "run_ended")
				.map((event) => event.outcome),
		).toEqual(["settled", "settled"]);
		expect(
			host.events
				.filter((event) => event.kind === "entry")
				.map((event) => event.entry.id),
		).toEqual([1, 2]);
		expect(room.view().pending).toBe(0);
	});

	it("keeps the queue across an interrupt and drains it afterwards", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang, pass] },
		});

		room.send("first");
		await drain();
		expect(host.turns).toHaveLength(1);
		room.send("second");

		room.interrupt();
		expect(room.view().run).toEqual({ phase: "idle" });
		await waitFor(() => host.turns.length === 3, "the queued send to start");
		await settle(room);

		expect(
			host.events
				.filter((event) => event.kind === "run_ended")
				.map((event) => event.outcome),
		).toEqual(["interrupted", "settled"]);
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"planner",
			"builder",
		]);
		expect(room.view().transcript.map((entry) => entry.id)).toEqual([1, 2]);
	});

	it("refuses a send at the queue cap with queue_full", async () => {
		const { room } = makeRoom({
			members: ["planner", "builder"],
			scripts: { planner: [hang] },
		});

		room.send("first");
		["second", "third", "fourth", "fifth", "sixth"].forEach((text, index) => {
			expect(room.send(text)).toEqual({
				status: "queued",
				entry: { id: index + 2, at: 1000, kind: "user", text },
				waiting: index + 1,
			});
		});
		expect(room.send("overflow")).toEqual({
			status: "rejected",
			reason: "queue_full",
		});
		expect(room.view().pending).toBe(5);
		expect(room.view().transcript).toHaveLength(6);
		await room.stop();
	});

	it("scopes an @all send to every member", async () => {
		const { room, host } = makeRoom();

		room.send("@all stand up");
		await settle(room);

		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
			"reviewer",
		]);
		expect(host.turns[0].turn.text).toContain(
			"Addressed: @planner, @builder, @reviewer.",
		);
	});

	it("skips a member who is no longer on the team and names them once", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder", "ghost"],
			roster: ["planner", "builder"],
		});

		room.send("who is left?");
		await settle(room);

		expect(room.view().transcript[1]).toEqual({
			id: 2,
			at: 1000,
			kind: "system",
			text: "No longer on the team: @ghost.",
		});
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
		]);
	});

	it("annotates a run that was open at load and leaves the room idle", () => {
		const state: RoomState = {
			...newRoomState("ship-it", 1000, ["planner", "builder"], null),
			transcript: [{ id: 1, at: 1000, kind: "user", text: "was running" }],
			queue: [{ entryId: 1, at: 1000 }],
			runOpen: true,
		};
		const { room, ledger } = makeRoom({
			members: ["planner", "builder"],
			state,
		});

		expect(room.view().run).toEqual({ phase: "idle" });
		expect(room.view().pending).toBe(1);
		expect(room.view().transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "was running" },
			{
				id: 2,
				at: 1000,
				kind: "system",
				text: "Run interrupted by a restart.",
			},
		]);
		expect(ledger.saves.at(-1)?.runOpen).toBe(false);
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
			coordinator: null,
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

	it("keeps a coordinator the new member list still holds and clears a dropped one", () => {
		const { room } = makeRoom({
			members: ["planner", "builder", "reviewer"],
			coordinator: "planner",
		});

		expect(room.setMembers(["planner", "builder"])).toEqual({
			status: "ok",
			members: ["planner", "builder"],
			coordinator: "planner",
		});
		expect(room.setMembers(["builder", "reviewer"])).toEqual({
			status: "ok",
			members: ["builder", "reviewer"],
			coordinator: null,
		});
		expect(room.view().coordinator).toBeNull();
		expect(room.state().coordinator).toBeNull();
	});

	it("asks the coordinator for one deliverable after the run settles", async () => {
		const { room, host, ledger } = makeRoom({
			members: ["planner", "builder"],
			coordinator: "planner",
			scripts: {
				planner: [
					post("working on it"),
					pass,
					post("The parser fix is ready."),
				],
				builder: [pass, pass],
			},
		});

		room.send("do the work");
		await settle(room);

		expect(host.deliverableDrafts).toEqual([
			{
				room: "ship-it",
				coordinator: "planner",
				task: "do the work",
				outcome: "settled",
				participants: ["planner", "builder"],
				transcript: [
					{ id: 1, at: 1000, kind: "user", text: "do the work" },
					{
						id: 2,
						at: 1000,
						kind: "member",
						from: "planner",
						text: "working on it",
					},
					{
						id: 3,
						at: 1000,
						kind: "member",
						from: "planner",
						text: "The parser fix is ready.",
					},
				],
				body: "The parser fix is ready.",
				at: 1000,
			},
		]);
		expect(room.view().transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "do the work" },
			{
				id: 2,
				at: 1000,
				kind: "member",
				from: "planner",
				text: "working on it",
			},
			{
				id: 3,
				at: 1000,
				kind: "member",
				from: "planner",
				text: "The parser fix is ready.",
			},
			{
				id: 4,
				at: 1000,
				kind: "system",
				text: "The deliverable was written to docs/deliverables/20260101T000000-ship-it.md.",
			},
		]);
		expect(room.view().deliverable).toEqual({
			at: 1000,
			path: "docs/deliverables/20260101T000000-ship-it.md",
			coordinator: "planner",
		});
		expect(ledger.saves.at(-1)?.deliverable).toEqual({
			at: 1000,
			path: "docs/deliverables/20260101T000000-ship-it.md",
			coordinator: "planner",
		});
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
			"planner",
			"builder",
			"planner",
		]);
		expect(host.turns[4].turn.text).toBe(
			[
				'The run in room "ship-it" ended after 2 rounds: settled.',
				"Compile the final deliverable now.",
				"Reply with room_reply; your reply becomes the deliverable body, and the room writes the file.",
				"",
				"Task: do the work",
				"",
				"Since your last turn:",
				"  (nothing new)",
			].join("\n"),
		);
	});

	it("strips mentions from the deliverable task and asks after the message cap", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			coordinator: "planner",
			scripts: {
				planner: [
					post("m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"),
					post("Final."),
				],
			},
		});

		room.send("@builder @planner go");
		await settle(room);

		expect(host.deliverableDrafts).toHaveLength(1);
		const draft = host.deliverableDrafts[0];
		expect(draft.task).toBe("go");
		expect(draft.outcome).toBe("message_cap");
		expect(draft.participants).toEqual(["planner", "builder"]);
		expect(draft.body).toBe("Final.");
		expect(draft.transcript.map((entry) => entry.id)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
		]);
		expect(draft.transcript.at(-1)).toEqual({
			id: 12,
			at: 1000,
			kind: "member",
			from: "planner",
			text: "Final.",
		});
	});

	it("writes no deliverable for a run that finished with another send queued", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			coordinator: "planner",
			scripts: { planner: [pass, hang], builder: [pass] },
		});

		room.send("first");
		room.send("second");
		await waitFor(() => host.turns.length >= 3, "the queued run to start");

		expect(room.view().pending).toBe(0);
		expect(room.view().run.phase).toBe("running");
		expect(host.deliverableDrafts).toEqual([]);

		room.interrupt();
		await settle(room);
		expect(host.deliverableDrafts).toEqual([]);
		expect(room.view().deliverable).toBeNull();
	});

	it("writes no deliverable when the run is interrupted or the room is stopped", async () => {
		const interrupted = makeRoom({
			members: ["planner", "builder"],
			coordinator: "planner",
			scripts: { planner: [hang] },
		});
		interrupted.room.send("go");
		await drain();
		interrupted.room.interrupt();
		await settle(interrupted.room);
		expect(interrupted.host.deliverableDrafts).toEqual([]);
		expect(interrupted.room.view().deliverable).toBeNull();

		const stopped = makeRoom({
			members: ["planner", "builder"],
			coordinator: "planner",
			scripts: { planner: [hang] },
		});
		stopped.room.send("go");
		await drain();
		await stopped.room.stop();
		expect(stopped.host.deliverableDrafts).toEqual([]);
	});

	it("writes no deliverable when the run budget expires", async () => {
		vi.useFakeTimers();
		try {
			const { room, host } = makeRoom({
				members: ["planner", "builder", "reviewer"],
				coordinator: "planner",
				clock: () => Date.now(),
				scripts: {
					planner: [post("one")],
					builder: [hang, hang],
					reviewer: [hang, hang],
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

			expect(host.events.at(-1)).toMatchObject({
				kind: "run_ended",
				outcome: "run_timeout",
			});
			expect(host.deliverableDrafts).toEqual([]);
			expect(room.view().deliverable).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("folds an over-cap transcript into one summary and keeps the recent window", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			state: {
				...newRoomState("ship-it", 1000, ["planner", "builder"], null),
				transcript: longTranscript(ROOM_MAX_STORED_ENTRIES + 5),
			},
		});

		room.send("new");
		await settle(room);

		const transcript = room.view().transcript;
		expect(transcript).toHaveLength(101);
		expect(transcript[0]).toEqual({
			id: 207,
			at: 1000,
			kind: "system",
			text: '[106 earlier entries compacted: user 53, planner 53; first lines: user: "m1" | planner: "r2" | user: "m3"]',
		});
		expect(transcript[1].id).toBe(107);
		expect(transcript.at(-1)?.id).toBe(206);
		expect(transcript.some((entry) => entry.id <= 106)).toBe(false);
		expect(
			host.events
				.filter((event) => event.kind === "entry")
				.map((event) => event.entry.id),
		).toEqual([206, 207]);
		const prompt = host.turns[0].turn.text;
		expect(prompt).toContain(
			'  system: [106 earlier entries compacted: user 53, planner 53; first lines: user: "m1" | planner: "r2" | user: "m3"]',
		);
		expect(prompt).toContain("  (earlier messages omitted)");
		expect(prompt).toContain("  user: m205");
		expect(prompt).toContain("  planner: r204");
		expect(prompt).toContain("  user: new");
		expect(prompt).not.toContain("  planner: r186");
	});

	it("folds mid-run and gives each cursor the summary without re-delivering seen entries", async () => {
		const { room, host } = makeRoom({
			members: ["planner", "builder"],
			state: {
				...newRoomState("ship-it", 1000, ["planner", "builder"], null),
				transcript: longTranscript(ROOM_MAX_STORED_ENTRIES - 2),
			},
			scripts: { planner: [post("x")], builder: [hang] },
		});

		room.send("first");
		await drain();
		expect(host.turns.map((entry) => entry.member)).toEqual([
			"planner",
			"builder",
		]);

		// A queued send lands while the builder's turn is in flight and pushes
		// the transcript over the cap.
		room.send("second");
		room.interrupt();
		await settle(room);
		await drain();

		expect(room.view().transcript[0]).toEqual({
			id: 202,
			at: 1000,
			kind: "system",
			text: '[101 earlier entries compacted: user 51, planner 50; first lines: user: "m1" | planner: "r2" | user: "m3"]',
		});
		await waitFor(() => host.turns.length >= 4, "the queued run to start");

		const plannerPrompt = host.turns[2].turn.text;
		expect(plannerPrompt).toContain(
			'  system: [101 earlier entries compacted: user 51, planner 50; first lines: user: "m1" | planner: "r2" | user: "m3"]',
		);
		expect(plannerPrompt).toContain("  user: second");
		expect(plannerPrompt).not.toContain("  user: m197");
		expect(plannerPrompt).not.toContain("  (earlier messages omitted)");

		const builderPrompt = host.turns[3].turn.text;
		expect(builderPrompt).toContain("  (earlier messages omitted)");
		expect(builderPrompt).toContain(
			'  system: [101 earlier entries compacted: user 51, planner 50; first lines: user: "m1" | planner: "r2" | user: "m3"]',
		);
		expect(builderPrompt).toContain("  user: second");
		expect(builderPrompt).toContain("  user: m197");
	});
});

describe("validateRoomMembers", () => {
	it("pins the member cap", () => {
		// AC-1 取值锚：此处故意写字面量；单靠派生会让改回 6 静默通过。
		// 全仓仅此一处允许出现上限的字面值。
		expect(ROOM_MAX_MEMBERS).toBe(20);
	});

	it("accepts a known roster in the order it was given", () => {
		expect(
			validateRoomMembers(["builder", "planner"], ["planner", "builder"]),
		).toEqual({ status: "ok", members: ["builder", "planner"] });
	});

	it("accepts the full member range and rejects one past it", () => {
		// Derived, never literal: a hard-coded 20 here would drift the moment
		// ROOM_MAX_MEMBERS moves, which is exactly what this test guards.
		const roster = memberNames(ROOM_MAX_MEMBERS + 1);
		const full = memberNames(ROOM_MAX_MEMBERS);
		expect(validateRoomMembers(full, roster)).toEqual({
			status: "ok",
			members: full,
		});
		expect(
			validateRoomMembers(memberNames(ROOM_MAX_MEMBERS - 1), roster),
		).toEqual({ status: "ok", members: memberNames(ROOM_MAX_MEMBERS - 1) });
		expect(
			validateRoomMembers(memberNames(ROOM_MAX_MEMBERS + 1), roster),
		).toEqual({ status: "rejected", reason: "member_count" });
	});

	it("rejects a room with too few members", () => {
		const roster = memberNames(ROOM_MIN_MEMBERS);
		expect(validateRoomMembers(memberNames(ROOM_MIN_MEMBERS), roster)).toEqual({
			status: "ok",
			members: memberNames(ROOM_MIN_MEMBERS),
		});
		expect(
			validateRoomMembers(memberNames(ROOM_MIN_MEMBERS - 1), roster),
		).toEqual({
			status: "rejected",
			reason: "member_count",
		});
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
