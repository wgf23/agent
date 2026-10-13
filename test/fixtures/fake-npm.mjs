#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Stands in for the npm binary. The install tests point PATH at a directory
// whose `npm` is this file, so the argv npm receives is observable.
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_ARGV_FILE) {
	writeFileSync(process.env.FAKE_NPM_ARGV_FILE, JSON.stringify(args));
}

const scenario = process.env.FAKE_NPM_SCENARIO ?? "ok";

if (scenario === "fail") {
	// A stdout line first so the folded line stream has both origins.
	process.stdout.write("npm notice first line\n");
	process.stderr.write("npm ERR! install failed hard\n");
	process.exitCode = 1;
} else if (scenario === "sleep") {
	if (process.env.FAKE_NPM_PID_FILE) {
		writeFileSync(process.env.FAKE_NPM_PID_FILE, String(process.pid));
	}
	setInterval(() => {}, 1000);
} else if (scenario === "prefix") {
	process.stdout.write(`${process.env.FAKE_NPM_PREFIX ?? "/tmp/prefix"}\n`);
} else {
	process.stdout.write("added 1 package\n");
}
