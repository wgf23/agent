import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { MemoryEntry, Turn } from "../../src/bot/schema.js";
import { createBotStore } from "../../src/bot/store.js";
import { manualTimer, type Timer } from "../../src/bot/wake.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { ROOM_MAX_MEMBERS, ROOM_MIN_MEMBERS } from "../../src/rob/room.js";
import { createRoomStore, newRoomState } from "../../src/rob/room-store.js";
import { buildServer } from "../../src/serve/server.js";
import {
	summarizeSessions,
	TeamHub,
	UnknownMemoryEntryError,
} from "../../src/serve/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";

const settings: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-team-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-team-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-web-team-ws-"));
});

function slowProvider(): Provider {
	return {
		id: "slow",
		async *stream(request) {
			yield { type: "text_delta", text: "working" };
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) return resolve();
				request.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
		},
	};
}

function createHub(
	provider: Provider,
	allowAll = createAllowAll(),
	timer?: Timer,
): TeamHub {
	return new TeamHub({
		workspaceRoot,
		provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		robs: [{ name: "alpha", role: "a test rob" }],
		providerEnv: {},
		allowAll,
		timer,
	});
}

const roomLimits = {
	minMembers: ROOM_MIN_MEMBERS,
	maxMembers: ROOM_MAX_MEMBERS,
	maxRounds: 3,
	maxMessagesPerRun: 10,
	maxQueuedSends: 5,
};

function createRoomHub(provider: Provider): TeamHub {
	return new TeamHub({
		workspaceRoot,
		provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		robs: [
			{ name: "alpha", role: "a test rob" },
			{ name: "beta", role: "another test rob" },
		],
		rooms: [{ name: "ship-it", members: ["alpha", "beta"] }],
		providerEnv: {},
		allowAll: createAllowAll(),
	});
}

function collect(hub: TeamHub): ServerEvent[] {
	const events: ServerEvent[] = [];
	hub.subscribe((event) => events.push(event));
	return events;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 4000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const statusIs = (events: ServerEvent[], status: string) => () =>
	events.some(
		(event) => event.type === "bot_status" && event.state.status === status,
	);

describe("TeamHub", () => {
	it("lists configured robs in the hello snapshot", async () => {
		const hub = createHub(slowProvider());
		const hello = hub.hello();
		expect(hello.bots).toEqual([
			{
				name: "alpha",
				kind: "rob",
				role: "a test rob",
				model: "deepseek-flash",
				backend: "native",
			},
		]);
		expect(hello.sessions).toEqual([]);
		await hub.dispose();
	});

	it("reports an unknown bot instead of throwing", async () => {
		const hub = createHub(slowProvider());
		const events = collect(hub);
		hub.dispatch("ghost", "hi");
		expect(events).toContainEqual({
			type: "error",
			bot: "ghost",
			message: "Unknown bot: ghost",
		});
		await hub.dispose();
	});

	it("puts the queue's deadline on the approval it emits", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "bash",
					args: { command: "echo hi" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		hub.dispatch("alpha", "go");
		await waitFor(
			() => events.some((event) => event.type === "approval_requested"),
			"the approval request",
		);

		const requested = events.find(
			(event) => event.type === "approval_requested",
		);
		expect(requested).toMatchObject({
			type: "approval_requested",
			request: { bot: "alpha", toolName: "bash" },
		});
		const expiresAt =
			requested?.type === "approval_requested"
				? requested.request.expiresAt
				: 0;
		// The queue armed a window on this request, so the client has a real
		// deadline to count down rather than an invented one.
		expect(typeof expiresAt).toBe("number");
		expect(expiresAt as number).toBeGreaterThan(Date.now());

		hub.resolveApproval(
			requested?.type === "approval_requested" ? requested.request.id : "",
			"deny",
		);
		await waitFor(
			() => events.some((event) => event.type === "approval_resolved"),
			"the approval to resolve",
		);
		await hub.dispose();
	});

	it("announces the file a rob write wrote so the tree can refresh", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "write_file",
					args: { path: "notes/rob.txt", content: "hi" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		// The write_file tool asks by default, so the run needs allow-all on to
		// reach the write the tracker announces.
		const hub = createHub(provider, createAllowAll(true));
		const events = collect(hub);

		hub.dispatch("alpha", "write a note");
		await waitFor(
			() => events.some((event) => event.type === "files_changed"),
			"files_changed for the rob write",
		);

		expect(events).toContainEqual({
			type: "files_changed",
			paths: ["notes/rob.txt"],
		});
		await hub.dispose();
	});

	it("refuses a bad attachment with an error event, not a turn", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		hub.dispatch("alpha", "hi", [
			{ type: "image", mediaType: "image/bmp", data: "QkE=" },
		]);
		expect(events).toContainEqual({
			type: "error",
			bot: "alpha",
			message: expect.stringContaining("image/bmp"),
		});
		// Nothing reached the provider: the cap is enforced before the turn.
		expect(provider.requests).toEqual([]);
		await hub.dispose();
	});

	it("forwards a sub-agent's events to the wire under the parent's name", async () => {
		writeFileSync(path.join(workspaceRoot, "note.txt"), "hello sub\n");
		// The parent delegates, the sub-agent reads a file (so a real
		// tool_started is recorded), then both finish. The mock is shared, so
		// the turns run in order: parent, sub-agent step 1, sub-agent step 2,
		// parent step 2.
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "delegate",
					args: { task: "read a file" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{
					type: "tool_call",
					id: "call_2",
					name: "read_file",
					args: { path: "note.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "sub result" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "parent done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider, createAllowAll(true));
		const events = collect(hub);

		hub.dispatch("alpha", "delegate please");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "subagent" && event.entry.event.type === "done",
				),
			"the sub-agent's done event",
		);

		const subagents = events.filter((event) => event.type === "subagent");
		// Every entry is addressed to the bot that delegated, so the web keys
		// its feed by the parent name.
		expect(subagents.every((event) => event.bot === "alpha")).toBe(true);
		expect(
			subagents.find((event) => event.entry.event.type === "tool_started"),
		).toMatchObject({
			type: "subagent",
			bot: "alpha",
			entry: {
				parent: "alpha",
				id: "alpha-sub-0",
				event: { type: "tool_started", name: "read_file" },
			},
		});
		expect(
			subagents.find((event) => event.entry.event.type === "done"),
		).toMatchObject({
			type: "subagent",
			bot: "alpha",
			entry: { parent: "alpha", event: { type: "done", reason: "finished" } },
		});
		await hub.dispose();
	});

	it("interrupts a running turn and returns the rob to idle", async () => {
		const hub = createHub(slowProvider());
		const events = collect(hub);

		hub.dispatch("alpha", "hi");
		await waitFor(statusIs(events, "working"), "working status");

		hub.interrupt("alpha");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "agent_event" &&
						event.bot === "alpha" &&
						event.event.type === "done" &&
						event.event.reason === "aborted",
				),
			"aborted done",
		);
		await waitFor(statusIs(events, "idle"), "idle after interrupt");

		// The rob survived: a second dispatch still runs.
		hub.dispatch("alpha", "again");
		await waitFor(statusIs(events, "working"), "working after re-dispatch");
		hub.interrupt("alpha");
		await hub.dispose();
	});

	it("serves rooms in hello, streams their events, and answers the routes", async () => {
		const hub = createRoomHub(slowProvider());
		const events = collect(hub);
		expect(hub.hello().rooms).toEqual([
			{
				name: "ship-it",
				members: ["alpha", "beta"],
				coordinator: null,
				transcript: [],
				run: { phase: "idle" },
				pending: 0,
				deliverable: null,
				limits: roomLimits,
			},
		]);

		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const created = await post("/api/rooms", {
			name: "standup",
			members: ["alpha", "beta"],
			coordinator: "alpha",
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({
			ok: true,
			room: {
				name: "standup",
				members: ["alpha", "beta"],
				coordinator: "alpha",
				transcript: [],
				run: { phase: "idle" },
				pending: 0,
				deliverable: null,
				limits: roomLimits,
			},
		});

		const badCoordinator = await post("/api/rooms", {
			name: "unled",
			members: ["alpha", "beta"],
			coordinator: "ghost",
		});
		expect(badCoordinator.status).toBe(400);
		expect(await badCoordinator.json()).toEqual({
			error: "The coordinator must be a member of the room.",
		});

		const sent = await post("/api/rooms/send", {
			room: "standup",
			text: "status?",
		});
		expect(sent.status).toBe(200);
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "room" &&
						event.event.kind === "entry" &&
						event.event.entry.text === "status?",
				),
			"the room entry event",
		);
		expect(events).toContainEqual({
			type: "room",
			event: {
				kind: "members",
				room: "standup",
				members: ["alpha", "beta"],
				// The create body names alpha, so the wire event carries it.
				coordinator: "alpha",
			},
		});

		const rejected = await post("/api/rooms", {
			name: "solo",
			members: ["alpha"],
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toEqual({
			error: `A room needs ${ROOM_MIN_MEMBERS} to ${ROOM_MAX_MEMBERS} members.`,
		});

		const badInterrupt = await post("/api/rooms/interrupt", {});
		expect(badInterrupt.status).toBe(400);
		expect(await badInterrupt.json()).toEqual({ error: "expected {room}" });

		const interrupted = await post("/api/rooms/interrupt", {
			room: "standup",
		});
		expect(interrupted.status).toBe(200);
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "room" &&
						event.event.kind === "run_ended" &&
						event.event.outcome === "interrupted",
				),
			"the interrupted run",
		);

		await app.close();
		await hub.dispose();
	});

	it("guards the room PATCH with the admin token and writes both halves", async () => {
		const hub = createRoomHub(slowProvider());
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const patch = (route: string, body: unknown, token?: string) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					...(token === undefined ? {} : { "x-admin-token": token }),
				},
				body: JSON.stringify(body),
			});

		// The gate is resolved on the first admin request, so the env var has to
		// be in place before that call.
		const previous = process.env.MY_AGENT_ADMIN_TOKEN;
		process.env.MY_AGENT_ADMIN_TOKEN = "s3cret";
		try {
			// Missing and wrong tokens answer identically and write nothing: a
			// probe must not learn whether a token exists (AC-11b).
			for (const call of [
				patch("/api/rooms/ship-it", { coordinator: "beta" }),
				patch("/api/rooms/ship-it", { coordinator: "beta" }, "wrong"),
			]) {
				const denied = await call;
				expect(denied.status).toBe(403);
				expect(await denied.json()).toEqual({
					error: "Admin token required.",
				});
			}
			expect(hub.hello().rooms[0].coordinator).toBeNull();

			const updated = await patch(
				"/api/rooms/ship-it",
				{ members: ["beta", "alpha"], coordinator: "beta" },
				"s3cret",
			);
			expect(updated.status).toBe(200);
			const body = (await updated.json()) as {
				ok: boolean;
				room: { members: string[]; coordinator: string | null };
			};
			expect(body.ok).toBe(true);
			expect(body.room.members).toEqual(["beta", "alpha"]);
			expect(body.room.coordinator).toBe("beta");
			expect(hub.hello().rooms[0].coordinator).toBe("beta");

			const empty = await patch("/api/rooms/ship-it", {}, "s3cret");
			expect(empty.status).toBe(400);
			expect(await empty.json()).toEqual({
				error: "expected {members?, coordinator?} with at least one field",
			});

			const missing = await patch(
				"/api/rooms/nope",
				{ coordinator: null },
				"s3cret",
			);
			expect(missing.status).toBe(404);
		} finally {
			if (previous === undefined) delete process.env.MY_AGENT_ADMIN_TOKEN;
			else process.env.MY_AGENT_ADMIN_TOKEN = previous;
		}

		await app.close();
		await hub.dispose();
	});

	it("searches every room's transcript, newest matching room first", async () => {
		const store = createRoomStore({ workspaceRoot });
		await store.save({
			...newRoomState("ship-it", 1, ["alpha", "beta"], null),
			transcript: [
				{ id: 1, at: 10, kind: "user", text: "the NEEDLE is here" },
				{
					id: 2,
					at: 11,
					kind: "member",
					from: "alpha",
					text: "a needle answer",
				},
			],
		});
		await store.save({
			...newRoomState("later", 2, ["alpha", "beta"], null),
			transcript: [{ id: 1, at: 50, kind: "user", text: "needle again" }],
		});
		await store.save({
			...newRoomState("quiet", 3, ["alpha", "beta"], null),
			transcript: [{ id: 1, at: 99, kind: "user", text: "nothing to see" }],
		});

		const hub = createRoomHub(slowProvider());
		const results = await hub.search("NEEDLE");

		// A room folds to one session-shaped match: its name is the id and the
		// label, and only rooms carrying the query appear.
		expect(results).toEqual([
			{
				room: "later",
				matches: [
					{
						sessionId: "later",
						title: "later",
						firstUserText: "needle again",
						hits: [{ role: "user", text: "needle again", at: 50 }],
					},
				],
			},
			{
				room: "ship-it",
				matches: [
					{
						sessionId: "ship-it",
						title: "ship-it",
						firstUserText: "the NEEDLE is here",
						hits: [
							{ role: "user", text: "the NEEDLE is here", at: 10 },
							{ role: "assistant", text: "a needle answer", at: 11 },
						],
					},
				],
			},
		]);
		await expect(hub.search("absent")).resolves.toEqual([]);
		await hub.dispose();
	});

	it("searches only this workspace's room ledgers", async () => {
		const otherWorkspace = mkdtempSync(
			path.join(tmpdir(), "my-agent-web-team-other-"),
		);
		const otherStore = createRoomStore({ workspaceRoot: otherWorkspace });
		await otherStore.save({
			...newRoomState("elsewhere", 1, ["alpha", "beta"], null),
			transcript: [{ id: 1, at: 500, kind: "user", text: "needle elsewhere" }],
		});

		const store = createRoomStore({ workspaceRoot });
		await store.save({
			...newRoomState("ship-it", 1, ["alpha", "beta"], null),
			transcript: [{ id: 1, at: 10, kind: "user", text: "needle here" }],
		});

		const hub = createRoomHub(slowProvider());
		const results = await hub.search("needle");

		// Room ledgers are keyed by workspace root, so the other workspace's
		// newer match can never surface in this one.
		expect(results.map((entry) => entry.room)).toEqual(["ship-it"]);
		await hub.dispose();
	});

	it("opens a bot session, replays a stored one, and reports an unknown id", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "one" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		await hub.newSession("alpha");
		const opened = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(opened).toMatchObject({ bot: "alpha", messages: [] });
		const sessionId = opened?.type === "session_opened" ? opened.sessionId : "";

		hub.dispatch("alpha", "first");
		await waitFor(
			() => provider.requests.length === 1 && hub.states()[0].status === "idle",
			"the first turn",
		);

		await hub.openSession("alpha", "nope");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "error",
				bot: "alpha",
				message: expect.stringContaining("nope"),
			}),
		);

		await hub.openSession("alpha", sessionId);
		const replayed = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(replayed).toMatchObject({ bot: "alpha", sessionId });
		const messages =
			replayed?.type === "session_opened" ? replayed.messages : [];
		expect(
			messages.some(
				(message) => message.role === "user" && message.text.includes("first"),
			),
		).toBe(true);

		await hub.closeSession("alpha", sessionId);
		const sessionsEvent = events
			.filter((event) => event.type === "bot_sessions")
			.at(-1);
		expect(sessionsEvent).toMatchObject({
			type: "bot_sessions",
			bot: "alpha",
			sessions: [
				{
					id: sessionId,
					messageCount: 2,
					firstUserText: "[from user] first",
				},
			],
		});
		// A bot's list is its own event: the chat's `sessions` must not fire here.
		expect(events.some((event) => event.type === "sessions")).toBe(false);
		await hub.dispose();
	});

	it("summarizes a bot's sessions newest first with the right message count", () => {
		const turns = [
			{
				id: "trn_0000000000000000000000000000000a",
				seq: 1,
				sessionId: "chs_a",
				workspaceRoot,
				at: 10,
				wake: "user",
				messages: [
					{ role: "user", content: "hi a" },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
				],
			},
			{
				id: "trn_0000000000000000000000000000000b",
				seq: 2,
				sessionId: "chs_b",
				workspaceRoot,
				at: 20,
				wake: "user",
				messages: [
					{ role: "user", content: "hi b" },
					{ role: "assistant", content: [{ type: "text", text: "yo" }] },
					{ role: "user", content: "more b" },
				],
			},
			{
				id: "trn_0000000000000000000000000000000c",
				seq: 3,
				sessionId: "chs_a",
				workspaceRoot,
				at: 30,
				wake: "user",
				messages: [
					{ role: "user", content: "again a" },
					{ role: "assistant", content: [{ type: "text", text: "sure" }] },
				],
			},
		] satisfies Turn[];

		expect(summarizeSessions(turns)).toEqual([
			{
				id: "chs_a",
				updatedAt: 30,
				messageCount: 4,
				firstUserText: "hi a",
				title: null,
			},
			{
				id: "chs_b",
				updatedAt: 20,
				messageCount: 3,
				firstUserText: "hi b",
				title: null,
			},
		]);
	});

	it("reads the current transcript without clearing the rob's live history", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "hello there" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		hub.dispatch("alpha", "first");
		await waitFor(
			() => provider.requests.length === 1 && hub.states()[0].status === "idle",
			"the first turn",
		);
		const before = hub.states()[0].messageCount;

		const first = await hub.readTranscript("alpha");
		const second = await hub.readTranscript("alpha");
		expect(first).not.toBeNull();
		expect(second).toEqual(first);
		expect(
			first?.messages.some(
				(message) => message.role === "user" && message.text.includes("first"),
			),
		).toBe(true);
		expect(
			first?.messages.some(
				(message) =>
					message.role === "assistant" && message.text === "hello there",
			),
		).toBe(true);
		// The read is a replay; the rob's live transcript is untouched.
		expect(hub.states()[0].messageCount).toBe(before);
		expect(await hub.readTranscript("ghost")).toBeNull();
		await hub.dispose();
	});

	it("lists a bot's memory and forgets an entry by id", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: "a test rob",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000001",
			at: 1,
			kind: "fact",
			text: "the sky is teal",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(
			loaded.record,
			{
				id: "trn_00000000000000000000000000000001",
				seq: 1,
				sessionId: "chs_seed",
				workspaceRoot,
				at: 1,
				wake: "user",
				messages: [],
			},
			{ upsert: [fact], drop: [] },
		);
		if (!seeded.ok) throw new Error(seeded.error);

		const hub = createHub(slowProvider());
		expect(await hub.readMemory("alpha")).toEqual({
			bot: "alpha",
			entries: [{ id: fact.id, at: 1, kind: "fact", text: "the sky is teal" }],
		});
		expect(await hub.readMemory("ghost")).toBeNull();

		await expect(hub.forgetMemory("ghost", fact.id)).resolves.toBe(false);
		await hub.forgetMemory("alpha", fact.id);
		expect((await hub.readMemory("alpha"))?.entries).toEqual([]);
		const record = readFileSync(
			path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json"),
			"utf8",
		);
		expect(record).not.toContain(fact.id);
		await hub.dispose();
	});

	it("refuses to forget a memory id the record does not have", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: "a test rob",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000001",
			at: 1,
			kind: "fact",
			text: "the sky is teal",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(
			loaded.record,
			{
				id: "trn_00000000000000000000000000000001",
				seq: 1,
				sessionId: "chs_seed",
				workspaceRoot,
				at: 1,
				wake: "user",
				messages: [],
			},
			{ upsert: [fact], drop: [] },
		);
		if (!seeded.ok) throw new Error(seeded.error);
		const ledger = path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json");
		const before = readFileSync(ledger, "utf8");

		const hub = createHub(slowProvider());
		await expect(hub.forgetMemory("alpha", "mem_missing")).rejects.toThrow(
			UnknownMemoryEntryError,
		);
		// The failed forget wrote nothing.
		expect(readFileSync(ledger, "utf8")).toBe(before);
		// A real id still forgets.
		await hub.forgetMemory("alpha", fact.id);
		expect((await hub.readMemory("alpha"))?.entries).toEqual([]);
		await hub.dispose();
	});

	it("sets and clears a bot's wake and re-arms the live timer", async () => {
		writeFileSync(
			projectFilePath(workspaceRoot),
			`${JSON.stringify(
				{ robs: [{ name: "alpha", role: "a test rob" }] },
				null,
				2,
			)}\n`,
		);
		const manual = manualTimer();
		const hub = createHub(slowProvider(), undefined, manual.timer);

		await expect(hub.setWake("ghost", null)).resolves.toBe(false);

		await hub.setWake("alpha", { everyMs: 60000, prompt: "tick" });
		expect(hub.bots()[0].wake).toEqual({ everyMs: 60000, prompt: "tick" });
		expect(manual.pending()).toEqual([
			{ bot: "alpha", everyMs: 60000, text: "tick" },
		]);
		const saving = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(saving.robs[0].wake).toEqual({ everyMs: 60000, prompt: "tick" });

		await hub.setWake("alpha", null);
		expect(hub.bots()[0].wake).toBeUndefined();
		expect(manual.pending()).toEqual([]);
		const cleared = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(cleared.robs[0].wake).toBeUndefined();
		await hub.dispose();
	});
});
