import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/plugins/load.js";
import { executeTool } from "../../src/tools/registry.js";

const FAKE_PLUGIN = fileURLToPath(
	new URL("../fixtures/fake-plugin.mjs", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function writePlugin(content: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-"));
	tempDirs.push(dir);
	const file = path.join(dir, "plugin.mjs");
	await writeFile(file, content, "utf8");
	return file;
}

describe("loadPlugins", () => {
	it("loads a plugin module exporting a tool, a command, and a system prompt", async () => {
		const result = await loadPlugins([FAKE_PLUGIN], process.cwd());

		expect(result.errors).toEqual([]);
		expect(result.systemPrompt).toBe("You are the fake plugin.");
		expect(result.commands).toEqual([
			{
				name: "greet",
				description: "Greet someone by name",
				body: "Say hello to $ARGUMENTS.",
			},
		]);
		expect(result.tools).toHaveLength(1);
		const tool = result.tools[0];
		expect(tool.name).toBe("greet");

		const executed = await executeTool(
			tool,
			{},
			{ workspaceRoot: process.cwd() },
		);
		expect(executed).toEqual({ ok: true, output: "hello from fake-plugin" });
	});

	it("reports a plugin missing a name and still loads the good ones", async () => {
		const bad = await writePlugin("export default { tools: [] };\n");

		const result = await loadPlugins([bad, FAKE_PLUGIN], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: missing a non-empty "name".`,
		]);
		expect(result.tools.map((tool) => tool.name)).toEqual(["greet"]);
	});

	it("reports a tool without an execute and skips the plugin", async () => {
		const bad = await writePlugin(
			'export default { name: "broken", tools: [{ name: "x" }] };\n',
		);

		const result = await loadPlugins([bad], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: tool at index 0 must be an object with a "name" and an "execute".`,
		]);
		expect(result.tools).toEqual([]);
	});

	it("rejects a plugin tool that collides with a built-in tool", async () => {
		const bad = await writePlugin(
			'export default { name: "collide", tools: [{ name: "bash", execute() {} }] };\n',
		);

		const result = await loadPlugins([bad], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: tool "bash" collides with the built-in tool "bash".`,
		]);
		expect(result.tools).toEqual([]);
	});

	it("rejects a plugin tool that collides with an already-loaded plugin tool", async () => {
		const first = await writePlugin(
			'export default { name: "first", tools: [{ name: "dup", execute() {} }] };\n',
		);
		const second = await writePlugin(
			'export default { name: "second", tools: [{ name: "dup", execute() {} }] };\n',
		);

		const result = await loadPlugins([first, second], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${second}: tool "dup" collides with the tool "dup" from plugin "first".`,
		]);
		expect(result.tools.map((tool) => tool.name)).toEqual(["dup"]);
	});

	it("catches a plugin that throws on import", async () => {
		const bad = await writePlugin('throw new Error("boom");\n');

		const result = await loadPlugins([bad, FAKE_PLUGIN], process.cwd());

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("boom");
		expect(result.tools.map((tool) => tool.name)).toEqual(["greet"]);
	});

	it("joins system prompts with blank lines", async () => {
		const first = await writePlugin(
			'export default { name: "one", systemPrompt: "First." };\n',
		);
		const second = await writePlugin(
			'export default { name: "two", systemPrompt: "Second." };\n',
		);

		const result = await loadPlugins([first, second], process.cwd());

		expect(result.systemPrompt).toBe("First.\n\nSecond.");
	});

	it("disposes every loaded plugin", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-dispose-"));
		tempDirs.push(dir);
		const marker = path.join(dir, "marker.txt");
		const plugin = path.join(dir, "plugin.mjs");
		await writeFile(
			plugin,
			`import { appendFileSync } from "node:fs";\nexport default { name: "disposer", dispose() { appendFileSync(${JSON.stringify(marker)}, "disposed"); } };\n`,
			"utf8",
		);

		const result = await loadPlugins([plugin], process.cwd());
		await result.dispose();

		expect(readFileSync(marker, "utf8")).toBe("disposed");
	});
});
