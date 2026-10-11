import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRgLine } from "../../src/tools/grep.js";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-grep-");
	await writeFile(join(workspace, "a.txt"), "TODO one\nno match\n", "utf8");
	await writeFile(join(workspace, "b.txt"), "TODO two\n", "utf8");
	await writeFile(join(workspace, "ignored.txt"), "TODO three\n", "utf8");
	await writeFile(join(workspace, ".gitignore"), "ignored.txt\n", "utf8");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("grep", () => {
	it("returns file:line:text with ripgrep", async () => {
		const result = await execute(
			"grep",
			{ pattern: "TODO" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "a.txt:1:TODO one\nb.txt:1:TODO two",
		});
	});

	it("returns the same output from the JavaScript fallback", async () => {
		const originalPath = process.env.PATH;
		const emptyDir = await makeWorkspace("my-agent-path-");
		process.env.PATH = emptyDir;
		try {
			const result = await execute(
				"grep",
				{ pattern: "TODO" },
				{ workspaceRoot: workspace },
			);
			expect(result).toEqual({
				ok: true,
				output: "a.txt:1:TODO one\nb.txt:1:TODO two",
			});
		} finally {
			process.env.PATH = originalPath;
			await removeWorkspace(emptyDir);
		}
	});

	it("applies case_insensitive", async () => {
		await writeFile(join(workspace, "c.txt"), "todo lower\n", "utf8");
		const sensitive = await execute(
			"grep",
			{ pattern: "TODO" },
			{ workspaceRoot: workspace },
		);
		expect(sensitive).toEqual({
			ok: true,
			output: "a.txt:1:TODO one\nb.txt:1:TODO two",
		});
		const insensitive = await execute(
			"grep",
			{ pattern: "TODO", case_insensitive: true },
			{ workspaceRoot: workspace },
		);
		expect(insensitive).toEqual({
			ok: true,
			output: "a.txt:1:TODO one\nb.txt:1:TODO two\nc.txt:1:todo lower",
		});
	});
});

describe("parseRgLine", () => {
	it("keeps a Windows drive letter out of the file/line separator", () => {
		expect(
			parseRgLine("C:\\src\\tools\\registry.ts:42:const value = 1;"),
		).toEqual({
			file: "C:\\src\\tools\\registry.ts",
			lineNumber: "42",
			text: "const value = 1;",
		});
	});

	it("parses a workspace-relative file:line:text", () => {
		expect(
			parseRgLine("src/tools/grep.ts:7:export function parseRgLine("),
		).toEqual({
			file: "src/tools/grep.ts",
			lineNumber: "7",
			text: "export function parseRgLine(",
		});
	});
});
