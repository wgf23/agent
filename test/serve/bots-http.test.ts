import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
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

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-bots-http-sessions-"),
	);
	workspaceRoot = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-bots-http-ws-"),
	);
});

describe("POST /api/bots", () => {
	it("creates a rob and rejects duplicates and reserved names", async () => {
		const allowAll = createAllowAll();
		const options = {
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
			allowAll,
		};
		const workspace = new SoloHub(options, {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const robs = new TeamHub({ ...options, robs: [], providerEnv: {} });
		const hub = new CompositeHub(workspace, robs, workspaceRoot);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const post = (body: unknown) =>
			fetch(`http://127.0.0.1:${port}/api/bots`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const created = await post({ name: "writer", role: "drafts prose" });
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({
			ok: true,
			bot: { name: "writer", kind: "rob", backend: "native" },
		});

		const duplicate = await post({ name: "writer", role: "again" });
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toMatchObject({ ok: false });

		const reserved = await post({ name: "assistant", role: "x" });
		expect(reserved.status).toBe(400);

		const malformed = await post({ name: "writer" });
		expect(malformed.status).toBe(400);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});

// The panel sends a skill list the moment the user changes it, and only then
// sets the flag. The route's only job is to carry both fields through; the
// flag is filled in once, by the write layer. These tests read the stored file
// to prove that division of labour, rather than trusting the response.
describe("bot skill and mcp scope over HTTP", () => {
	async function startServer() {
		const allowAll = createAllowAll();
		const options = {
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
			allowAll,
		};
		const workspace = new SoloHub(options, {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const robs = new TeamHub({ ...options, robs: [], providerEnv: {} });
		const hub = new CompositeHub(workspace, robs, workspaceRoot);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const send = (method: "POST" | "PATCH", path: string, body: unknown) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const stop = async () => {
			app.server.closeAllConnections?.();
			await app.close();
			await hub.dispose();
		};
		return { send, stop };
	}

	async function storedRob(name: string) {
		const text = await readFile(join(workspaceRoot, "my-agent.json"), "utf8");
		const parsed = JSON.parse(text) as {
			robs: Array<Record<string, unknown>>;
		};
		return parsed.robs.find((rob) => rob.name === name);
	}

	it("confirms a skill list patched without its flag, once", async () => {
		const { send, stop } = await startServer();
		await send("POST", "/api/bots", { name: "writer", role: "drafts" });

		const first = await send("PATCH", "/api/bots/writer", {
			role: "drafts",
			skills: ["alpha"],
		});
		expect(first.status).toBe(200);

		// The route did not invent the flag; the write layer did.
		expect(await storedRob("writer")).toMatchObject({
			skills: ["alpha"],
			skillsConfigured: true,
		});

		// Sending the same thing again must not change the stored scope.
		const second = await send("PATCH", "/api/bots/writer", {
			role: "drafts",
			skills: ["alpha"],
		});
		expect(second.status).toBe(200);
		expect(await storedRob("writer")).toMatchObject({
			skills: ["alpha"],
			skillsConfigured: true,
		});

		await stop();
	});

	it("does the same on create", async () => {
		const { send, stop } = await startServer();

		const created = await send("POST", "/api/bots", {
			name: "scout",
			role: "looks",
			skills: ["beta"],
			mcp: ["docs"],
		});
		expect(created.status).toBe(200);

		expect(await storedRob("scout")).toMatchObject({
			skills: ["beta"],
			skillsConfigured: true,
			mcp: ["docs"],
		});

		await stop();
	});

	it("leaves the scope absent when the draft does not mention it", async () => {
		const { send, stop } = await startServer();

		await send("POST", "/api/bots", { name: "plain", role: "x" });

		// Absent must stay absent: a default written here would silently pick
		// a truth-table row on the user's behalf.
		const stored = await storedRob("plain");
		expect(stored?.skills).toBeUndefined();
		expect(stored?.skillsConfigured).toBeUndefined();
		expect(stored?.mcp).toBeUndefined();

		await stop();
	});

	it("refuses a flag-only patch instead of repairing it", async () => {
		const { send, stop } = await startServer();
		await send("POST", "/api/bots", { name: "strict", role: "x" });

		// A handler that normalised would have to invent a list (widening the
		// scope) or drop the flag (ignoring the user). Both would answer 200.
		// The 400 proves the route passed the draft through untouched and let
		// the write layer refuse it.
		const flagged = await send("PATCH", "/api/bots/strict", {
			role: "x",
			skillsConfigured: true,
		});
		expect(flagged.status).toBe(400);

		expect((await storedRob("strict"))?.skills).toBeUndefined();

		await stop();
	});

	it("passes an explicit empty list with false through unchanged", async () => {
		const { send, stop } = await startServer();
		await send("POST", "/api/bots", { name: "quiet", role: "x" });

		// The one way to say "back to the default": the write layer must see
		// the flag as false, not fill it in.
		await send("PATCH", "/api/bots/quiet", {
			role: "x",
			skills: [],
			skillsConfigured: false,
		});

		expect(await storedRob("quiet")).toMatchObject({
			skills: [],
			skillsConfigured: false,
		});

		await stop();
	});
});
