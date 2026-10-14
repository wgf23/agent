import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import { createBotStore } from "../../src/bot/store.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { CompositeHub } from "../../src/serve/composite.js";
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

	it("deletes and renames a workspace session, reporting unknown ids", async () => {
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
		const session = newSession(workspaceRoot, settings.model);
		session.messages = [{ role: "user", content: "hi" }];
		await saveSession(session);
		const workspace = new SoloHub(options, { session, sessions: [] });
		const robs = new TeamHub({ ...options, robs: [], providerEnv: {} });
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

		expect(
			(await post("/api/sessions/delete", { bot: "assistant" })).status,
		).toBe(400);
		expect(
			(await post("/api/sessions/delete", { bot: "assistant", id: session.id }))
				.status,
		).toBe(200);
		const afterDelete = events
			.filter((event) => event.type === "sessions")
			.at(-1);
		expect(
			afterDelete?.type === "sessions" ? afterDelete.sessions : [],
		).toEqual([]);
		expect(
			(await post("/api/sessions/delete", { bot: "assistant", id: session.id }))
				.status,
		).toBe(404);

		const second = newSession(workspaceRoot, settings.model);
		second.messages = [{ role: "user", content: "second" }];
		await saveSession(second);
		expect(
			(await post("/api/sessions/rename", { bot: "assistant", id: second.id }))
				.status,
		).toBe(400);
		expect(
			(
				await post("/api/sessions/rename", {
					bot: "assistant",
					id: second.id,
					title: "   ",
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/sessions/rename", {
					bot: "assistant",
					id: second.id,
					title: "  Trimmed  ",
				})
			).status,
		).toBe(200);
		const afterRename = events
			.filter((event) => event.type === "sessions")
			.at(-1);
		const listed = afterRename?.type === "sessions" ? afterRename.sessions : [];
		expect(listed).toEqual([
			expect.objectContaining({ id: second.id, title: "Trimmed" }),
		]);
		expect(
			(
				await post("/api/sessions/rename", {
					bot: "assistant",
					id: "nope",
					title: "x",
				})
			).status,
		).toBe(404);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("deletes a rob session without emitting the chat's sessions event", async () => {
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
		const store = createBotStore();
		const loaded = await store.load("writer", {
			role: "drafts prose",
			model: settings.model,
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const seeded = await store.commit(loaded.record, {
			id: "trn_00000000000000000000000000000001",
			seq: 1,
			sessionId: "chs_a",
			workspaceRoot,
			at: 1,
			wake: "user",
			messages: [{ role: "user", content: "hi" }],
		});
		if (!seeded.ok) throw new Error(seeded.error);

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

		expect(
			(await post("/api/sessions/delete", { bot: "writer", id: "chs_a" }))
				.status,
		).toBe(200);
		expect(events.some((event) => event.type === "sessions")).toBe(false);
		const afterDelete = events
			.filter((event) => event.type === "bot_sessions")
			.at(-1);
		expect(afterDelete).toMatchObject({ type: "bot_sessions", bot: "writer" });
		const listed =
			afterDelete?.type === "bot_sessions" ? afterDelete.sessions : [];
		expect(listed).toEqual([]);
		expect(
			(await post("/api/sessions/delete", { bot: "writer", id: "chs_a" }))
				.status,
		).toBe(404);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
