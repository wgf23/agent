#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scenario = process.env.FAKE_LSP_SCENARIO ?? "basic";
const logFile = process.env.FAKE_LSP_LOG;

// A server whose binary runs and dies before answering anything.
if (scenario === "exit-early") {
	process.exit(1);
}

if (process.env.FAKE_LSP_PID_FILE) {
	writeFileSync(process.env.FAKE_LSP_PID_FILE, String(process.pid));
}

function log(message) {
	if (logFile) appendFileSync(logFile, `${JSON.stringify(message)}\n`);
}

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
	);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

// Publish for the file's real path, like a real server resolves symlinks, so a
// client that sends the symlink uri and waits on it never matches.
async function publishFor(uri) {
	let publishUri = uri;
	if (typeof uri === "string" && uri.startsWith("file://")) {
		try {
			publishUri = pathToFileURL(await realpath(fileURLToPath(uri))).toString();
		} catch {
			publishUri = uri;
		}
	}
	const firstMessage = process.env.FAKE_LSP_MESSAGE ?? "Cannot find name 'x'.";
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri: publishUri,
			diagnostics: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
					severity: 1,
					message: firstMessage,
					source: "fake-lsp",
				},
				{
					range: {
						start: { line: 2, character: 4 },
						end: { line: 2, character: 8 },
					},
					severity: 2,
					message: "Unused variable 'y'.",
					source: "fake-lsp",
				},
			],
		},
	});
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /^Content-Length: (\d+)$/im.exec(header);
		if (match === null) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer
			.subarray(bodyStart, bodyStart + length)
			.toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		handle(body);
	}
});
process.stdin.on("end", () => process.exit(0));

function handle(body) {
	let message;
	try {
		message = JSON.parse(body);
	} catch {
		return;
	}
	log(message);

	if (scenario === "silent") {
		if (message.method === "initialize") {
			respond(message.id, { capabilities: {} });
		} else if (message.method === "shutdown") {
			respond(message.id, null);
		} else if (message.method === "exit") {
			process.exit(0);
		}
		return;
	}

	if (scenario === "configuration") {
		if (message.method === "initialize") {
			respond(message.id, { capabilities: {} });
			send({
				jsonrpc: "2.0",
				id: 42,
				method: "workspace/configuration",
				params: {
					items: [{ section: "foo" }, { section: "bar" }],
				},
			});
		} else if (message.method === "shutdown") {
			respond(message.id, null);
		} else if (message.method === "exit") {
			process.exit(0);
		}
		return;
	}

	if (scenario === "oversized-frame") {
		if (message.method === "initialize") {
			respond(message.id, { capabilities: {} });
		} else if (message.method === "textDocument/didOpen") {
			process.stdout.write("Content-Length: 100000000\r\n\r\n");
		} else if (message.method === "shutdown") {
			respond(message.id, null);
		} else if (message.method === "exit") {
			process.exit(0);
		}
		return;
	}

	if (message.method === "initialize") {
		respond(message.id, { capabilities: {} });
		return;
	}
	if (
		message.method === "textDocument/didOpen" ||
		message.method === "textDocument/didChange"
	) {
		publishFor(message.params?.textDocument?.uri);
		return;
	}
	if (message.method === "shutdown") {
		respond(message.id, null);
		return;
	}
	if (message.method === "exit") {
		process.exit(0);
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
