#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_FILE) {
	writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args));
}
if (process.env.FAKE_CLAUDE_ENV_FILE) {
	writeFileSync(
		process.env.FAKE_CLAUDE_ENV_FILE,
		process.env[process.env.FAKE_CLAUDE_ENV_NAME ?? ""] ?? "",
	);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "events";
const session = "ses-1";

if (scenario === "sleep") {
	if (process.env.FAKE_CLAUDE_PID_FILE) {
		writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
	}
	setInterval(() => {}, 1000);
} else if (scenario === "error") {
	emit({
		type: "result",
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0,
		is_error: true,
		result: "Not logged in · Please run /login",
		session_id: session,
	});
	process.exitCode = 1;
} else if (scenario === "stderr") {
	// Large enough to overflow the 64KB pipe buffer and deadlock a consumer
	// with no stderr listener.
	process.stderr.write("X".repeat(200 * 1024));
	emit({
		type: "result",
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0,
		is_error: true,
		result: "boom",
		session_id: session,
	});
	process.exitCode = 1;
} else if (scenario === "empty") {
	// Exits cleanly without emitting a result line.
} else if (scenario === "team") {
	await emitTeamScript();
} else {
	emit({
		type: "system",
		subtype: "init",
		session_id: session,
		model: "sonnet",
		tools: ["Read", "Bash"],
		permissionMode: "default",
	});
	process.stdout.write("not json, should be ignored\n");
	emit({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I'll read the file." },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "Read",
					input: { file_path: "a.txt" },
				},
			],
			usage: { input_tokens: 100, output_tokens: 20 },
		},
		session_id: session,
	});
	emit({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: "A".repeat(5000),
					is_error: false,
				},
			],
		},
		session_id: session,
	});
	emit({
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The final answer." }],
			usage: { input_tokens: 50, output_tokens: 10 },
		},
		session_id: session,
	});
	emit({
		type: "result",
		usage: {
			input_tokens: 150,
			output_tokens: 30,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0.001,
		is_error: false,
		result: "The final answer.",
		session_id: session,
	});
}

// Runs the shim from the turn's --mcp-config the way claude does: spawn the
// configured command and speak MCP over stdin/stdout. The calls come from
// FAKE_CLAUDE_TEAM_CALLS and the returned text is written to
// FAKE_CLAUDE_TEAM_RESULTS.
async function emitTeamScript() {
	const configPath = argValue("--mcp-config");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const server = Object.values(config.mcpServers)[0];
	const shim = spawn(server.command, server.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...(server.env ?? {}) },
	});

	let buffer = "";
	let sequence = 0;
	const pending = new Map();
	shim.stdout.setEncoding("utf8");
	shim.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.trim() !== "") {
				const message = JSON.parse(line);
				pending.get(message.id)?.(message);
				pending.delete(message.id);
			}
		}
	});
	const call = (method, params) =>
		new Promise((resolve) => {
			sequence += 1;
			pending.set(sequence, resolve);
			shim.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params })}\n`,
			);
		});

	await call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "fake-claude", version: "1.0.0" },
	});
	shim.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);

	const calls = JSON.parse(
		readFileSync(process.env.FAKE_CLAUDE_TEAM_CALLS, "utf8"),
	);
	const observed = [];
	for (const teamCall of calls) {
		const reply = await call("tools/call", {
			name: teamCall.name,
			arguments: teamCall.args,
		});
		const text = (reply.result?.content ?? [])
			.map((block) => block.text)
			.join("");
		observed.push(text);
	}
	if (process.env.FAKE_CLAUDE_TEAM_RESULTS) {
		writeFileSync(
			process.env.FAKE_CLAUDE_TEAM_RESULTS,
			JSON.stringify(observed),
		);
	}
	shim.kill("SIGKILL");

	emit({
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "team done" }],
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		session_id: session,
	});
	emit({
		type: "result",
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0,
		is_error: false,
		result: "team done",
		session_id: session,
	});
}

function argValue(flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}
