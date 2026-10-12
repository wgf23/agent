import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashPlanFn } from "../../src/sandbox/index.js";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

// The real plan probes the host for a sandbox backend. Tests inject this
// passthrough so they stay offline and assert the tool wiring, not the backend.
const passthrough: BashPlanFn = ({ command }) => ({
	run: true,
	argv: ["/bin/sh", "-c", command],
	env: {},
});

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-bash-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("bash", () => {
	// These commands assume a POSIX shell. Windows runs them through cmd.exe,
	// where printf, sleep, and pwd do not exist.
	it.skipIf(process.platform === "win32")(
		"returns stdout on exit code 0 (skipped on Windows: POSIX shell)",
		async () => {
			const result = await execute(
				"bash",
				{ command: "printf hello" },
				{ workspaceRoot: workspace, planBash: passthrough },
			);
			expect(result).toEqual({ ok: true, output: "hello" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"returns ok false with the exit code and captured output (skipped on Windows: POSIX shell)",
		async () => {
			const result = await execute(
				"bash",
				{ command: "echo boom; exit 7" },
				{ workspaceRoot: workspace, planBash: passthrough },
			);
			expect(result).toEqual({ ok: false, error: "bash: exit code 7\nboom\n" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"kills the process on timeout (skipped on Windows: POSIX shell)",
		async () => {
			const result = await execute(
				"bash",
				{ command: "sleep 5", timeout_ms: 300 },
				{ workspaceRoot: workspace, planBash: passthrough },
			);
			if (result.ok) throw new Error("expected a timeout failure");
			expect(result.error).toContain("timed out after 300ms");
		},
	);

	it.skipIf(process.platform === "win32")(
		"runs in the workspace root (skipped on Windows: POSIX shell)",
		async () => {
			const result = await execute(
				"bash",
				{ command: "pwd" },
				{ workspaceRoot: workspace, planBash: passthrough },
			);
			expect(result).toEqual({
				ok: true,
				output: `${await realpath(workspace)}\n`,
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"returns ok false with the plan reason and runs no process (skipped on Windows: POSIX shell)",
		async () => {
			const deny: BashPlanFn = () => ({
				run: false,
				reason: "sandbox required but unavailable",
			});

			const result = await execute(
				"bash",
				{ command: "printf hi > ran.txt" },
				{ workspaceRoot: workspace, planBash: deny },
			);

			expect(result).toEqual({
				ok: false,
				error: "sandbox required but unavailable",
			});
			expect(existsSync(path.join(workspace, "ran.txt"))).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"prepends the warning line and still runs the command (skipped on Windows: POSIX shell)",
		async () => {
			const warned: BashPlanFn = ({ command }) => ({
				run: true,
				argv: ["/bin/sh", "-c", command],
				env: {},
				warning: "sandbox unavailable; running unsandboxed",
			});

			const result = await execute(
				"bash",
				{ command: "printf hello" },
				{ workspaceRoot: workspace, planBash: warned },
			);

			expect(result).toEqual({
				ok: true,
				output: "warning: sandbox unavailable; running unsandboxed\nhello",
			});
		},
	);
});
