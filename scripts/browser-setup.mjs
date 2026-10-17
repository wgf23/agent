// One-time browser setup for the design bot's Playwright MCP server.
//
// @playwright/mcp pins the exact Playwright build it drives, but pnpm does not
// put a `playwright` shim on PATH for a transitive dependency, so resolve the
// CLI through the MCP package instead of guessing a store path. Run it as
// `pnpm browser:setup`; PLAYWRIGHT_BROWSERS_PATH is honoured, so a read-only
// home can point the download somewhere else.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp"));
const playwrightEntry = mcpRequire.resolve("playwright");
const cli = path.join(path.dirname(playwrightEntry), "cli.js");
if (!existsSync(cli)) {
	console.error(`Cannot find the Playwright CLI at ${cli}.`);
	process.exit(1);
}

const child = spawn(process.execPath, [cli, "install", "chromium"], {
	stdio: "inherit",
	env: process.env,
});
child.on("exit", (code, signal) => {
	if (signal !== null) {
		console.error(`playwright install stopped by ${signal}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
});
