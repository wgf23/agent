import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-glob-");
	await mkdir(join(workspace, "sub"));
	await mkdir(join(workspace, "node_modules"));
	await mkdir(join(workspace, ".git"));
	await writeFile(join(workspace, "a.ts"), "", "utf8");
	await writeFile(join(workspace, "b.test.ts"), "", "utf8");
	await writeFile(join(workspace, "ignored.ts"), "", "utf8");
	await writeFile(join(workspace, "sub", "c.ts"), "", "utf8");
	await writeFile(join(workspace, "node_modules", "dep.ts"), "", "utf8");
	await writeFile(join(workspace, ".git", "obj.ts"), "", "utf8");
	await writeFile(join(workspace, ".gitignore"), "ignored.ts\n", "utf8");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("glob", () => {
	it("finds matching files and honors .gitignore", async () => {
		const result = await execute(
			"glob",
			{ pattern: "**/*.ts" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "a.ts\nb.test.ts\nsub/c.ts",
		});
	});

	it("searches from a subdirectory path", async () => {
		const result = await execute(
			"glob",
			{ pattern: "*.ts", path: "sub" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "sub/c.ts" });
	});
});
