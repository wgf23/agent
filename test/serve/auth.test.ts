import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { ProviderRuntime } from "../../src/serve/runtime.js";
import { buildServer } from "../../src/serve/server.js";
import { SettingsService } from "../../src/serve/settings.js";
import { SoloHub } from "../../src/serve/solo.js";
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

const TOKEN = "test-token-abc123";

let homeDir: string;
let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-auth-sessions-"),
	);
	homeDir = mkdtempSync(path.join(tmpdir(), "my-agent-auth-home-"));
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-auth-ws-"));
});

async function startAuthedServer() {
	const hub = new SoloHub(
		{
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
		},
		{ session: newSession(workspaceRoot, settings.model), sessions: [] },
	);
	const runtime = new ProviderRuntime({
		provider: createMockProvider([]),
		settings,
		apiKey: null,
		apiKeySource: null,
		providerEnv: {},
	});
	const service = new SettingsService({
		homeDir,
		workspaceRoot,
		env: {},
		runtime,
		verify: async () => ({ ok: true }),
		applyRuntime: async () => ({ ok: true }),
	});
	const app = await buildServer(hub, undefined, {
		service,
		token: TOKEN,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, hub, port };
}

describe("token auth on a non-loopback bind", () => {
	it("returns 401 for a missing or wrong token", async () => {
		const { app, hub, port } = await startAuthedServer();

		const missing = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bot: "assistant", text: "ping" }),
		});
		expect(missing.status).toBe(401);

		const wrong = await fetch(`http://127.0.0.1:${port}/api/send?token=nope`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bot: "assistant", text: "ping" }),
		});
		expect(wrong.status).toBe(401);

		const wrongBearer = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer nope",
			},
			body: JSON.stringify({ bot: "assistant", text: "ping" }),
		});
		expect(wrongBearer.status).toBe(401);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("accepts a query token and a bearer token on POST routes", async () => {
		const { app, hub, port } = await startAuthedServer();

		const viaQuery = await fetch(
			`http://127.0.0.1:${port}/api/send?token=${TOKEN}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ bot: "assistant", text: "ping" }),
			},
		);
		expect(viaQuery.status).toBe(200);

		const viaBearer = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({ bot: "assistant", text: "ping" }),
		});
		expect(viaBearer.status).toBe(200);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("gates the SSE endpoint with a query token", async () => {
		const { app, hub, port } = await startAuthedServer();

		const denied = new AbortController();
		const blocked = await fetch(`http://127.0.0.1:${port}/api/events`, {
			signal: denied.signal,
		});
		expect(blocked.status).toBe(401);
		denied.abort();

		const allowed = new AbortController();
		const stream = await fetch(
			`http://127.0.0.1:${port}/api/events?token=${TOKEN}`,
			{ signal: allowed.signal },
		);
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		allowed.abort();

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
