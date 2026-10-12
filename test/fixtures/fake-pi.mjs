#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_ARGV_FILE) {
	writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(args));
}

const scenario = process.env.FAKE_PI_SCENARIO ?? "events";

if (scenario === "sleep") {
	if (process.env.FAKE_PI_PID_FILE) {
		writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
	}
	setInterval(() => {}, 1000);
} else {
	// pi waits for stdin EOF before it answers, so the fake must too; a backend
	// that leaves stdin open would hang here instead of finishing the turn.
	process.stdin.resume();
	process.stdin.on("end", () => {
		process.stdin.pause();
		if (scenario === "error") {
			process.stderr.write("boom: fake pi failed\n");
			process.exit(3);
		}
		if (scenario === "model-error") {
			printModelError();
			return;
		}
		printEvents();
	});
}

function printEvents() {
	const lines = [
		{ type: "session", version: 3, id: "fake-session" },
		"not json, should be ignored",
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		},
		{
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		},
		{
			type: "message_start",
			message: { role: "assistant", content: [], usage: emptyUsage() },
		},
		{
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
		},
		{
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { path: "a.txt" },
		},
		{
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "read",
			result: { content: [{ type: "text", text: "A".repeat(5000) }] },
			isError: false,
		},
		{
			type: "message_start",
			message: { role: "toolResult", toolCallId: "call_1" },
		},
		{
			type: "message_end",
			message: { role: "toolResult", toolCallId: "call_1" },
		},
		{ type: "turn_end" },
		{ type: "turn_start" },
		{
			type: "message_start",
			message: { role: "assistant", content: [], usage: emptyUsage() },
		},
		...(scenario === "stream"
			? ["The ", "final ", "answer."].map((delta) => ({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
				}))
			: []),
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The final answer." }],
				usage: usage(50, 10, 2),
				stopReason: "stop",
			},
		},
		{ type: "turn_end" },
		{ type: "agent_end" },
	];

	for (const line of lines) {
		process.stdout.write(
			`${typeof line === "string" ? line : JSON.stringify(line)}\n`,
		);
	}
}

function printModelError() {
	const lines = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "message_start",
			message: { role: "assistant", content: [], usage: emptyUsage() },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: emptyUsage(),
				stopReason: "error",
				errorMessage: "model exploded",
			},
		},
		{ type: "agent_end" },
	];

	for (const line of lines) {
		process.stdout.write(`${JSON.stringify(line)}\n`);
	}
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
