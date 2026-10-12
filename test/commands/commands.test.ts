import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILTIN_COMMAND_NAMES,
	type Command,
	expandCommand,
} from "../../src/commands/commands.js";
import { loadCommands } from "../../src/commands/load.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-commands-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function command(name: string, body: string): Command {
	return { name, description: "A command.", body };
}

function commandsDir(root: string): string {
	return join(root, ".my-agent", "commands");
}

async function writeCommand(file: string, content: string): Promise<void> {
	await mkdir(commandsDir(workspace), { recursive: true });
	await writeFile(join(commandsDir(workspace), file), content, "utf8");
}

describe("expandCommand", () => {
	const commands = [
		command("greet", "Say hello to $ARGUMENTS."),
		command("summarize", "Summarize the repository."),
		command("both", "start $ARGUMENTS middle $ARGUMENTS end"),
	];

	it("substitutes the arguments into $ARGUMENTS", () => {
		expect(expandCommand("/greet Bob", commands)).toBe("Say hello to Bob.");
	});

	it("appends the arguments when the body has no $ARGUMENTS", () => {
		expect(expandCommand("/summarize with a focus on tests", commands)).toBe(
			"Summarize the repository. with a focus on tests",
		);
	});

	it("returns the body unchanged when there are no arguments", () => {
		expect(expandCommand("/summarize", commands)).toBe(
			"Summarize the repository.",
		);
	});

	it("replaces every occurrence of $ARGUMENTS", () => {
		expect(expandCommand("/both A B", commands)).toBe(
			"start A B middle A B end",
		);
	});

	it("returns null for an unknown command", () => {
		expect(expandCommand("/nope", commands)).toBeNull();
	});

	it("returns null for a non-command line", () => {
		expect(expandCommand("hello", commands)).toBeNull();
		expect(expandCommand("/", commands)).toBeNull();
	});

	it("ignores leading and trailing whitespace", () => {
		expect(expandCommand("  /greet Bob  ", commands)).toBe("Say hello to Bob.");
	});
});

describe("loadCommands", () => {
	it("loads valid commands sorted by name", async () => {
		await writeCommand(
			"z-last.md",
			"---\nname: z-last\ndescription: Last\n---\nBody Z.",
		);
		await writeCommand(
			"a-first.md",
			"---\nname: a-first\ndescription: First\n---\nBody A.",
		);

		expect(await loadCommands(workspace)).toEqual([
			{ name: "a-first", description: "First", body: "Body A." },
			{ name: "z-last", description: "Last", body: "Body Z." },
		]);
	});

	it("skips files with invalid frontmatter", async () => {
		await writeCommand("bad.md", "# no frontmatter\n");
		await writeCommand(
			"good.md",
			"---\nname: good\ndescription: Good\n---\nBody.",
		);

		expect(await loadCommands(workspace)).toEqual([
			{ name: "good", description: "Good", body: "Body." },
		]);
	});

	it("skips the built-in command names", async () => {
		for (const name of BUILTIN_COMMAND_NAMES) {
			await writeCommand(
				`${name}.md`,
				`---\nname: ${name}\ndescription: Built-in\n---\nBody.`,
			);
		}
		await writeCommand(
			"custom.md",
			"---\nname: custom\ndescription: Custom\n---\nBody.",
		);

		expect(await loadCommands(workspace)).toEqual([
			{ name: "custom", description: "Custom", body: "Body." },
		]);
	});

	it("ignores non-markdown files", async () => {
		await mkdir(commandsDir(workspace), { recursive: true });
		await writeFile(join(commandsDir(workspace), "notes.txt"), "hi", "utf8");

		expect(await loadCommands(workspace)).toEqual([]);
	});

	it("returns [] when the directory is missing", async () => {
		expect(await loadCommands(workspace)).toEqual([]);
	});
});
