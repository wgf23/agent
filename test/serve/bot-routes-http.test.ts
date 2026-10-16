import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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

function makeHub(provider: Provider): CompositeHub {
	const options = hubOptions(provider);
	const workspace = new SoloHub(options, {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
	const robs = new TeamHub({
		...options,
		robs: [ROB],
		providerEnv: {},
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

describe("bot ledger routes", () => {
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
