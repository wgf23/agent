#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_MCP_SCENARIO ?? "basic";
const logFile = process.env.FAKE_MCP_LOG;

if (process.env.FAKE_MCP_PID_FILE) {
	writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));
}

const TOOLS = [
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
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		handleLine(line);
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));

function handleLine(line) {
	if (line.trim() === "") return;
	if (logFile) appendFileSync(logFile, `${line}\n`);
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (scenario === "silent" || scenario === "sleep") return;
	if (message.method === "initialize") {
		respond(message.id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "fake-mcp", version: "0.0.1" },
		});
		if (scenario === "requests") {
			// A server request we support and one we do not, in that order.
			send({ jsonrpc: "2.0", id: "srv_ping", method: "ping" });
			send({
				jsonrpc: "2.0",
				id: "srv_unknown",
				method: "roots/list",
			});
			// A notification carries no id and must be ignored by the client.
			send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "info", data: "hello" },
			});
		}
		return;
	}
	if (message.method === "tools/list") {
		respond(message.id, { tools: TOOLS });
		return;
	}
	if (message.method === "tools/call") {
		respond(message.id, callResult(message.params ?? {}));
		return;
	}
	if (message.method !== undefined && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: "Method not found" },
		});
	}
}

function callResult(params) {
	const name = params.name;
	const args = params.arguments ?? {};
	if (isRecord(args) && args.name === "boom") {
		return {
			content: [{ type: "text", text: "boom happened" }],
			isError: true,
		};
	}
	return {
		content: [
			{ type: "text", text: `${name}:${JSON.stringify(args)}` },
			{ type: "text", text: "ok" },
		],
		isError: false,
	};
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
