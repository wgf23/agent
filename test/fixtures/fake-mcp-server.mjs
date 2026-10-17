#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_MCP_SCENARIO ?? "basic";
const logFile = process.env.FAKE_MCP_LOG;

// A failing server that quotes its own environment on stderr, to prove the
// connection notice redacts values before the text reaches the UI.
if (scenario === "fail-with-secret") {
	process.stderr.write(
		`cannot open database: ${process.env.MCP_DB_PASSWORD ?? ""}`,
	);
	process.exit(1);
}

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

// A tool may legitimately omit `inputSchema`. Kept in its own scenario so the
// tools above stay a stable shape for the cases that count them.
if (scenario === "no-schema") {
	TOOLS.push({ name: "ping", description: "Takes nothing." });
}

// The two refusals that do not come from a value match. Each gets its own
// scenario so a notice can be tied to the reason that produced it: a schema
// too malformed to read and a pointer that leaves the schema are different
// problems, and one wording must not stand in for the other.
if (scenario === "malformed-schema") {
	TOOLS.push({
		name: "probe_tool",
		description: "d",
		inputSchema: { examples: { mode: "fast" } },
	});
}

if (scenario === "external-ref") {
	TOOLS.push({
		name: "probe_tool",
		description: "d",
		inputSchema: { properties: { a: { $ref: "https://example.com/s.json" } } },
	});
}

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
		// A server whose tool text carries its own configuration values. The
		// plain names would pass any check that only looks at the mapped form:
		// "abc/def+ghi" cannot appear verbatim in a tool name, so it only shows
		// up after sanitisation as "abc_def_ghi".
		if (scenario === "leaky-names") {
			respond(message.id, {
				tools: [
					{
						name: `leak_${process.env.MCP_API_KEY ?? ""}`,
						description: "harmless description",
					},
					{ name: `${sanitized(process.env.MCP_DSN ?? "")}_probe` },
				],
			});
			return;
		}
		// Names are clean; the description carries the value. Refusing the
		// server here would be wrong — the text can be redacted instead.
		if (scenario === "leaky-description") {
			respond(message.id, {
				tools: [
					{
						name: "search_docs",
						description: `search using ${process.env.MCP_API_KEY ?? ""}`,
					},
				],
			});
			return;
		}
		// Two tools that map to the same name make the mapper reject the
		// server; the name carries the secret so the error text does too.
		if (scenario === "duplicate-tools") {
			const name = process.env.MCP_DB_PASSWORD ?? "dup";
			respond(message.id, { tools: [{ name }, { name }] });
			return;
		}
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

// Mirrors src/mcp/tools.ts: a name can only carry these characters, so a
// configured value containing anything else appears in its sanitised form.
function sanitized(part) {
	return part.replace(/[^A-Za-z0-9_-]/g, "_");
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
