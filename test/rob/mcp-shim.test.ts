import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/providers/types.js";
import {
	startTeamGateway,
	type TeamBridge,
	type TeamGateway,
} from "../../src/rob/gateway/server.js";
import { teamMcpShim } from "../../src/rob/gateway/shims.js";
import { gatewayEnv } from "../../src/rob/gateway/wire.js";
import type { Tool } from "../../src/tools/types.js";

const SECRET = "shim-secret";

function tool(name: string): Tool {
	return {
		name,
		description: `${name} tool`,
		readOnly: true,
		execute: async () => ({ ok: true, output: "" }),
	};
}

const DEFS: ToolDefinition[] = [
	{
		name: "send_message",
		description: "Send a private message to another rob on the team.",
		parameters: {
			type: "object",
			properties: { to: { type: "string" }, text: { type: "string" } },
			required: ["to", "text"],
		},
	},
	{
		name: "delegate",
		description: "Delegate one self-contained task to a sub-agent.",
		parameters: {
			type: "object",
			properties: { task: { type: "string" } },
			required: ["task"],
		},
	},
];

interface Shim {
	readonly messages: Array<Record<string, unknown>>;
	send(message: Record<string, unknown>): void;
	request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
	close(): void;
}

// Drives the generated shim the way opencode's MCP client does: one JSON
// object per line over the child's stdio.
function startShim(file: string, env: Record<string, string>): Shim {
	const child: ChildProcess = spawn(process.execPath, [file], {
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const messages: Array<Record<string, unknown>> = [];
	const waiters = new Map<number, (message: Record<string, unknown>) => void>();
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.trim() === "") continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			messages.push(message);
			const id = message.id;
			if (typeof id === "number") {
				waiters.get(id)?.(message);
				waiters.delete(id);
			}
		}
	});
	child.stderr?.setEncoding("utf8");
	let stderr = "";
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	return {
		messages,
		send(message) {
			child.stdin?.write(`${JSON.stringify(message)}\n`);
		},
		request(message) {
			const id = message.id;
			if (typeof id !== "number") {
				throw new Error("request needs a numeric id");
			}
			const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`shim did not answer id ${id}: ${stderr}`)),
					3000,
				);
				waiters.set(id, (value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
			child.stdin?.write(`${JSON.stringify(message)}\n`);
			return reply;
		},
		close() {
			child.kill("SIGKILL");
		},
	};
}

describe("teamMcpShim", () => {
	let workspace: string;
	let gateway: TeamGateway;
	const calls: Array<{ tool: string; args: unknown }> = [];
	let shim: Shim;

	beforeEach(async () => {
		calls.length = 0;
		workspace = await mkdtemp(path.join(tmpdir(), "my-agent-mcp-shim-"));
		gateway = startTeamGateway({
			lookup: (secret) => {
				if (secret !== SECRET) return undefined;
				const bridge: TeamBridge = {
					rob: "reviewer",
					tools: [tool("send_message"), tool("delegate")],
					roster: () => [],
					childEnv: () => ({}),
					close: () => undefined,
					invoke: async (tool, args) => {
						calls.push({ tool, args });
						if (tool === "send_message") {
							return { ok: true, text: 'Message queued for "worker".' };
						}
						return {
							ok: false,
							reason: "denied",
							text: "The user denied delegate.",
						};
					},
				};
				return bridge;
			},
		});
		await gateway.start();

		const file = path.join(workspace, "team-mcp.mjs");
		await writeFile(file, teamMcpShim({ defs: DEFS }), "utf8");
		shim = startShim(
			file,
			gatewayEnv({ socketPath: gateway.socketPath, secret: SECRET }),
		);
	});

	afterEach(async () => {
		shim.close();
		await gateway.stop();
		await rm(workspace, { recursive: true, force: true });
	});

	it("answers initialize, tools/list and tools/call over stdio", async () => {
		const initialized = await shim.request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			},
		});
		expect(initialized).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "my-agent-team", version: "1.0.0" },
			},
		});

		shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const listed = await shim.request({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
		});
		expect(listed).toEqual({
			jsonrpc: "2.0",
			id: 2,
			result: {
				tools: [
					{
						name: "send_message",
						description: "Send a private message to another rob on the team.",
						inputSchema: {
							type: "object",
							properties: { to: { type: "string" }, text: { type: "string" } },
							required: ["to", "text"],
						},
					},
					{
						name: "delegate",
						description: "Delegate one self-contained task to a sub-agent.",
						inputSchema: {
							type: "object",
							properties: { task: { type: "string" } },
							required: ["task"],
						},
					},
				],
			},
		});

		const sent = await shim.request({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "send_message",
				arguments: { to: "worker", text: "hi from opencode" },
			},
		});
		expect(sent).toEqual({
			jsonrpc: "2.0",
			id: 3,
			result: {
				content: [{ type: "text", text: 'Message queued for "worker".' }],
			},
		});

		const refused = await shim.request({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "delegate", arguments: { task: "count the files" } },
		});
		expect(refused).toEqual({
			jsonrpc: "2.0",
			id: 4,
			result: {
				content: [{ type: "text", text: "The user denied delegate." }],
				isError: true,
			},
		});

		expect(calls).toEqual([
			{
				tool: "send_message",
				args: { to: "worker", text: "hi from opencode" },
			},
			{ tool: "delegate", args: { task: "count the files" } },
		]);
		// The initialized notification earns no reply, so nothing else on stdout.
		expect(shim.messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
	});

	it("answers an unknown tool with a JSON-RPC error and no gateway call", async () => {
		const reply = await shim.request({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "explode", arguments: {} },
		});

		expect(reply).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32602, message: "Unknown tool: explode" },
		});
		expect(calls).toEqual([]);
	});
});
