import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-bash-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("bash", () => {
	it("returns stdout on exit code 0", async () => {
		const result = await execute(
			"bash",
			{ command: "printf hello" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "hello" });
	});

	it("returns ok false with the exit code and captured output", async () => {
		const result = await execute(
			"bash",
			{ command: "echo boom; exit 7" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: false, error: "bash: exit code 7\nboom\n" });
	});

	it("kills the process on timeout", async () => {
		const result = await execute(
			"bash",
			{ command: "sleep 5", timeout_ms: 300 },
			{ workspaceRoot: workspace },
		);
		if (result.ok) throw new Error("expected a timeout failure");
		expect(result.error).toContain("timed out after 300ms");
	});

	it("runs in the workspace root", async () => {
		const result = await execute(
			"bash",
			{ command: "pwd" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: `${await realpath(workspace)}\n`,
		});
	});
});
