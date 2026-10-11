import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-edit-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("edit_file", () => {
	it("replaces a unique match", async () => {
		await writeFile(join(workspace, "f.txt"), "hello world\n", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "world", new_string: "there" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "Replaced 1 occurrence(s) in f.txt",
		});
		expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe(
			"hello there\n",
		);
	});

	it("errors when old_string is not found", async () => {
		await writeFile(join(workspace, "f.txt"), "hello", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "absent", new_string: "x" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "edit_file: old_string not found in f.txt",
		});
	});

	it("errors with the count when old_string matches more than once", async () => {
		await writeFile(join(workspace, "f.txt"), "a a a", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "a", new_string: "b" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error:
				"edit_file: old_string matches 3 times in f.txt; set replace_all to true to replace every occurrence",
		});
		expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("a a a");
	});

	it("replaces every match when replace_all is true", async () => {
		await writeFile(join(workspace, "f.txt"), "a a a", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "a", new_string: "b", replace_all: true },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "Replaced 3 occurrence(s) in f.txt",
		});
		expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("b b b");
	});

	it("errors when old_string equals new_string", async () => {
		await writeFile(join(workspace, "f.txt"), "hello", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "hello", new_string: "hello" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "edit_file: old_string and new_string are identical",
		});
	});

	it("errors when old_string is empty", async () => {
		await writeFile(join(workspace, "f.txt"), "hello", "utf8");
		const result = await execute(
			"edit_file",
			{ path: "f.txt", old_string: "", new_string: "x" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "edit_file: old_string must not be empty",
		});
	});
});
