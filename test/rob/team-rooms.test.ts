import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider, StreamEvent } from "../../src/providers/types.js";
import type { TeamEvent } from "../../src/rob/events.js";
import type { RoomConfig, RoomEvent, RoomState } from "../../src/rob/room.js";
import {
	createRoomStore,
	newRoomState,
	type StoredRoom,
} from "../../src/rob/room-store.js";
import { Team } from "../../src/rob/team.js";
import {
	createMockProvider,
	type MockProvider,
} from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-team-rooms-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function makeTeam(
	providers: Record<string, MockProvider>,
	rooms?: readonly RoomConfig[],
): Team {
	return new Team({
		robs: [
			{ name: "planner", role: "plan" },
			{ name: "builder", role: "build" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: (rob) => providers[rob.name],
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
		rooms,
	});
}

function readLedger(name: string): StoredRoom | null {
	const result = createRoomStore({ workspaceRoot: workspace }).read(name);
	if (!result.ok) throw new Error(result.error);
	return result.record;
}

async function seedLedger(state: RoomState): Promise<void> {
	const saved = await createRoomStore({ workspaceRoot: workspace }).save(state);
	if (!saved.ok) throw new Error(saved.error);
}

const done = (text: string): StreamEvent[] => [
	{ type: "text_delta", text },
	{ type: "finish", reason: "stop" },
];

const roomReply = (text: string): StreamEvent[] => [
	{ type: "tool_call", id: "call_1", name: "room_reply", args: { text } },
	{ type: "finish", reason: "tool_calls" },
];

const ROOM_LIMITS = {
	minMembers: 2,
	maxMembers: 6,
	maxRounds: 3,
	maxMessagesPerRun: 10,
	maxQueuedSends: 5,
};

describe("Team rooms", () => {
	it("runs a room through a real Team and settles on a silent round", async () => {
		const providers = {
			planner: createMockProvider([
				roomReply("I can take the parser fix."),
				done("ok"),
				done("nothing to add"),
			]),
			builder: createMockProvider([done("nothing from me"), done("quiet")]),
		};
		const team = makeTeam(providers);
		const teamEvents: TeamEvent[] = [];
		const roomEvents: RoomEvent[] = [];
		team.subscribe((event) => {
			teamEvents.push(event);
			if (event.kind === "room") roomEvents.push(event.event);
		});

		const created = team.createRoom({
			name: "ship-it",
			members: ["planner", "builder"],
		});
		expect(created).toEqual({
			status: "created",
			room: {
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: null,
				transcript: [],
				run: { phase: "idle" },
				pending: 0,
				deliverable: null,
				limits: ROOM_LIMITS,
			},
		});
		expect(teamEvents[0]).toEqual({
			kind: "room",
			event: {
				kind: "members",
				room: "ship-it",
				members: ["planner", "builder"],
			},
		});

		team.start();
		expect(team.busy()).toBe(false);
		expect(team.sendToRoom("ship-it", "who takes the parser?")).toEqual({
			status: "started",
			entry: {
				id: 1,
				at: expect.any(Number),
				kind: "user",
				text: "who takes the parser?",
			},
		});
		expect(team.busy()).toBe(true);

		await waitFor(
			() => team.rooms()[0].run.phase === "idle",
			"the room to settle",
			5000,
		);
		expect(team.busy()).toBe(false);

		expect(team.rooms()).toEqual([
			{
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: null,
				transcript: [
					{
						id: 1,
						at: expect.any(Number),
						kind: "user",
						text: "who takes the parser?",
					},
					{
						id: 2,
						at: expect.any(Number),
						kind: "member",
						from: "planner",
						text: "I can take the parser fix.",
					},
				],
				run: { phase: "idle" },
				pending: 0,
				deliverable: null,
				limits: ROOM_LIMITS,
			},
		]);
		expect(roomEvents.filter((event) => event.kind === "turn")).toEqual([
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
		expect(roomEvents.at(-1)).toEqual({
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

		const plannerTools = providers.planner.requests[0].tools.map(
			(tool) => tool.name,
		);
		expect(plannerTools).toContain("room_reply");
		expect(providers.planner.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: [
				"[room:ship-it] Round 1/3.",
				"Since your last turn:",
				"  user: who takes the parser?",
				"10 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		});
		expect(providers.builder.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: [
				"[room:ship-it] Round 1/3.",
				"Since your last turn:",
				"  user: who takes the parser?",
				"  planner: I can take the parser fix.",
				"9 messages left in this send.",
				"",
				"Reply with room_reply if you have something brief to add.",
				"End your turn without calling room_reply to pass.",
			].join("\n"),
		});

		// The bridge is bound per turn: a plain dispatch never sees room_reply.
		team.dispatch("builder", "hello");
		await waitFor(
			() =>
				providers.builder.requests.length === 3 &&
				team.statuses()[1].status === "idle",
			"the builder's plain turn",
		);
		expect(
			providers.builder.requests[2].tools.map((tool) => tool.name),
		).not.toContain("room_reply");
		expect(providers.builder.requests[2].messages.at(-1)).toEqual({
			role: "user",
			content: "[from user] hello",
		});
		await team.stop();
	});

	it("validates creation and membership at the team boundary", () => {
		const providers = {
			planner: createMockProvider([]),
			builder: createMockProvider([]),
		};
		const team = makeTeam(providers, [
			{ name: "ship-it", members: ["planner", "builder"] },
		]);

		expect(team.rooms()).toEqual([
			{
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: null,
				transcript: [],
				run: { phase: "idle" },
				pending: 0,
				deliverable: null,
				limits: ROOM_LIMITS,
			},
		]);
		expect(
			team.createRoom({ name: "ship-it", members: ["planner", "builder"] }),
		).toEqual({ status: "rejected", reason: "duplicate" });
		expect(
			team.createRoom({ name: "planner", members: ["planner", "builder"] }),
		).toEqual({ status: "rejected", reason: "name_taken" });
		expect(
			team.createRoom({ name: "Bad Name", members: ["planner", "builder"] }),
		).toEqual({ status: "rejected", reason: "invalid_name" });
		expect(team.createRoom({ name: "solo", members: ["planner"] })).toEqual({
			status: "rejected",
			reason: "member_count",
		});
		expect(
			team.createRoom({ name: "pair", members: ["planner", "ghost"] }),
		).toEqual({ status: "rejected", reason: "unknown_member" });
		expect(
			team.createRoom({ name: "twice", members: ["planner", "planner"] }),
		).toEqual({ status: "rejected", reason: "duplicate_member" });
		expect(
			team.createRoom({ name: "voices", members: ["planner", "user"] }),
		).toEqual({ status: "rejected", reason: "reserved_member" });
		expect(
			team.createRoom({
				name: "unled",
				members: ["planner", "builder"],
				coordinator: "ghost",
			}),
		).toEqual({ status: "rejected", reason: "coordinator_not_member" });
		expect(team.rooms()).toHaveLength(1);

		expect(team.sendToRoom("ghost", "hi")).toEqual({
			status: "rejected",
			reason: "unknown_room",
		});
		expect(team.setRoomMembers("ghost", ["planner", "builder"])).toEqual({
			status: "rejected",
			reason: "unknown_room",
		});
		expect(team.setRoomMembers("ship-it", ["planner"])).toEqual({
			status: "rejected",
			reason: "member_count",
		});
		expect(team.setRoomMembers("ship-it", ["builder", "planner"])).toEqual({
			status: "ok",
			members: ["builder", "planner"],
			coordinator: null,
		});
		expect(team.rooms()[0].members).toEqual(["builder", "planner"]);
		expect(team.sendToRoom("ship-it", "   ")).toEqual({
			status: "rejected",
			reason: "empty",
		});
	});

	it("interrupts a live room run and stops rooms before robs", async () => {
		const team = new Team({
			robs: [
				{ name: "planner", role: "plan" },
				{ name: "builder", role: "build" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => hangingProvider(),
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			rooms: [{ name: "ship-it", members: ["planner", "builder"] }],
		});
		const roomEvents: RoomEvent[] = [];
		team.subscribe((event) => {
			if (event.kind === "room") roomEvents.push(event.event);
		});

		team.start();
		team.sendToRoom("ship-it", "go");
		await waitFor(() => team.busy(), "the room to run");
		await waitFor(
			() => team.statuses().some((entry) => entry.status === "working"),
			"a member mid-turn",
		);

		team.interruptRoom("ship-it");
		await waitFor(() => team.rooms()[0].run.phase === "idle", "the run to end");
		expect(roomEvents.at(-1)).toMatchObject({
			kind: "run_ended",
			outcome: "interrupted",
		});

		await team.stop();
		expect(team.busy()).toBe(false);
		expect(team.statuses().map((entry) => entry.status)).toEqual([
			"stopped",
			"stopped",
		]);
		expect(team.sendToRoom("ship-it", "again")).toEqual({
			status: "rejected",
			reason: "stopped",
		});
	});

	it("writes a seed ledger for a configured room, coordinator included", async () => {
		const providers = {
			planner: createMockProvider([]),
			builder: createMockProvider([]),
		};
		makeTeam(providers, [
			{
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: "planner",
			},
		]);

		await waitFor(() => readLedger("ship-it") !== null, "the seed ledger");
		expect(readLedger("ship-it")).toMatchObject({
			version: 1,
			workspaceRoot: workspace,
			name: "ship-it",
			members: ["planner", "builder"],
			coordinator: "planner",
			transcript: [],
			queue: [],
			runOpen: false,
			deliverable: null,
		});
	});

	it("writes the coordinator's deliverable into the workspace after the room settles", async () => {
		const providers = {
			planner: createMockProvider([
				done("nothing to add"),
				roomReply("The parser fix is ready."),
			]),
			builder: createMockProvider([done("quiet")]),
		};
		const team = makeTeam(providers, [
			{
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: "planner",
			},
		]);
		team.start();
		team.sendToRoom("ship-it", "do the work");

		await waitFor(
			() => team.rooms()[0].deliverable !== null,
			"the deliverable",
			5000,
		);
		const room = team.rooms()[0];
		const ref = room.deliverable;
		if (ref === null) throw new Error("no deliverable ref");
		expect(ref.path).toMatch(
			/^docs\/deliverables\/\d{8}T\d{6}-do-the-work\.md$/,
		);
		expect(ref.coordinator).toBe("planner");
		expect(room.coordinator).toBe("planner");
		expect(room.transcript).toEqual([
			{ id: 1, at: expect.any(Number), kind: "user", text: "do the work" },
			{
				id: 2,
				at: expect.any(Number),
				kind: "member",
				from: "planner",
				text: "The parser fix is ready.",
			},
			{
				id: 3,
				at: expect.any(Number),
				kind: "system",
				text: `The deliverable was written to ${ref.path}.`,
			},
		]);

		const written = await readFile(path.join(workspace, ref.path), "utf8");
		expect(written).toContain("# do the work");
		expect(written).toContain("- Room: ship-it");
		expect(written).toContain("- Coordinator: planner");
		expect(written).toContain("- Outcome: settled");
		expect(written).toContain("- Participants: planner, builder");
		expect(written).toContain("## Room");
		expect(written).toContain("user: do the work");
		expect(written).toContain("planner: The parser fix is ready.");
		expect(written).toContain("## Deliverable");
		expect(written).toContain("The parser fix is ready.");

		const wrapUp = providers.planner.requests[1]?.messages.at(-1);
		expect(wrapUp?.content).toContain(
			'The run in room "ship-it" ended after 1 round: settled.',
		);
		expect(wrapUp?.content).toContain("Task: do the work");
		expect(
			providers.planner.requests[1]?.tools.map((tool) => tool.name),
		).toContain("room_reply");

		await waitFor(
			() => readLedger("ship-it")?.deliverable !== null,
			"the ledger deliverable",
		);
		expect(readLedger("ship-it")?.deliverable).toEqual({
			at: expect.any(Number),
			path: ref.path,
			coordinator: "planner",
		});
		await team.stop();
	});

	it("names a coordinator the config and the ledger disagree on", async () => {
		await seedLedger(
			newRoomState("ship-it", 1000, ["planner", "builder"], "planner"),
		);
		const providers = {
			planner: createMockProvider([]),
			builder: createMockProvider([]),
		};
		// No coordinator in config: the ledger's coordinator stays in charge.
		const team = makeTeam(providers, [
			{ name: "ship-it", members: ["planner", "builder"] },
		]);

		const [room] = team.rooms();
		expect(room.coordinator).toBe("planner");
		expect(room.transcript).toEqual([
			{
				id: 1,
				at: expect.any(Number),
				kind: "system",
				text: "my-agent.json disagrees with this room's saved state (coordinator is now planner, not none). The saved state is used; edit the room to change it.",
			},
		]);
	});

	it("keeps the ledger's members and names the config disagreement", async () => {
		await seedLedger({
			...newRoomState("ship-it", 1000, ["planner", "builder"], null),
			transcript: [
				{ id: 1, at: 1000, kind: "user", text: "saved message" },
				{
					id: 2,
					at: 1000,
					kind: "member",
					from: "planner",
					text: "saved reply",
				},
			],
		});
		const providers = {
			planner: createMockProvider([]),
			builder: createMockProvider([]),
		};
		const team = makeTeam(providers, [
			{ name: "ship-it", members: ["builder", "planner"] },
		]);

		const [room] = team.rooms();
		expect(room.members).toEqual(["planner", "builder"]);
		expect(room.transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "saved message" },
			{
				id: 2,
				at: 1000,
				kind: "member",
				from: "planner",
				text: "saved reply",
			},
			{
				id: 3,
				at: expect.any(Number),
				kind: "system",
				text: "my-agent.json disagrees with this room's saved state (members are now planner, builder, not builder, planner). The saved state is used; edit the room to change it.",
			},
		]);
	});

	it("annotates a run open at load and resumes its queue on start", async () => {
		await seedLedger({
			...newRoomState("ship-it", 1000, ["planner", "builder"], null),
			transcript: [{ id: 1, at: 1000, kind: "user", text: "run me" }],
			queue: [{ entryId: 1, at: 1000 }],
			runOpen: true,
		});
		const providers = {
			planner: createMockProvider([done("quiet"), done("quiet")]),
			builder: createMockProvider([done("quiet"), done("quiet")]),
		};
		// No config: the ledger alone owns this room after a restart.
		const team = makeTeam(providers);

		const [loaded] = team.rooms();
		expect(loaded.transcript).toEqual([
			{ id: 1, at: 1000, kind: "user", text: "run me" },
			{
				id: 2,
				at: expect.any(Number),
				kind: "system",
				text: "Run interrupted by a restart.",
			},
		]);
		expect(loaded.pending).toBe(1);

		team.start();
		await waitFor(
			() =>
				team.rooms()[0].run.phase === "idle" && team.rooms()[0].pending === 0,
			"the queued send to run",
			5000,
		);

		expect(team.rooms()[0].transcript.map((entry) => entry.id)).toEqual([1, 2]);
		expect(providers.planner.requests).toHaveLength(1);
		expect(providers.builder.requests).toHaveLength(1);
		await team.stop();
	});

	it("still rejects an invalid configured room at construction", () => {
		const providers = {
			planner: createMockProvider([]),
			builder: createMockProvider([]),
		};
		expect(() =>
			makeTeam(providers, [{ name: "solo", members: ["planner"] }]),
		).toThrow('Invalid room "solo" in TeamOptions: member_count.');
		expect(() =>
			makeTeam(providers, [
				{ name: "Bad Name", members: ["planner", "builder"] },
			]),
		).toThrow('Invalid room "Bad Name" in TeamOptions: invalid_name.');
	});
});

// Holds its stream open until the turn is aborted, so a room run stays live
// until the test interrupts or stops it.
function hangingProvider(): Provider {
	return {
		id: "hang",
		async *stream(request) {
			yield { type: "text_delta", text: "thinking" };
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted === true) {
					resolve();
					return;
				}
				request.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
		},
	};
}
