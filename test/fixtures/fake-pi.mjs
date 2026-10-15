#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_ARGV_FILE) {
	writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(args));
}
if (process.env.FAKE_PI_ENV_FILE) {
	writeFileSync(
		process.env.FAKE_PI_ENV_FILE,
		process.env[process.env.FAKE_PI_ENV_NAME ?? ""] ?? "",
	);
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
		if (scenario === "team") {
			emitTeamScript().catch((error) => {
				process.stderr.write(`fake pi team scenario failed: ${error.stack}\n`);
				process.exit(4);
			});
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

// Loads the turn's generated extension the way pi does and drives its
// registered tools with the calls named in FAKE_PI_TEAM_CALLS, recording the
// text each one returned in FAKE_PI_TEAM_RESULTS.
async function emitTeamScript() {
	const extensionPath = argValue("--extension");
	const { default: extension } = await import(
		pathToFileURL(extensionPath).href
	);
	const tools = new Map();
	const hooks = [];
	extension({
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		on(event, handler) {
			if (event === "tool_call") hooks.push(handler);
		},
	});

	emit({ type: "agent_start" });
	emit({ type: "turn_start" });

	const calls = JSON.parse(
		readFileSync(process.env.FAKE_PI_TEAM_CALLS, "utf8"),
	);
	const observed = [];
	for (const [index, call] of calls.entries()) {
		const toolCallId = `call_${index + 1}`;
		emit({
			type: "tool_execution_start",
			toolCallId,
			toolName: call.name,
			args: call.args,
		});
		// pi runs tool_call before executing; a refused confirm is what
		// non-interactive mode does, so a hook that gated a team tool would
		// block the call here.
		const blocked = await firstBlock(hooks, {
			toolCallId,
			toolName: call.name,
			input: call.args,
		});
		if (blocked !== undefined) {
			observed.push(blocked.reason);
			emitTeamToolEnd(toolCallId, call.name, blocked.reason, true);
			continue;
		}
		const definition = tools.get(call.name);
		try {
			const result = await definition.execute(toolCallId, call.args);
			observed.push(result.content.map((block) => block.text).join(""));
			emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: call.name,
				result,
				isError: false,
			});
		} catch (error) {
			observed.push(error.message);
			emitTeamToolEnd(toolCallId, call.name, error.message, true);
		}
	}

	// A built-in call still goes through the hook; a denied confirm blocks it.
	const builtinCallId = "call_builtin";
	emit({
		type: "tool_execution_start",
		toolCallId: builtinCallId,
		toolName: "read",
		args: { path: "a.txt" },
	});
	const builtin = await firstBlock(hooks, {
		toolCallId: builtinCallId,
		toolName: "read",
		input: { path: "a.txt" },
	});
	const builtinText = builtin?.reason ?? "not blocked";
	observed.push(builtinText);
	emitTeamToolEnd(builtinCallId, "read", builtinText, builtin !== undefined);

	if (process.env.FAKE_PI_TEAM_RESULTS) {
		writeFileSync(process.env.FAKE_PI_TEAM_RESULTS, JSON.stringify(observed));
	}

	emit({
		type: "message_start",
		message: { role: "assistant", content: [], usage: emptyUsage() },
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "team done" }],
			usage: usage(1, 1, 0),
			stopReason: "stop",
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
}

function emitTeamToolEnd(toolCallId, toolName, text, isError) {
	emit({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text }], details: {} },
		isError,
	});
}

async function firstBlock(hooks, event) {
	const ctx = { hasUI: false, ui: { confirm: async () => false } };
	for (const hook of hooks) {
		const decision = await hook(event, ctx);
		if (decision?.block) return decision;
	}
	return undefined;
}

function argValue(flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
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
