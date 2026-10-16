import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createBotStore } from "../../src/bot/store.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { CompositeHub } from "../../src/serve/composite.js";
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
const THREAD = "chs_context_seed";

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-context-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-context-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-context-ws-"));
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

function makeHub(provider: Provider): CompositeHub {
	const options = hubOptions(provider);
	const workspace = new SoloHub(options, {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
	const robs = new TeamHub({ ...options, robs: [ROB], providerEnv: {} });
	return new CompositeHub(workspace, robs, workspaceRoot);
}

// Seeds one thread's turn and rolling summary, so the route has a known thread
// to read regardless of the random channel id the live team opens.
async function seedLedger(): Promise<void> {
	const store = createBotStore();
	const loaded = await store.load("alpha", {
		role: ROB.role,
		model: settings.model,
	});
	if (!loaded.ok) throw new Error(loaded.error);
	const seeded = await store.commit(loaded.record, {
		id: "trn_00000000000000000000000000000001",
		seq: 1,
		sessionId: THREAD,
		workspaceRoot,
		at: 1,
		wake: "user",
		messages: [{ role: "user", content: "hello" }],
	});
	if (!seeded.ok) throw new Error(seeded.error);
	const summary = await store.saveMemory(
		"alpha",
		{ upsert: [], drop: [] },
		{ id: THREAD, summary: { summary: "rolling summary", summaryAt: 5 } },
	);
	if (!summary.ok) throw new Error(summary.error);
}

async function startServer(hub: CompositeHub | SoloHub) {
	const app = await buildServer(hub, undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, port };
}

describe("bot context route", () => {
	it("serves the assembled layers, dropped list, and thread summary", async () => {
		await seedLedger();
		const provider = createMockProvider([]);
		const hub = makeHub(provider);
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
		const post = (route: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		// Focus the seeded thread so the readout is not the live random channel.
		const opened = await post("/api/sessions/open", {
			bot: "alpha",
			id: THREAD,
		});
		expect(opened.status).toBe(200);

		const first = await get("/api/bots/alpha/context");
		expect(first.status).toBe(200);
		const body = await first.json();
		// Literal token counts for the seed: l0 is the 20k left after the three
		// quotas; l1 is "hello" (5 chars -> 2 tokens); l2 is "rolling summary"
		// (15 chars -> 4 tokens); l3 has no retrieval and l4 has no inbound.
		expect(body).toEqual({
			layers: { l0: 20000, l1: 2, l2: 4, l3: 0, l4: 0, included: 6 },
			dropped: [],
			summary: "rolling summary",
		});

		// The read is pure: no provider turn was ever requested.
		expect(provider.requests).toEqual([]);

		// The same store reads back the same layers (R6/R10 determinism).
		const second = await get("/api/bots/alpha/context");
		expect(await second.json()).toEqual(body);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("404s an unknown bot with the memory route's error shape", async () => {
		const hub = makeHub(createMockProvider([]));
		const { app, port } = await startServer(hub);
		const response = await fetch(
			`http://127.0.0.1:${port}/api/bots/ghost/context`,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Unknown bot: ghost" });

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("returns 501 when the hub cannot read bot context", async () => {
		const hub = new SoloHub(hubOptions(createMockProvider([])), {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const { app, port } = await startServer(hub);
		const response = await fetch(
			`http://127.0.0.1:${port}/api/bots/assistant/context`,
		);
		expect(response.status).toBe(501);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
