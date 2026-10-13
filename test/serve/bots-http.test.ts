import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
			bot: { name: "writer", backend: "native" },
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
