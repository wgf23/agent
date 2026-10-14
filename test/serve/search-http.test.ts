import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "../../shared/protocol.js";
import { createBotStore } from "../../src/bot/store.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { CompositeHub } from "../../src/serve/composite.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";
import { SoloHub } from "../../src/serve/solo.js";
import { TeamHub } from "../../src/serve/team.js";
import { newSession, saveSession } from "../../src/session/store.js";
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
		path.join(tmpdir(), "my-agent-search-http-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-search-http-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-search-http-ws-"));
});

function hubOptions() {
	return {
		workspaceRoot,
		provider: createMockProvider([]),
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

async function startServer(hub: Hub) {
	const app = await buildServer(hub, undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, port };
}

describe("GET /api/search", () => {
	it("400s a blank query, echoes a real one, and groups bot hits", async () => {
		const chat = newSession(workspaceRoot, settings.model);
		chat.messages = [{ role: "user", content: "the needle in chat" }];
		await saveSession(chat);

		const store = createBotStore();
		const loaded = await store.load(ROB.name, {
			role: ROB.role,
			model: settings.model,
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const committed = await store.commit(loaded.record, {
			id: "trn_00000000000000000000000000000001",
			seq: 1,
			sessionId: "chs_bot",
			workspaceRoot,
			at: 7,
			wake: "user",
			messages: [
				{ role: "user", content: "the needle in a bot" },
				{
					role: "assistant",
					content: [{ type: "text", text: "a needle answer" }],
				},
			],
		});
		if (!committed.ok) throw new Error(committed.error);

		const options = hubOptions();
		const workspace = new SoloHub(options, {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const robs = new TeamHub({ ...options, robs: [ROB], providerEnv: {} });
		const hub = new CompositeHub(workspace, robs, workspaceRoot);
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		expect((await get("/api/search?q=")).status).toBe(400);
		expect((await get("/api/search")).status).toBe(400);

		const response = await get(`/api/search?q=${encodeURIComponent("NEEDLE")}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as SearchResponse;
		expect(body.query).toBe("NEEDLE");
		expect(body.chat.map((match) => match.sessionId)).toEqual([chat.id]);
		expect(body.chat[0]?.hits[0]).toMatchObject({ role: "user" });
		expect(body.bots).toHaveLength(1);
		expect(body.bots[0]?.bot).toBe("alpha");
		expect(body.bots[0]?.matches[0]).toMatchObject({ sessionId: "chs_bot" });
		expect(body.bots[0]?.matches[0]?.hits.map((hit) => hit.role)).toEqual([
			"user",
			"assistant",
		]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("501s when the hub cannot search", async () => {
		const minimal: Hub = {
			hello: () => ({
				type: "hello",
				workspaceRoot,
				model: settings.model,
				provider: {
					configured: false,
					preset: "deepseek",
					model: settings.model,
					baseURL: "",
					apiKeyEnv: "",
					apiKeySource: null,
				},
				bots: [],
				states: [],
				workspaces: [],
				sessions: [],
				activeSessionId: null,
				transcript: [],
				approvals: [],
				allowAll: false,
			}),
			subscribe: () => () => {},
			dispatch: () => {},
			interrupt: () => {},
			resolveApproval: () => {},
			setAllowAll: () => {},
			newSession: async () => {},
			openSession: async () => {},
			dispose: async () => {},
		};
		const { app, port } = await startServer(minimal);
		expect(
			(await fetch(`http://127.0.0.1:${port}/api/search?q=x`)).status,
		).toBe(501);
		app.server.closeAllConnections?.();
		await app.close();
	});
});
