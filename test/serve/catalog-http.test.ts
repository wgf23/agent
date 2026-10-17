import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServers } from "../../src/config/resolve.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";
import { FAKE_MCP_SERVER } from "../mcp/helpers.js";

let home: string;
let skillsRoot: string;

beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), "catalog-http-"));
	// The real layout discoverSkills reads: <root>/node_modules/<package>.
	skillsRoot = path.join(home, ".config", "my-agent", "skills");
	const installed = path.join(
		skillsRoot,
		"node_modules",
		"fixture-valid-skill",
	);
	await mkdir(installed, { recursive: true });
	await cp(
		path.join(process.cwd(), "test", "fixtures", "skill-valid"),
		installed,
		{ recursive: true },
	);
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// Only the routes under test are exercised, so the hub is a shell. The cast
// covers the members a GET never reaches.
function stubHub(): Hub {
	return {
		hello: () => ({
			type: "hello",
			workspaceRoot: process.cwd(),
			model: "test-model",
			provider: {
				configured: false,
				preset: "deepseek",
				model: "test-model",
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
			allowAll: { mode: "off", sessionId: null },
		}),
		subscribe: () => () => {},
		dispatch: () => {},
		interrupt: () => {},
		resolveApproval: () => {},
		setAllowAll: () => {},
		newSession: async () => {},
		openSession: async () => {},
		dispose: async () => {},
	} as Hub;
}

async function server(mcpServers: McpServers = {}) {
	return buildServer(
		stubHub(),
		undefined,
		undefined,
		undefined,
		undefined,
		{ homeDir: home },
		{ skillsRoot, mcpServers },
	);
}

describe("GET /api/skills", () => {
	it("lists an installed skill without its directory", async () => {
		const app = await server();
		const response = await app.inject({ method: "GET", url: "/api/skills" });
		await app.close();

		expect(response.statusCode).toBe(200);
		const rows = response.json() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			name: "fixture-greeting",
			description: "A greeting skill for tests.",
			packageName: "fixture-valid-skill",
			version: "1.2.3",
		});
	});

	// The assertion is on the key, not on the text: a row could carry `dir`
	// with an empty value and still pass a substring check.
	it("has no dir key at all", async () => {
		const app = await server();
		const response = await app.inject({ method: "GET", url: "/api/skills" });
		await app.close();

		const rows = response.json() as Array<Record<string, unknown>>;
		for (const row of rows) {
			expect(Object.hasOwn(row, "dir")).toBe(false);
		}
	});

	// The whole body, not one field: the path can only get out somewhere, and
	// checking the field we thought of would miss the place we did not.
	it("contains no part of the skills root", async () => {
		const app = await server();
		const response = await app.inject({ method: "GET", url: "/api/skills" });
		await app.close();

		expect(response.body).not.toContain(skillsRoot);
		expect(response.body).not.toContain(home);
	});

	it("answers an empty list when nothing is installed", async () => {
		const empty = await mkdtemp(path.join(tmpdir(), "catalog-empty-"));
		const app = await buildServer(
			stubHub(),
			undefined,
			undefined,
			undefined,
			undefined,
			{ homeDir: home },
			{ skillsRoot: empty, mcpServers: {} },
		);
		const response = await app.inject({ method: "GET", url: "/api/skills" });
		await app.close();
		await rm(empty, { recursive: true, force: true });

		// An empty list, not a 404: having nothing installed is ordinary.
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
	});
});

describe("GET /api/mcp", () => {
	it("returns the variable names and never their values", async () => {
		const sentinel = "sk-live-QA-DESC-7b1";
		const app = await server({
			docs: {
				command: [process.execPath, FAKE_MCP_SERVER],
				env: { DB_PASSWORD: sentinel, REGION: "eu" },
			},
		});
		const response = await app.inject({ method: "GET", url: "/api/mcp" });
		await app.close();

		expect(response.statusCode).toBe(200);
		const rows = response.json() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			name: "docs",
			command: process.execPath,
			argsCount: 1,
			envKeys: ["DB_PASSWORD", "REGION"],
		});
	});

	// Asserted over the serialised body: a value could ride in any field, and
	// naming the fields we remembered is how the fifth path was missed.
	it("does not carry a value anywhere in the body", async () => {
		const sentinel = "sk-live-QA-DESC-7b1";
		const app = await server({
			docs: {
				command: [process.execPath, FAKE_MCP_SERVER],
				env: { DB_PASSWORD: sentinel },
			},
		});
		const response = await app.inject({ method: "GET", url: "/api/mcp" });
		await app.close();

		expect(response.body).toContain("DB_PASSWORD");
		expect(response.body).not.toContain(sentinel);
	});

	// The arguments are a perfectly ordinary place to write a token in full,
	// and this route is reachable from anywhere the server is bound to.
	it("does not echo a token written into the arguments", async () => {
		const token = "ghp_QA5TokenWrittenIntoArgv1234567890";
		const app = await server({
			deploy: {
				command: ["deployctl", "--token", token],
			},
		});
		const response = await app.inject({ method: "GET", url: "/api/mcp" });
		await app.close();

		const rows = response.json() as Array<Record<string, unknown>>;
		expect(Object.hasOwn(rows[0] ?? {}, "args")).toBe(false);
		expect(rows[0]?.argsCount).toBe(2);
		expect(response.body).not.toContain(token);
		// The executable alone still comes back: it names the server's kind.
		expect(rows[0]?.command).toBe("deployctl");
	});

	it("answers an empty list when nothing is configured", async () => {
		const app = await server({});
		const response = await app.inject({ method: "GET", url: "/api/mcp" });
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
	});
});
