import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "../../src/bot/schema.js";
import { createBotStore } from "../../src/bot/store.js";
import { type ManualTimer, manualTimer } from "../../src/bot/wake.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { CompositeHub } from "../../src/serve/composite.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";
import { SoloHub } from "../../src/serve/solo.js";
import { TeamHub } from "../../src/serve/team.js";
import { newSession } from "../../src/session/store.js";
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

const ROB = { name: "alpha", role: "a test rob" };

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-bot-routes-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-bot-routes-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-bot-routes-ws-"));
	writeFileSync(
		projectFilePath(workspaceRoot),
		`${JSON.stringify({ robs: [ROB] }, null, 2)}\n`,
	);
});

function hubOptions(provider: Provider) {
	return {
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
		allowAll: createAllowAll(),
	};
}

function makeHub(provider: Provider, manual?: ManualTimer): CompositeHub {
	const options = hubOptions(provider);
	const workspace = new SoloHub(options, {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
	const robs = new TeamHub({
		...options,
		robs: [ROB],
		providerEnv: {},
		timer: manual?.timer,
	});
	return new CompositeHub(workspace, robs, workspaceRoot);
}

async function startServer(hub: Hub) {
	const app = await buildServer(hub, undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, port };
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

describe("bot ledger routes", () => {
	it("serves a bot's transcript after a turn and 404s an unknown bot", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "pong" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = makeHub(provider);
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		expect(
			(await post("/api/send", { bot: "alpha", text: "ping" })).status,
		).toBe(200);
		await waitFor(
			() =>
				provider.requests.length === 1 &&
				hub
					.hello()
					.states.some(
						(state) => state.bot === "alpha" && state.status === "idle",
					),
			"the rob's turn",
		);

		const first = await get("/api/bots/alpha/transcript");
		expect(first.status).toBe(200);
		const body = (await first.json()) as {
			bot: string;
			sessionId: string;
			messages: Array<{ role: string; text: string }>;
			sessions: Array<{ id: string; messageCount: number }>;
		};
		expect(body.bot).toBe("alpha");
		expect(typeof body.sessionId).toBe("string");
		// One read fills the sidebar's list too, with the session the current
		// transcript belongs to.
		expect(body.sessions).toEqual([
			expect.objectContaining({ id: body.sessionId, messageCount: 2 }),
		]);
		expect(
			body.messages.some(
				(message) => message.role === "user" && message.text.includes("ping"),
			),
		).toBe(true);
		expect(
			body.messages.some(
				(message) => message.role === "assistant" && message.text === "pong",
			),
		).toBe(true);

		const second = await get("/api/bots/alpha/transcript");
		expect(await second.json()).toEqual(body);
		expect((await get("/api/bots/ghost/transcript")).status).toBe(404);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("lists and forgets memory and persists the removal", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: ROB.role,
			model: settings.model,
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

		const hub = makeHub(createMockProvider([]));
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const listed = await get("/api/bots/alpha/memory");
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({
			bot: "alpha",
			entries: [{ id: fact.id, at: 1, kind: "fact", text: "the sky is teal" }],
		});

		expect((await post("/api/bots/alpha/memory/forget", {})).status).toBe(400);
		expect(
			(await post("/api/bots/ghost/memory/forget", { id: fact.id })).status,
		).toBe(404);
		// An id the bot's record has no entry for is a 404, not a
		// success.
		expect(
			(await post("/api/bots/alpha/memory/forget", { id: "mem_missing" }))
				.status,
		).toBe(404);

		const forgotten = await post("/api/bots/alpha/memory/forget", {
			id: fact.id,
		});
		expect(forgotten.status).toBe(200);
		const after = (await (await get("/api/bots/alpha/memory")).json()) as {
			entries: unknown[];
		};
		expect(after.entries).toEqual([]);
		const record = readFileSync(
			path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json"),
			"utf8",
		);
		expect(record).not.toContain(fact.id);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("writes and clears a wake and arms the live timer", async () => {
		const manual = manualTimer();
		const hub = makeHub(createMockProvider([]), manual);
		const { app, port } = await startServer(hub);
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const bad = await post("/api/bots/alpha/wake", {});
		expect(bad.status).toBe(400);
		expect((await post("/api/bots/ghost/wake", { clear: true })).status).toBe(
			404,
		);

		const set = await post("/api/bots/alpha/wake", {
			everyMs: 60000,
			prompt: "tick",
		});
		expect(set.status).toBe(200);
		const saved = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(saved.robs[0].wake).toEqual({ everyMs: 60000, prompt: "tick" });
		expect(hub.hello().bots.find((bot) => bot.name === "alpha")?.wake).toEqual({
			everyMs: 60000,
			prompt: "tick",
		});
		expect(manual.pending()).toEqual([
			{ bot: "alpha", everyMs: 60000, text: "tick" },
		]);

		const clear = await post("/api/bots/alpha/wake", { clear: true });
		expect(clear.status).toBe(200);
		const cleared = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(cleared.robs[0].wake).toBeUndefined();
		expect(manual.pending()).toEqual([]);
		expect(
			hub.hello().bots.find((bot) => bot.name === "alpha")?.wake,
		).toBeUndefined();

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("edits and deletes a bot through the routes", async () => {
		const hub = makeHub(createMockProvider([]));
		const { app, port } = await startServer(hub);
		const request = (method: string, route: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method,
				...(body === undefined
					? {}
					: {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}),
			});

		const ghost = await request("DELETE", "/api/bots/ghost");
		expect(ghost.status).toBe(404);
		expect(await ghost.json()).toEqual({ error: "Unknown bot: ghost" });

		const bad = await request("PATCH", "/api/bots/alpha", {
			role: "x",
			model: "",
		});
		expect(bad.status).toBe(400);

		const edited = await request("PATCH", "/api/bots/alpha", {
			role: "the edited rob",
			model: "deepseek-chat",
		});
		expect(edited.status).toBe(200);
		expect(await edited.json()).toMatchObject({
			ok: true,
			bot: { name: "alpha", role: "the edited rob", model: "deepseek-chat" },
		});
		expect(hub.hello().bots.find((bot) => bot.name === "alpha")).toMatchObject({
			name: "alpha",
			role: "the edited rob",
			model: "deepseek-chat",
		});

		const deleted = await request("DELETE", "/api/bots/alpha");
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({
			ok: true,
			bot: { name: "alpha" },
		});
		expect(hub.hello().bots.filter((bot) => bot.kind === "rob")).toEqual([]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("returns 501 when the hub cannot serve the routes", async () => {
		const hub = new SoloHub(hubOptions(createMockProvider([])), {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		expect((await get("/api/bots/assistant/transcript")).status).toBe(501);
		expect((await get("/api/bots/assistant/memory")).status).toBe(501);
		expect(
			(await post("/api/bots/assistant/memory/forget", { id: "mem_x" })).status,
		).toBe(501);
		expect(
			(await post("/api/bots/assistant/wake", { clear: true })).status,
		).toBe(501);
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/api/bots/assistant`, {
					method: "DELETE",
				})
			).status,
		).toBe(501);
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/api/bots/assistant`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ role: "x" }),
				})
			).status,
		).toBe(501);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
