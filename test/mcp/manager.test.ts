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
		const result = await connectMcpServers({
			servers: {
				good: fake(),
				bad: { command: ["/nonexistent-binary"] },
			},
			workspaceRoot: process.cwd(),
			timeoutMs: 2000,
		});
		disposed.push(result.dispose);

		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toContain("mcp bad:");
		expect(result.servers).toEqual([{ name: "good", toolCount: 2 }]);
		expect(result.tools.map((tool) => tool.name).sort()).toEqual([
			"mcp__good__create_entity",
			"mcp__good__read_graph",
		]);
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
