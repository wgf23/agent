import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { createRoomStore, newRoomState } from "../../src/rob/room-store.js";
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

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-search-http-sessions-"),
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
	it("400s a blank query, echoes a real one, and groups room hits", async () => {
		const chat = newSession(workspaceRoot, settings.model);
		chat.messages = [{ role: "user", content: "the needle in chat" }];
		chat.updatedAt = 7;
		await saveSession(chat);

		const store = createRoomStore({ workspaceRoot });
		await store.save({
			...newRoomState("ship-it", 1, ["alpha", "beta"], null),
			transcript: [
				{ id: 1, at: 10, kind: "user", text: "the needle in a room" },
				{
					id: 2,
					at: 11,
					kind: "member",
					from: "alpha",
					text: "a needle answer",
				},
			],
		});

		const options = hubOptions();
		const workspace = new SoloHub(options, {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const robs = new TeamHub({
			...options,
			robs: [
				{ name: "alpha", role: "a test rob" },
				{ name: "beta", role: "another test rob" },
			],
			providerEnv: {},
		});
		const hub = new CompositeHub(workspace, robs, workspaceRoot);
		const { app, port } = await startServer(hub);
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		expect((await get("/api/search?q=")).status).toBe(400);
		expect((await get("/api/search")).status).toBe(400);
		expect((await get("/api/search?q=%20")).status).toBe(400);

		const response = await get(`/api/search?q=${encodeURIComponent("NEEDLE")}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as SearchResponse;
		expect(body).toEqual({
			query: "NEEDLE",
			chat: [
				{
					sessionId: chat.id,
					title: null,
					firstUserText: "the needle in chat",
					hits: [{ role: "user", text: "the needle in chat", at: 7 }],
				},
			],
			rooms: [
				{
					room: "ship-it",
					matches: [
						{
							sessionId: "ship-it",
							title: "ship-it",
							firstUserText: "the needle in a room",
							hits: [
								{ role: "user", text: "the needle in a room", at: 10 },
								{ role: "assistant", text: "a needle answer", at: 11 },
							],
						},
					],
				},
			],
		});

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
				rooms: [],
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
