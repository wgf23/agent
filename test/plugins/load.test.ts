import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		expect(result.extraInstructions).toBe("You are the fake plugin.");
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
			'export default { name: "collide", tools: [{ name: "bash", description: "d", execute() {} }] };\n',
		);

		const result = await loadPlugins([bad], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: tool "bash" collides with the built-in tool "bash".`,
		]);
		expect(result.tools).toEqual([]);
	});

	it("rejects a plugin tool that collides with an already-loaded plugin tool", async () => {
		const first = await writePlugin(
			'export default { name: "first", tools: [{ name: "dup", description: "d", execute() {} }] };\n',
		);
		const second = await writePlugin(
			'export default { name: "second", tools: [{ name: "dup", description: "d", execute() {} }] };\n',
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

		expect(result.extraInstructions).toBe("First.\n\nSecond.");
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

	it("requires a tool description and defaults readOnly to false", async () => {
		const missing = await writePlugin(
			'export default { name: "x", tools: [{ name: "t", execute() {} }] };\n',
		);
		const badReadOnly = await writePlugin(
			'export default { name: "x", tools: [{ name: "t", description: "d", readOnly: "yes", execute() {} }] };\n',
		);
		const ok = await writePlugin(
			'export default { name: "x", tools: [{ name: "t", description: "d", execute() {} }] };\n',
		);

		const result = await loadPlugins([missing, badReadOnly, ok], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${missing}: tool at index 0 must have a string "description".`,
			`plugin ${badReadOnly}: tool at index 0 "readOnly" must be a boolean.`,
		]);
		expect(result.tools).toHaveLength(1);
		expect(result.tools[0].readOnly).toBe(false);
	});

	it("requires a command description", async () => {
		const bad = await writePlugin(
			'export default { name: "x", commands: [{ name: "c", body: "b" }] };\n',
		);

		const result = await loadPlugins([bad], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: command at index 0 must have a string "description".`,
		]);
		expect(result.commands).toEqual([]);
	});

	it("rejects a plugin command that collides with a built-in command", async () => {
		const bad = await writePlugin(
			'export default { name: "x", commands: [{ name: "help", description: "d", body: "b" }] };\n',
		);

		const result = await loadPlugins([bad], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${bad}: command "help" collides with the built-in command "help".`,
		]);
		expect(result.commands).toEqual([]);
	});

	it("rejects a plugin command that collides with another plugin command", async () => {
		const first = await writePlugin(
			'export default { name: "first", commands: [{ name: "dup", description: "d", body: "b" }] };\n',
		);
		const second = await writePlugin(
			'export default { name: "second", commands: [{ name: "dup", description: "d", body: "b" }] };\n',
		);

		const result = await loadPlugins([first, second], process.cwd());

		expect(result.errors).toEqual([
			`plugin ${second}: command "dup" collides with the command "dup" from plugin "first".`,
		]);
		expect(result.commands.map((command) => command.name)).toEqual(["dup"]);
	});

	it("rejects a plugin command that collides with a file-based command", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-cmd-"));
		tempDirs.push(dir);
		await mkdir(path.join(dir, ".my-agent", "commands"), { recursive: true });
		await writeFile(
			path.join(dir, ".my-agent", "commands", "foo.md"),
			"---\nname: foo\ndescription: File command\n---\nBody.\n",
			"utf8",
		);
		const bad = await writePlugin(
			'export default { name: "x", commands: [{ name: "foo", description: "d", body: "b" }] };\n',
		);

		const result = await loadPlugins([bad], dir);

		expect(result.errors).toEqual([
			`plugin ${bad}: command "foo" collides with the file-based command "foo".`,
		]);
		expect(result.commands).toEqual([]);
	});

	it("dedupes a spec listed twice so it loads once", async () => {
		const result = await loadPlugins([FAKE_PLUGIN, FAKE_PLUGIN], process.cwd());

		expect(result.errors).toEqual([]);
		expect(result.tools.map((tool) => tool.name)).toEqual(["greet"]);
		expect(result.extraInstructions).toBe("You are the fake plugin.");
	});

	it("runs every disposer even when one throws", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-dispose-"));
		tempDirs.push(dir);
		const marker = path.join(dir, "marker.txt");
		const bad = path.join(dir, "bad.mjs");
		const good = path.join(dir, "good.mjs");
		await writeFile(
			bad,
			'export default { name: "bad", dispose() { throw new Error("dispose boom"); } };\n',
			"utf8",
		);
		await writeFile(
			good,
			`import { appendFileSync } from "node:fs";\nexport default { name: "good", dispose() { appendFileSync(${JSON.stringify(marker)}, "disposed"); } };\n`,
			"utf8",
		);

		const result = await loadPlugins([bad, good], process.cwd());
		await expect(result.dispose()).resolves.toBeUndefined();

		expect(result.errors).toEqual(["plugin bad: dispose failed: dispose boom"]);
		expect(readFileSync(marker, "utf8")).toBe("disposed");
	});

	it("merges plugin prompts with existing extra instructions", async () => {
		const plugin = await writePlugin(
			'export default { name: "p", systemPrompt: "Plugin." };\n',
		);

		const result = await loadPlugins([plugin], process.cwd(), "Existing.");

		expect(result.extraInstructions).toBe("Existing.\n\nPlugin.");
	});

	it("resolves a bare specifier from the workspace root", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-ws-"));
		tempDirs.push(dir);
		await mkdir(path.join(dir, "node_modules", "my-agent-test-plugin"), {
			recursive: true,
		});
		await writeFile(
			path.join(dir, "node_modules", "my-agent-test-plugin", "package.json"),
			JSON.stringify({
				name: "my-agent-test-plugin",
				type: "module",
				main: "./index.mjs",
			}),
			"utf8",
		);
		await writeFile(
			path.join(dir, "node_modules", "my-agent-test-plugin", "index.mjs"),
			'export default { name: "bare", systemPrompt: "Bare plugin." };\n',
			"utf8",
		);

		const result = await loadPlugins(["my-agent-test-plugin"], dir);

		expect(result.errors).toEqual([]);
		expect(result.extraInstructions).toBe("Bare plugin.");
	});

	it("rejects a relative spec that escapes the workspace root", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "my-agent-plugin-ws-"));
		tempDirs.push(dir);

		const result = await loadPlugins(["../outside.mjs"], dir);

		expect(result.errors).toEqual([
			`plugin ../outside.mjs: spec escapes the workspace root.`,
		]);
		expect(result.tools).toEqual([]);
	});
});
