import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServers } from "../../src/config/resolve.js";
import { connectMcpServers } from "../../src/mcp/manager.js";
import { toolDefinition } from "../../src/tools/registry.js";
import { FAKE_MCP_SERVER, isAlive, waitFor } from "./helpers.js";

const dirs: string[] = [];
const disposed: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "my-agent-mcp-manager-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(disposed.splice(0).map((dispose) => dispose()));
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function fake(env: Record<string, string> = {}): McpServers[string] {
	return { command: [process.execPath, FAKE_MCP_SERVER], env };
}

describe("connectMcpServers", () => {
	it("turns one server's failure into a notice without stopping the others", async () => {
		const secret = "s3cr3t-mcp-env-value";
		const result = await connectMcpServers({
			servers: {
				// A server with an env value, so the summary has something it
				// could wrongly carry back. The value reaches only the spawn.
				good: fake({ MCP_SECRET_TOKEN: secret }),
				bad: { command: ["/nonexistent-binary"] },
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.notices).toEqual([
			"mcp bad: spawn /nonexistent-binary ENOENT",
		]);
		expect(result.servers).toEqual([
			{
				name: "good",
				toolCount: 2,
				// Grouping has to come from here: the tool names are sanitised,
				// so a panel cannot recover which server a tool came from.
				tools: ["mcp__good__create_entity", "mcp__good__read_graph"],
			},
		]);
		expect(result.tools.map((tool) => tool.name).sort()).toEqual([
			"mcp__good__create_entity",
			"mcp__good__read_graph",
		]);
		expect(Object.keys(result.toolsByServer).sort()).toEqual(["good"]);
		// Mapped names carry these values fine in the general case (sanitisation
		// leaves every character of this one alone). This server is accepted
		// because none of its names contain the value, not because names are
		// inherently clean -- see the leaky-names case below.
		expect(JSON.stringify(result.servers)).not.toContain(secret);
		// toolCount and tools describe the same list, so they must not be able
		// to drift apart in a later edit.
		for (const server of result.servers) {
			expect(server.toolCount).toBe(server.tools.length);
		}
	});

	// A server's failure text can quote the environment it was started with.
	// The notice is user-visible, so the values must be replaced first.
	it("redacts a secret quoted in a connection error", async () => {
		const secret = "hunter2-db-password";
		const result = await connectMcpServers({
			servers: {
				db: fake({
					FAKE_MCP_SCENARIO: "fail-with-secret",
					MCP_DB_PASSWORD: secret,
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).not.toContain(secret);
		expect(result.notices[0]).toContain("«redacted»");
	});

	// The mapper's collision message quotes the duplicated tool name, which is
	// where this fixture puts its secret. The scan now runs first and refuses
	// the server, so that message is never built: the leak is closed by
	// structure rather than by redaction. The mapper's own collision path is
	// still covered directly, with a clean name, in tools.test.ts.
	it("refuses the duplicate-tools fixture before the mapper sees it", async () => {
		const secret = "leftover-mcp-token";
		const result = await connectMcpServers({
			servers: {
				dup: fake({
					FAKE_MCP_SCENARIO: "duplicate-tools",
					MCP_DB_PASSWORD: secret,
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.servers).toEqual([]);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toContain("security policy");
		expect(result.notices[0]).not.toContain(secret);
		expect(result.notices[0]).not.toContain("collision");
	});

	// The real client cannot fail on dispose, so a disposable test client is
	// the only way to reach the redaction branch that guards it.
	it("redacts a secret quoted in a dispose error", async () => {
		const secret = "shutdown-db-password";
		const result = await connectMcpServers({
			servers: { db: fake({ MCP_DB_PASSWORD: secret }) },
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
			createClient: () => ({
				initialize: async () => {},
				listTools: async () => ({ tools: [] }),
				callTool: async () => ({}),
				dispose: async () => {
					throw new Error(`could not shut down: ${secret}`);
				},
			}),
		});

		// Read before dispose: the connection succeeded, so there is nothing
		// to report yet.
		expect(result.notices).toEqual([]);
		// A failed shutdown is not fatal for callers, so dispose must resolve.
		await expect(result.dispose()).resolves.toBeUndefined();

		// Same array, appended to after it was handed out.
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).not.toContain(secret);
		expect(result.notices[0]).toContain("«redacted»");
	});

	// A tool name is how a tool is called, so it cannot be redacted: the only
	// answer for a server whose names carry its configuration is to drop it.
	it("refuses a server whose tool names expose its configuration, and says why", async () => {
		const apiKey = "sk-live-abc-123";
		const dsn = "abc/def+ghi";
		const result = await connectMcpServers({
			servers: {
				leaky: fake({
					FAKE_MCP_SCENARIO: "leaky-names",
					MCP_API_KEY: apiKey,
					MCP_DSN: dsn,
				}),
				good: fake({ FAKE_MCP_SCENARIO: "basic" }),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		// Refused means gone from all three, not present with zero tools: a
		// "0 tools" entry would read as a server that simply offers nothing.
		expect(result.servers.map((server) => server.name)).toEqual(["good"]);
		expect(Object.keys(result.toolsByServer)).toEqual(["good"]);
		expect(result.tools.every((tool) => !tool.name.includes("leaky"))).toBe(
			true,
		);

		const refusal = result.notices.join("\n");
		expect(refusal).toContain("security policy");
		// The notice names the variable, never the value or the tool name that
		// carried it: both are attacker-controlled, so repeating them buys no
		// diagnosis and adds a place for them to be rendered.
		expect(refusal).toContain("MCP_API_KEY");
		expect(refusal).not.toContain(apiKey);
		expect(refusal).not.toContain("abc_def_ghi");

		// The bad server must not take the good one with it. Mapping first and
		// refusing after would leave the refused names in the shared set and
		// surface here as a collision instead.
		expect(result.tools.map((tool) => tool.name).sort()).toEqual([
			"mcp__good__create_entity",
			"mcp__good__read_graph",
		]);
		expect(refusal).not.toContain("collision");
	});

	// The value only becomes visible after sanitisation: "abc/def+ghi" can
	// never appear in a tool name, but "abc_def_ghi" can. Comparing the raw
	// form alone misses this server entirely.
	it("refuses a server whose value only appears in sanitised form", async () => {
		const dsn = "abc/def+ghi";
		const result = await connectMcpServers({
			servers: {
				leaky: fake({
					FAKE_MCP_SCENARIO: "leaky-names",
					MCP_API_KEY: "short",
					MCP_DSN: dsn,
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		// MCP_API_KEY is "short", which does not appear in the names; MCP_DSN
		// only matches once sanitised. Refusal proves the second comparison.
		expect(result.servers).toEqual([]);
		expect(result.notices.join("\n")).toContain("security policy");
	});

	// Descriptions are free text that reach the provider, so they are redacted
	// rather than refused: the name stays callable and the value is hidden.
	it("redacts a description that carries a value and keeps the server", async () => {
		const apiKey = "sk-live-abc-123";
		const result = await connectMcpServers({
			servers: {
				docs: fake({
					FAKE_MCP_SCENARIO: "leaky-description",
					MCP_API_KEY: apiKey,
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		const tool = result.tools.find(
			(entry) => entry.name === "mcp__docs__search_docs",
		);
		expect(tool).toBeDefined();
		expect(tool?.description).toContain("«redacted»");
		expect(tool?.description).not.toContain(apiKey);
		expect(JSON.stringify(result.tools)).not.toContain(apiKey);
		expect(JSON.stringify(result.servers)).not.toContain(apiKey);
	});

	// Refusal is a false positive here, and accepted as one: "looks like an
	// ordinary word" is exactly the property an attacker would choose. What is
	// not acceptable is silence -- the notice has to say why it went.
	it("refuses a common word rather than letting it pass, and says so", async () => {
		const result = await connectMcpServers({
			servers: {
				docs: fake({
					FAKE_MCP_SCENARIO: "leaky-description",
					MCP_API_KEY: "docs",
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.servers).toEqual([]);
		const refusal = result.notices.join("\n");
		expect(refusal).toContain("security policy");
		expect(refusal).toContain("«redacted»");
	});

	it("does not refuse a server whose names merely coexist with an env value", async () => {
		const result = await connectMcpServers({
			servers: { good: fake({ FAKE_MCP_SCENARIO: "basic", ENV: "prod" }) },
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.servers.map((server) => server.name)).toEqual(["good"]);
		expect(result.tools).toHaveLength(2);
	});

	// Everything above asserts on the shape manager returns. This one asserts on
	// what actually leaves the process: `toolDefinition` is where a tool becomes
	// a provider request, and a value can survive every earlier check and still
	// reach the model through here.
	it("sends no configured value to the provider", async () => {
		const apiKey = "sk-live-abc-123";
		const result = await connectMcpServers({
			servers: {
				docs: fake({
					FAKE_MCP_SCENARIO: "leaky-description",
					MCP_API_KEY: apiKey,
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;
		const sent = JSON.stringify(toolDefinition(tool));
		expect(sent).not.toContain(apiKey);
		expect(sent).toContain("«redacted»");
	});

	// A pure-function test passes whether or not manager ever calls it. This
	// pins the wiring: the scan has to be consulted, not merely to exist.
	it("refuses before mapping, so a refused name never reaches the shared set", async () => {
		const result = await connectMcpServers({
			servers: {
				leaky: fake({
					FAKE_MCP_SCENARIO: "leaky-names",
					MCP_API_KEY: "leak",
					MCP_DSN: "a/b",
				}),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.servers).toEqual([]);
		expect(result.tools).toEqual([]);
		expect(result.toolsByServer).toEqual({});
		expect(result.notices.join("\n")).toContain("security policy");
	});

	// Without this, an implementation that refuses every server would pass
	// every other case here.
	it("keeps a clean server usable", async () => {
		const result = await connectMcpServers({
			servers: { good: fake({ FAKE_MCP_SCENARIO: "basic" }) },
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.servers.map((server) => server.name)).toEqual(["good"]);
		expect(result.tools).toHaveLength(2);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;
		// Callable, not just present: the name round-trips to the server.
		const outcome = await tool.execute(
			{},
			{ workspaceRoot: process.cwd(), signal: AbortSignal.timeout(5000) },
		);
		expect(outcome.ok).toBe(true);
	});

	// A tool without `inputSchema` is legal, and the fallback has to match the
	// one the mapper used before the scan rewrote parameters. `{}` accepts any
	// value; this shape says the tool takes an object. Sending the wrong one
	// widens the contract the model sees, and nothing else covers this path.
	it("keeps the empty-schema fallback when a tool declares none", async () => {
		const result = await connectMcpServers({
			servers: { bare: fake({ FAKE_MCP_SCENARIO: "no-schema" }) },
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		const ping = result.tools.find((tool) => tool.name.endsWith("ping"));
		expect(ping).toBeDefined();
		expect(ping?.parameters).toEqual({ type: "object", properties: {} });
	});

	it("disposes every client", async () => {
		const dir = await tempDir();
		const pid1 = path.join(dir, "one.pid");
		const pid2 = path.join(dir, "two.pid");
		const result = await connectMcpServers({
			servers: {
				one: fake({ FAKE_MCP_PID_FILE: pid1 }),
				two: fake({ FAKE_MCP_PID_FILE: pid2 }),
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});

		await waitFor(() => {
			expect(existsSync(pid1)).toBe(true);
			expect(existsSync(pid2)).toBe(true);
		});
		const pids = [
			Number(readFileSync(pid1, "utf8").trim()),
			Number(readFileSync(pid2, "utf8").trim()),
		];
		expect(pids.every((pid) => isAlive(pid))).toBe(true);

		await result.dispose();

		await waitFor(() => expect(pids.every((pid) => isAlive(pid))).toBe(false));
	});
});
