import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { createRoomStore, newRoomState } from "../../src/rob/room-store.js";
import { buildServer } from "../../src/serve/server.js";
import { TeamHub } from "../../src/serve/team.js";
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

function createHub(provider: Provider): TeamHub {
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
		allowAll: createAllowAll(),
	});
}

const roomLimits = {
	minMembers: 2,
	maxMembers: 6,
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
			},
		});

		const rejected = await post("/api/rooms", {
			name: "solo",
			members: ["alpha"],
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toEqual({
			error: "A room needs 2 to 6 members.",
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
});
