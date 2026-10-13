import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
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
		path.join(tmpdir(), "my-agent-web-sessions-http-sessions-"),
	);
	workspaceRoot = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-sessions-http-ws-"),
	);
});

describe("POST /api/sessions", () => {
	it("opens and closes a bot session while the workspace routes still work", async () => {
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
		const robs = new TeamHub({
			...options,
			robs: [{ name: "writer", role: "drafts prose" }],
			providerEnv: {},
		});
		const hub = new CompositeHub(workspace, robs, workspaceRoot);
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));
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

		const opened = await post("/api/sessions/new", { bot: "writer" });
		expect(opened.status).toBe(200);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session_opened",
				bot: "writer",
				messages: [],
			}),
		);

		const unknown = await post("/api/sessions/open", {
			bot: "writer",
			id: "nope",
		});
		expect(unknown.status).toBe(200);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "error",
				bot: "writer",
				message: expect.stringContaining("nope"),
			}),
		);

		const session = events.find((event) => event.type === "session_opened");
		const sessionId =
			session?.type === "session_opened" ? session.sessionId : "";
		const closed = await post("/api/sessions/close", {
			bot: "writer",
			id: sessionId,
		});
		expect(closed.status).toBe(200);

		// The workspace chat route is unchanged.
		const workspaceNew = await post("/api/sessions/new", {
			bot: "assistant",
		});
		expect(workspaceNew.status).toBe(200);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "session_opened", bot: "assistant" }),
		);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
