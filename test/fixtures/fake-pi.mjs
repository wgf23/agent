#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_ARGV_FILE) {
	writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(args));
}

const scenario = process.env.FAKE_PI_SCENARIO ?? "events";

let promptCount = 0;
let lastSteer = "";
// Scenarios where a steer is queued but not consumed before agent_end.
const STEER_SCENARIOS = ["steer-late", "steer-fail", "steer-lost"];

if (scenario === "sleep") {
	if (process.env.FAKE_PI_PID_FILE) {
		writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
	}
	setInterval(() => {}, 1000);
} else {
	// RPC mode stays alive and reads commands as JSONL from stdin; it exits when
	// our backend closes stdin after agent_end.
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	let buffer = "";
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			handleLine(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

function handleLine(line) {
	if (line.trim() === "") return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (command.type === "prompt") {
		promptCount += 1;
		emit({ type: "response", command: "prompt", success: true });
		if (scenario === "error") {
			process.stderr.write("boom: fake pi failed\n");
			process.exit(3);
		}
		if (scenario === "model-error") {
			emitModelError();
			return;
		}
		if (scenario === "interjection") {
			emitInterjectionStart();
			return;
		}
		if (scenario === "approval") {
			emitApprovalStart();
			return;
		}
		if (STEER_SCENARIOS.includes(scenario)) {
			if (promptCount > 1) emitSteerAnswer();
			else emitSteerWait();
			return;
		}
		emitScript();
		return;
	}
	if (command.type === "steer") {
		lastSteer = command.message;
		if (process.env.FAKE_PI_STEER_FILE) {
			appendFileSync(process.env.FAKE_PI_STEER_FILE, `${command.message}\n`);
		}
		if (scenario === "interjection") {
			// Real pi acknowledges a consumed steer by filling then emptying
			// queue_update.steering around the response.
			emit({ type: "queue_update", steering: [command.message], followUp: [] });
			emit({ type: "response", command: "steer", success: true });
			emitInterjectionEnd();
			return;
		}
		if (scenario === "steer-late") {
			// success:true but the steer stays queued; no turn consumes it.
			emit({ type: "response", command: "steer", success: true });
			emit({ type: "queue_update", steering: [command.message], followUp: [] });
			emit({ type: "turn_end" });
			emit({ type: "agent_end" });
			return;
		}
		if (scenario === "steer-fail") {
			emit({ type: "response", command: "steer", success: false });
			emit({ type: "queue_update", steering: [], followUp: [] });
			emit({ type: "turn_end" });
			emit({ type: "agent_end" });
			return;
		}
		if (scenario === "steer-lost") {
			// Acked, never queued, never delivered: unaccounted.
			emit({ type: "response", command: "steer", success: true });
			emit({ type: "queue_update", steering: [], followUp: [] });
			emit({ type: "turn_end" });
			emit({ type: "agent_end" });
			return;
		}
		emit({ type: "response", command: "steer", success: true });
		return;
	}
	if (command.type === "extension_ui_response") {
		emitApprovalEnd(command.confirmed === true);
	}
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitScript() {
	const streaming = scenario === "stream";
	emit({ type: "session", version: 3, id: "fake-session" });
	process.stdout.write("not json, should be ignored\n");
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	});
	emit({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	});
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: "a.txt" },
				},
			],
			usage: usage(100, 20, 5),
			stopReason: "toolUse",
		},
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "read",
		args: { path: "a.txt" },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "read",
		result: { content: [{ type: "text", text: "A".repeat(5000) }] },
		isError: false,
	});
	emit({
		type: "message_start",
		message: { role: "toolResult", toolCallId: "call_1" },
	});
	emit({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "call_1" },
	});
	emit({ type: "turn_end" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	if (streaming) {
		for (const delta of ["The ", "final ", "answer."]) {
			emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			});
		}
	}
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The final answer." }],
			usage: usage(50, 10, 2),
			stopReason: "stop",
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
}

function emitModelError() {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "model exploded",
		},
	});
	emit({ type: "agent_end" });
}

function emitInterjectionStart() {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "sleep 5" },
				},
			],
			usage: usage(1, 1, 0),
			stopReason: "toolUse",
		},
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "sleep 5" },
	});
}

function emitInterjectionEnd() {
	emit({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "slept" }] },
		isError: false,
	});
	emit({ type: "queue_update", steering: [], followUp: [] });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "STEERED",
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "STEERED" }],
			usage: usage(2, 1, 0),
			stopReason: "stop",
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
}

function emitSteerWait() {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "echo wait" },
				},
			],
			usage: usage(1, 1, 0),
			stopReason: "toolUse",
		},
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "echo wait" },
	});
}

function emitSteerAnswer() {
	emit({ type: "queue_update", steering: [], followUp: [] });
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: lastSteer }],
			usage: usage(1, 1, 0),
			stopReason: "stop",
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
}

function emitApprovalStart() {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "echo hi" },
				},
			],
			usage: usage(1, 1, 0),
			stopReason: "toolUse",
		},
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "echo hi" },
	});
	emit({
		type: "extension_ui_request",
		id: "ui_1",
		method: "confirm",
		title: "my-agent approval",
		message: JSON.stringify({
			toolName: "bash",
			input: { command: "echo hi" },
		}),
	});
}

function emitApprovalEnd(allowed) {
	emit({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "bash",
		result: {
			content: [
				{
					type: "text",
					text: allowed ? "hi\n" : "Denied by the my-agent approval bridge.",
				},
			],
		},
		isError: !allowed,
	});
	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: allowed ? "done" : "blocked" }],
			usage: usage(3, 1, 0),
			stopReason: "stop",
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
}

function usage(input, output, cacheRead) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function emptyUsage() {
	return usage(0, 0, 0);
}
