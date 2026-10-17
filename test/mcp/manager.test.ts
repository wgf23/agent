import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServers } from "../../src/config/resolve.js";
import { connectMcpServers } from "../../src/mcp/manager.js";
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
		// The summary is shaped from mapped names only, which cannot carry an
		// env value; this pins that rather than trusting it to stay true.
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

	// The mapper's rejection is built from tool names, not stderr, so it is a
	// second way a secret reaches the notice.
	it("redacts a secret quoted in a tool-mapping error", async () => {
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

		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).not.toContain(secret);
		expect(result.notices[0]).toContain("«redacted»");
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
