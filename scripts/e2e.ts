import type { AgentEvent } from "../src/agent/events.js";
import { runHeadless } from "../src/cli/run.js";

if (process.env.MY_AGENT_E2E !== "1") {
	console.log("skipped: set MY_AGENT_E2E=1 to run against the real API");
	process.exit(0);
}

const prompt =
	"List the files in the src/tools directory and name one of them.";
const events: AgentEvent[] = [];
let text = "";

await runHeadless({
	prompt,
	onEvent: (event) => {
		events.push(event);
		if (event.type === "text_delta") text += event.text;
	},
});

const done = events.find((event) => event.type === "done");
const sawReadTool = events.some(
	(event) =>
		(event.type === "tool_started" || event.type === "tool_finished") &&
		(event.name === "glob" || event.name === "read_file"),
);
const namedFile = /registry|read_file/i.test(text);

const failures: string[] = [];
if (done?.reason !== "finished") {
	failures.push(`reason: expected "finished", got "${done?.reason ?? "none"}"`);
}
if (!sawReadTool) {
	failures.push("no glob or read_file tool event was seen");
}
if (!namedFile) {
	failures.push('final text does not contain "registry" or "read_file"');
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL ${failure}`);
	process.exitCode = 1;
} else {
	console.log(
		"PASS reason=finished tool=glob|read_file text named a tools file",
	);
}
