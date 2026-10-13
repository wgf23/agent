#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Stands in for an external agent CLI. The probe tests point probeVersion at
// this file, so its stdout controls the captured version.
const scenario = process.env.FAKE_AGENT_SCENARIO ?? "version";

if (process.env.FAKE_AGENT_ARGV_FILE) {
	writeFileSync(
		process.env.FAKE_AGENT_ARGV_FILE,
		JSON.stringify(process.argv.slice(2)),
	);
}

if (scenario === "sleep") {
	if (process.env.FAKE_AGENT_PID_FILE) {
		writeFileSync(process.env.FAKE_AGENT_PID_FILE, String(process.pid));
	}
	setInterval(() => {}, 1000);
} else if (scenario === "empty") {
	// Exits cleanly without printing anything.
} else if (scenario === "stderr-only") {
	process.stderr.write("9.9.9\n");
} else {
	// A leading blank line proves the first *non-empty* line wins.
	process.stdout.write("\n");
	process.stdout.write("1.2.3\n");
	process.stdout.write("extra line\n");
}
