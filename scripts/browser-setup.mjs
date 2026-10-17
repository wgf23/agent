// One-time browser setup for the design bot's Playwright MCP server.
//
// @playwright/mcp pins the exact Playwright build it drives, but pnpm does not
// put a `playwright` shim on PATH for a transitive dependency, so resolve the
// CLI through the MCP package instead of guessing a store path. Run it as
// `pnpm browser:setup`.
//
// The download goes to .my-agent/browsers inside the project, which is where
// this repository's MCP server looks; an explicit PLAYWRIGHT_BROWSERS_PATH
// still wins, so a read-only home can point it somewhere else. Whatever the
// MCP server's own env says must match this default, or the browser lands in
// one place and the server looks in another.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let cli;
try {
	const mcpRequire = createRequire(require.resolve("@playwright/mcp"));
	cli = path.join(path.dirname(mcpRequire.resolve("playwright")), "cli.js");
} catch (error) {
	// The resolver appends a multi-line require stack; one line is enough.
	const reason = String(error instanceof Error ? error.message : error).split(
		"\n",
	)[0];
	console.error(
		`Cannot resolve the Playwright CLI through @playwright/mcp (${reason}). Run \`pnpm install\` first.`,
	);
	process.exit(1);
}
if (!existsSync(cli)) {
	console.error(`Cannot find the Playwright CLI at ${cli}.`);
	process.exit(1);
}

// `||`, not `??`: an empty PLAYWRIGHT_BROWSERS_PATH= is falsy to Playwright
// itself, which would fall back to ~/.cache/ms-playwright -- the very
// location this default exists to avoid.
const browsers =
	process.env.PLAYWRIGHT_BROWSERS_PATH ||
	path.join(process.cwd(), ".my-agent", "browsers");

const child = spawn(process.execPath, [cli, "install", "chromium"], {
	stdio: "inherit",
	env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
});
child.on("exit", (code, signal) => {
	if (signal !== null) {
		console.error(`playwright install stopped by ${signal}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
});
