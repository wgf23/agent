import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	execute,
	executeTool,
	getTool,
	toolDefinition,
	toolDefinitions,
} from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";
import { makeWorkspace, removeWorkspace } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-registry-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("execute", () => {
	it("rejects unknown keys without running the tool", async () => {
		const result = await execute(
			"write_file",
			{ path: "out.txt", content: "hi", _dummy: "x" },
			{ workspaceRoot: workspace },
		);
		if (result.ok) throw new Error("expected an argument error");
		expect(result.error).toContain("_dummy");
		await expect(access(join(workspace, "out.txt"))).rejects.toThrow();
	});

	it("returns an error for an unknown tool", async () => {
		const result = await execute("nope", {}, { workspaceRoot: workspace });
		expect(result).toEqual({ ok: false, error: "Unknown tool: nope" });
	});

	it("applies schema defaults before running the tool", async () => {
		await writeFile(join(workspace, "f.txt"), "hi\n", "utf8");
		const result = await execute(
			"read_file",
			{ path: "f.txt" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({ ok: true, output: "1\thi\n2\t" });
	});
});

describe("getTool", () => {
	it("exposes the readOnly flag of each tool", () => {
		expect(getTool("read_file")?.readOnly).toBe(true);
		expect(getTool("glob")?.readOnly).toBe(true);
		expect(getTool("grep")?.readOnly).toBe(true);
		expect(getTool("load_skill")?.readOnly).toBe(true);
		expect(getTool("web_fetch")?.readOnly).toBe(true);
		expect(getTool("write_file")?.readOnly).toBe(false);
		expect(getTool("edit_file")?.readOnly).toBe(false);
		expect(getTool("bash")?.readOnly).toBe(false);
	});
});

describe("toolDefinitions", () => {
	it("returns provider-ready JSON Schema for every tool", () => {
		const definitions = toolDefinitions();
		expect(definitions.map((definition) => definition.name)).toEqual([
			"read_file",
			"write_file",
			"edit_file",
			"bash",
			"glob",
			"grep",
			"load_skill",
			"web_fetch",
		]);

		const readFile = definitions[0].parameters as {
			type?: string;
			additionalProperties?: boolean;
			properties?: Record<string, { type?: string }>;
			required?: string[];
		};
		expect(readFile.type).toBe("object");
		expect(readFile.additionalProperties).toBe(false);
		expect(readFile.properties?.path?.type).toBe("string");
		expect(readFile.required).toEqual(["path", "offset", "limit"]);
	});
});

describe("external tools", () => {
	it("emits the JSON Schema verbatim and forwards raw args without zod", async () => {
		const parameters = {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		};
		const seen: unknown[] = [];
		const external: Tool = {
			name: "mcp__server__tool",
			description: "an external tool",
			readOnly: false,
			parameters,
			async execute(args) {
				seen.push(args);
				return { ok: true, output: `raw:${JSON.stringify(args)}` };
			},
		};

		expect(toolDefinition(external)).toEqual({
			name: "mcp__server__tool",
			description: "an external tool",
			parameters,
		});

		const rawArgs = { name: "Ada", unsupported: 1 };
		const result = await executeTool(external, rawArgs, {
			workspaceRoot: workspace,
		});

		expect(result).toEqual({
			ok: true,
			output: 'raw:{"name":"Ada","unsupported":1}',
		});
		expect(seen).toEqual([rawArgs]);
	});
});
