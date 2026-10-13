import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-write-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("write_file", () => {
	it("creates nested directories and writes content", async () => {
		const result = await execute(
			"write_file",
			{ path: "a/b/c.txt", content: "hello" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "Wrote 5 bytes to a/b/c.txt" });
		expect(await readFile(join(workspace, "a/b/c.txt"), "utf8")).toBe("hello");
	});

	it("overwrites an existing file", async () => {
		await execute(
			"write_file",
			{ path: "f.txt", content: "first" },
			{ workspaceRoot: workspace },
		);
		const result = await execute(
			"write_file",
			{ path: "f.txt", content: "second" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "Wrote 6 bytes to f.txt" });
		expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("second");
	});

	it("rejects a path that escapes the workspace", async () => {
		const result = await execute(
			"write_file",
			{ path: "../escape.txt", content: "x" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "Path escapes the workspace: ../escape.txt",
		});
		await expect(access(join(workspace, "..", "escape.txt"))).rejects.toThrow();
	});
});
