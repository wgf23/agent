import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.js";
import { BUILTIN_COMMAND_NAMES, type Command } from "./commands.js";

// Commands live as markdown files under the workspace, each with SKILL.md-style
// frontmatter (name + description) followed by the prompt body.
export async function loadCommands(root: string): Promise<Command[]> {
	const dir = path.join(root, ".my-agent", "commands");
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		// A missing commands directory means no custom commands, never an error.
		return [];
	}

	const commands: Command[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const command = await loadCommandFile(path.join(dir, entry.name));
		if (command !== null) commands.push(command);
	}
	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCommandFile(file: string): Promise<Command | null> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	const parsed = parseFrontmatter(text);
	if (!parsed.ok) return null;
	if (BUILTIN_COMMAND_NAMES.includes(parsed.frontmatter.name)) return null;
	return {
		name: parsed.frontmatter.name,
		description: parsed.frontmatter.description,
		body: parsed.body,
	};
}
