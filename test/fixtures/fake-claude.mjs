#!/usr/bin/env node
import { writeFileSync } from "node:fs";

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

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}
