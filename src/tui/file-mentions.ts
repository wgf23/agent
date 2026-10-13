import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { loadGitignore, toPosix } from "../util/gitignore.js";
import { resolveInWorkspace } from "../util/paths.js";
import { commandSuggestions, type Suggestion } from "./suggestions.js";

export const MAX_WORKSPACE_FILES = 5000;
export const MAX_FILE_SUGGESTIONS = 20;
const MAX_FILE_LINES = 200;
const MAX_FILE_BYTES = 20 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024;

// The completion list is a convenience, so any load failure degrades to no
// suggestions rather than breaking the TUI.
export async function loadWorkspaceFiles(
	workspaceRoot: string,
): Promise<string[]> {
	try {
		const matcher = await loadGitignore(workspaceRoot);
		const matches = await fg("**/*", {
			cwd: workspaceRoot,
			onlyFiles: true,
			dot: true,
			absolute: false,
			followSymbolicLinks: false,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
		return matches
			.map(toPosix)
			.filter((relative) => !matcher.ignores(relative))
			.sort()
			.slice(0, MAX_WORKSPACE_FILES);
	} catch {
		return [];
	}
}

// The single-agent menu: commands while typing a slash command, files once the
// input holds a trailing @ mention.
export function agentSuggestions(
	text: string,
	files: readonly string[],
): Suggestion[] {
	const commands = commandSuggestions(text);
	if (commands.length > 0) return commands;
	return fileSuggestions(text, files);
}

export function fileSuggestions(
	text: string,
	files: readonly string[],
): Suggestion[] {
	const start = trailingTokenStart(text);
	const token = text.slice(start);
	if (!token.startsWith("@")) return [];
	if (tokenStartIsCommand(text, start)) return [];

	const fragment = token.slice(1).toLowerCase();
	const matched = files.filter((file) => file.toLowerCase().includes(fragment));
	const prefix = matched.filter((file) =>
		file.toLowerCase().startsWith(fragment),
	);
	const rest = matched.filter(
		(file) => !file.toLowerCase().startsWith(fragment),
	);
	return [...prefix, ...rest]
		.slice(0, MAX_FILE_SUGGESTIONS)
		.map((file) => ({ value: `@${file}`, label: `@${file}`, anchor: start }));
}

// A mention is the whitespace-delimited token that ends the input, which is
// where the cursor sits while the fragment is typed. A trailing space leaves an
// empty token and closes the query.
function trailingTokenStart(text: string): number {
	let index = text.length;
	while (index > 0 && !isWhitespace(text[index - 1] ?? "")) index -= 1;
	return index;
}

// File completion must not fire inside a slash command, where @ belongs to the
// command's arguments.
function tokenStartIsCommand(text: string, tokenStart: number): boolean {
	const linePrefix = text.slice(0, tokenStart).split("\n").at(-1) ?? "";
	return linePrefix.trimStart().startsWith("/");
}

function isWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\n";
}

export interface FileMentionExpansion {
	text: string;
	references: string[];
}

// Replaces nothing: each resolvable @path is read and appended as a block, and
// an unresolvable token stays literal. The per-file and total caps keep one
// message from flooding the context.
export async function expandFileMentions(
	text: string,
	workspaceRoot: string,
): Promise<FileMentionExpansion> {
	const references: string[] = [];
	const blocks: string[] = [];
	let totalBytes = 0;
	for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const mention = resolveMention(workspaceRoot, raw);
		if (mention === null || references.includes(mention.relative)) continue;
		const content = await readMentionFile(mention.absolute);
		if (content === null) continue;
		const { body, truncated } = clampFile(content);
		const block = `--- ${mention.relative}\n${body}${truncated ? "\n[truncated]" : ""}`;
		totalBytes += Buffer.byteLength(block, "utf8");
		if (totalBytes > MAX_TOTAL_BYTES) break;
		references.push(mention.relative);
		blocks.push(block);
	}
	if (blocks.length === 0) return { text, references: [] };
	return {
		text: `${text}\n\nReferenced files:\n${blocks.join("\n")}`,
		references,
	};
}

function resolveMention(
	workspaceRoot: string,
	raw: string,
): { absolute: string; relative: string } | null {
	try {
		const absolute = resolveInWorkspace(workspaceRoot, raw);
		return {
			absolute,
			relative: toPosix(path.relative(workspaceRoot, absolute)),
		};
	} catch {
		return null;
	}
}

async function readMentionFile(absolute: string): Promise<string | null> {
	try {
		const info = await stat(absolute);
		if (!info.isFile()) return null;
		return await readFile(absolute, "utf8");
	} catch {
		return null;
	}
}

function clampFile(content: string): { body: string; truncated: boolean } {
	const lines = content.split("\n");
	let body = lines.slice(0, MAX_FILE_LINES).join("\n");
	let truncated = lines.length > MAX_FILE_LINES;
	const bytes = Buffer.from(body, "utf8");
	if (bytes.length > MAX_FILE_BYTES) {
		body = bytes.subarray(0, MAX_FILE_BYTES).toString("utf8");
		truncated = true;
	}
	return { body, truncated };
}
