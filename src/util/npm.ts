import { errorMessage } from "./errors.js";

// npm's executable name differs on Windows. Never invoke npm through a shell.
export const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

// Flags shared by every npm invocation here. `--` before the package ends flag
// parsing so a spec that starts with a dash can never be read as an option.
export const NPM_FLAGS = [
	"--no-audit",
	"--no-fund",
	"--loglevel=error",
] as const;

// The last non-empty line of stderr, falling back to stdout, capped at 200
// characters. Mirrors the rule src/skills/install.ts already applies so npm
// failures surface one actionable line instead of the whole log.
export function npmError(error: unknown): string {
	if (isRecord(error)) {
		const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
		const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
		const text = stderr !== "" ? stderr : stdout;
		if (text !== "") {
			const lines = text.split("\n").filter((line) => line.trim() !== "");
			const last = lines[lines.length - 1] ?? "";
			return last.length > 200 ? `${last.slice(0, 200)}...` : last;
		}
	}
	return errorMessage(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
