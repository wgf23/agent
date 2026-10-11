import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/tools/registry.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-read-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("read_file", () => {
	it("prefixes each line with its 1-based line number", async () => {
		await writeFile(
			join(workspace, "lines.txt"),
			"alpha\nbeta\ngamma\n",
			"utf8",
		);
		const result = await execute(
			"read_file",
			{ path: "lines.txt" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: true,
			output: "1\talpha\n2\tbeta\n3\tgamma\n4\t",
		});
	});

	it("honors offset and limit", async () => {
		await writeFile(join(workspace, "lines.txt"), "a\nb\nc\nd\ne\n", "utf8");
		const result = await execute(
			"read_file",
			{ path: "lines.txt", offset: 2, limit: 2 },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "2\tb\n3\tc" });
	});

	it("errors on a missing file", async () => {
		const result = await execute(
			"read_file",
			{ path: "nope.txt" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "read_file: file not found: nope.txt",
		});
	});

	it("errors on a directory", async () => {
		await mkdir(join(workspace, "sub"));
		const result = await execute(
			"read_file",
			{ path: "sub" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error: "read_file: path is a directory: sub",
		});
	});

	it("truncates output at 2000 lines", async () => {
		const content = Array.from(
			{ length: 2500 },
			(_, index) => `line-${index + 1}`,
		).join("\n");
		await writeFile(join(workspace, "big.txt"), content, "utf8");
		const result = await execute(
			"read_file",
			{ path: "big.txt", limit: 10000 },
			{ workspaceRoot: workspace },
		);
		if (!result.ok) throw new Error(result.error);
		const lines = result.output.split("\n");
		expect(lines).toHaveLength(2001);
		expect(lines[0]).toBe("1\tline-1");
		expect(lines[1999]).toBe("2000\tline-2000");
		expect(lines[2000]).toBe("[truncated: 500 lines cut]");
	});

	it("truncates output at 50 KB", async () => {
		await writeFile(join(workspace, "big.txt"), "a".repeat(60_000), "utf8");
		const result = await execute(
			"read_file",
			{ path: "big.txt" },
			{ workspaceRoot: workspace },
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.output).toBe(
			`1\t${"a".repeat(51_198)}\n[truncated: 8802 bytes cut]`,
		);
	});
});
