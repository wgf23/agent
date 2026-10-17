import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { buildServer } from "../../src/serve/server.js";
import { TeamHub } from "../../src/serve/team.js";
import { projectSlug } from "../../src/session/store.js";

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
let roomsDir: string;
const originalRoomsDir = process.env.MY_AGENT_ROOMS_DIR;
const originalToken = process.env.MY_AGENT_ADMIN_TOKEN;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-room-delete-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-room-delete-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-room-delete-ws-"));
	roomsDir = mkdtempSync(path.join(tmpdir(), "my-agent-room-delete-rooms-"));
	process.env.MY_AGENT_ROOMS_DIR = roomsDir;
	// The gate memoizes on first admin request, so it must be in place first.
	process.env.MY_AGENT_ADMIN_TOKEN = "s3cret";
});

afterEach(() => {
	if (originalRoomsDir === undefined) delete process.env.MY_AGENT_ROOMS_DIR;
	else process.env.MY_AGENT_ROOMS_DIR = originalRoomsDir;
	if (originalToken === undefined) delete process.env.MY_AGENT_ADMIN_TOKEN;
	else process.env.MY_AGENT_ADMIN_TOKEN = originalToken;
	vi.restoreAllMocks();
});

function silentProvider(): Provider {
	return { id: "silent", async *stream() {} };
}

function createRoomHub(): TeamHub {
	return new TeamHub({
		workspaceRoot,
		provider: silentProvider(),
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		robs: [
			{ name: "alpha", role: "a test rob" },
			{ name: "beta", role: "another test rob" },
		],
		rooms: [{ name: "ship-it", members: ["alpha", "beta"] }],
		providerEnv: {},
		allowAll: createAllowAll(),
	});
}

async function withApp(
	run: (
		app: Awaited<ReturnType<typeof buildServer>>,
		hub: TeamHub,
	) => Promise<void>,
	hub: TeamHub = createRoomHub(),
): Promise<void> {
	const app = await buildServer(hub, undefined);
	try {
		await run(app, hub);
	} finally {
		await app.close();
		await hub.dispose();
	}
}

const TOKEN = { "x-admin-token": "s3cret" };

describe("DELETE /api/rooms/:name", () => {
	// The name is the only user-controlled input that reaches a path join, so a
	// name that is not a room name must stop at the route.
	it("answers 404 for a traversing name and leaves the outside file alone", async () => {
		const outside = path.join(path.dirname(workspaceRoot), "outside.json");
		writeFileSync(outside, JSON.stringify({ name: "outside" }), "utf8");
		const names = [
			"..%2Foutside",
			"..%2F..%2Foutside",
			"a%2F..%2F..%2Foutside",
		];

		await withApp(async (app) => {
			for (const name of names) {
				// Fastify decodes the param, so the handler sees `../outside`.
				const response = await app.inject({
					method: "DELETE",
					url: `/api/rooms/${name}`,
					headers: TOKEN,
				});
				expect(response.statusCode, name).toBe(404);
			}
		});

		expect(readFileSync(outside, "utf8")).toBe(
			JSON.stringify({ name: "outside" }),
		);
	});

	// AC-14f for the DELETE verb: the token gate runs before the lookup.
	it("answers 403 before 404 for an unknown room with no token", async () => {
		await withApp(async (app) => {
			const response = await app.inject({
				method: "DELETE",
				url: "/api/rooms/nope",
			});
			expect(response.statusCode).toBe(403);
			expect(response.json()).toEqual({ error: "Admin token required." });
		});
	});

	it("answers 404 for a well-formed name that does not exist", async () => {
		await withApp(async (app) => {
			const response = await app.inject({
				method: "DELETE",
				url: "/api/rooms/nope",
				headers: TOKEN,
			});
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: 'Unknown room "nope".' });
		});
	});

	it("answers 200 with name and archived flag, and no path", async () => {
		await withApp(async (app) => {
			const response = await app.inject({
				method: "DELETE",
				url: "/api/rooms/ship-it",
				headers: TOKEN,
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				ok: true,
				removed: { name: "ship-it", archived: true },
			});
			// A path in the body would leak the operator's home directory.
			expect(response.body).not.toContain(".trash");
			expect(response.body).not.toContain(path.sep);
		});
	});

	it("answers 500 with the failing stage", async () => {
		// A file where the ledger directory's .trash/ belongs makes mkdir fail,
		// which is the archive stage's only failure mode reachable from a route.
		const dir = path.join(roomsDir, projectSlug(workspaceRoot));
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, ".trash"), "", "utf8");

		await withApp(async (app) => {
			const response = await app.inject({
				method: "DELETE",
				url: "/api/rooms/ship-it",
				headers: TOKEN,
			});
			expect(response.statusCode).toBe(500);
			expect(response.json()).toEqual(
				expect.objectContaining({ stage: "archive" }),
			);
		});
	});

	it("broadcasts room_removed only when the delete succeeded", async () => {
		const hub = createRoomHub();
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));

		await withApp(async (app) => {
			await app.inject({
				method: "DELETE",
				url: "/api/rooms/nope",
				headers: TOKEN,
			});
			expect(
				events.filter(
					(event) =>
						event.type === "room" && event.event.kind === "room_removed",
				),
			).toEqual([]);

			await app.inject({
				method: "DELETE",
				url: "/api/rooms/ship-it",
				headers: TOKEN,
			});
			expect(
				events.filter(
					(event) =>
						event.type === "room" && event.event.kind === "room_removed",
				),
			).toEqual([
				{ type: "room", event: { kind: "room_removed", room: "ship-it" } },
			]);
		}, hub);
	});

	// The audit line is written before the token is checked, so an unescaped
	// newline would let an anonymous caller append a second, official-looking
	// entry.
	it("cannot forge a second audit line through the room name", async () => {
		const writes: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});

		await withApp(async (app) => {
			const response = await app.inject({
				method: "DELETE",
				url: "/api/rooms/x%0A2026-01-01T00%3A00%3A00Z%20admin%20action%3Ddelete%20room%3Drnd",
			});
			expect(response.statusCode).toBe(403);
		});

		expect(writes).toHaveLength(1);
		// One line, one trailing newline: the injected newline is escaped.
		const line = writes[0];
		expect(line.slice(0, -1)).not.toContain("\n");
		expect(line).toContain('room="x\\n2026-01-01T00:00:00Z');
	});
});
