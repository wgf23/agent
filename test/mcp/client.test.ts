import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type McpClientOptions, StdioMcpClient } from "../../src/mcp/client.js";
import { FAKE_MCP_SERVER, isAlive, waitFor } from "./helpers.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "my-agent-mcp-client-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function serverOptions(
	name: string,
	extra: Partial<McpClientOptions> & {
		scenario?: string;
		log?: string;
		pid?: string;
	} = {},
): McpClientOptions {
	const env: Record<string, string> = { ...extra.env };
	if (extra.scenario !== undefined) env.FAKE_MCP_SCENARIO = extra.scenario;
	if (extra.log !== undefined) env.FAKE_MCP_LOG = extra.log;
	if (extra.pid !== undefined) env.FAKE_MCP_PID_FILE = extra.pid;
	return {
		name,
		command: [process.execPath, FAKE_MCP_SERVER],
		workspaceRoot: process.cwd(),
		timeoutMs: extra.timeoutMs,
		env,
	};
}

async function readLog(log: string): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(log, "utf8");
	return text
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("StdioMcpClient", () => {
	it("sends the exact initialize and tools/call requests and matches responses by id", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioMcpClient(serverOptions("mem", { log }));
		try {
			await client.initialize();
			const list = await client.listTools();
			const result = await client.callTool("create_entity", { name: "Ada" });

			const received = await readLog(log);
			expect(received[0]).toEqual({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "my-agent", version: "0.1.0" },
				},
			});
			expect(received[1]).toEqual({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			});
			expect(received[2]).toEqual({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			});
			expect(received[3]).toEqual({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "create_entity", arguments: { name: "Ada" } },
			});

			expect(list).toEqual({
				tools: [
					{
						name: "create_entity",
						title: "Create entity",
						description: "Create an entity in the knowledge graph.",
						inputSchema: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
						annotations: { readOnlyHint: true },
					},
					{
						name: "read_graph",
						description: "Read the whole knowledge graph.",
						inputSchema: { type: "object", properties: {} },
					},
				],
			});
			expect(result).toEqual({
				content: [
					{ type: "text", text: 'create_entity:{"name":"Ada"}' },
					{ type: "text", text: "ok" },
				],
				isError: false,
			});
		} finally {
			await client.dispose();
		}
	});

	it("errors with the server name when a request times out", async () => {
		const client = new StdioMcpClient(
			serverOptions("sleepy", { scenario: "silent", timeoutMs: 100 }),
		);
		try {
			await expect(client.initialize()).rejects.toThrow(
				'mcp sleepy: request "initialize" timed out after 100ms',
			);
		} finally {
			await client.dispose();
		}
	});

	it("answers a server ping and errors an unknown server request", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioMcpClient(
			serverOptions("mem", { scenario: "requests", log }),
		);
		try {
			await client.initialize();
			await waitFor(async () => {
				const received = await readLog(log);
				expect(received.some((m) => m.id === "srv_ping")).toBe(true);
				expect(received.some((m) => m.id === "srv_unknown")).toBe(true);
			});

			const received = await readLog(log);
			expect(received.find((m) => m.id === "srv_ping")).toEqual({
				jsonrpc: "2.0",
				id: "srv_ping",
				result: {},
			});
			expect(received.find((m) => m.id === "srv_unknown")).toEqual({
				jsonrpc: "2.0",
				id: "srv_unknown",
				error: { code: -32601, message: "Method not supported: roots/list" },
			});
		} finally {
			await client.dispose();
		}
	});

	it("kills the child on dispose", async () => {
		const dir = await tempDir();
		const pidFile = path.join(dir, "pid");
		const client = new StdioMcpClient(
			serverOptions("mem", { scenario: "sleep", pid: pidFile }),
		);
		await waitFor(() => {
			expect(existsSync(pidFile)).toBe(true);
		});
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		expect(isAlive(pid)).toBe(true);

		await client.dispose();

		await waitFor(() => expect(isAlive(pid)).toBe(false));
	});
});
