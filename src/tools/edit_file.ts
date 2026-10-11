import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { resolveInWorkspace } from "../util/paths.js";
import type { Tool } from "./types.js";

const schema = z
	.object({
		path: z.string().describe("File path relative to the workspace root."),
		old_string: z.string().describe("Exact text to replace."),
		new_string: z.string().describe("Replacement text."),
		replace_all: z
			.boolean()
			.default(false)
			.describe(
				"Replace every occurrence instead of requiring a unique match.",
			),
	})
	.strict();

export const editFileTool: Tool<typeof schema> = {
	name: "edit_file",
	description:
		"Replace an exact string in a file. Fails when the string is missing or ambiguous.",
	readOnly: false,
	schema,
	async execute(args, ctx) {
		let target: string;
		try {
			target = resolveInWorkspace(ctx.workspaceRoot, args.path);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		if (args.old_string === "") {
			return { ok: false, error: "edit_file: old_string must not be empty" };
		}
		if (args.old_string === args.new_string) {
			return {
				ok: false,
				error: "edit_file: old_string and new_string are identical",
			};
		}

		let content: string;
		try {
			content = await readFile(target, "utf8");
		} catch {
			return { ok: false, error: `edit_file: file not found: ${args.path}` };
		}

		const matches = countOccurrences(content, args.old_string);
		if (matches === 0) {
			return {
				ok: false,
				error: `edit_file: old_string not found in ${args.path}`,
			};
		}
		if (matches > 1 && !args.replace_all) {
			return {
				ok: false,
				error: `edit_file: old_string matches ${matches} times in ${args.path}; set replace_all to true to replace every occurrence`,
			};
		}

		const updated = args.replace_all
			? content.split(args.old_string).join(args.new_string)
			: replaceFirst(content, args.old_string, args.new_string);
		try {
			await writeFile(target, updated, "utf8");
		} catch (error) {
			return { ok: false, error: `edit_file: ${errorMessage(error)}` };
		}

		const replaced = args.replace_all ? matches : 1;
		return {
			ok: true,
			output: `Replaced ${replaced} occurrence(s) in ${args.path}`,
		};
	},
};

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string) {
	const index = haystack.indexOf(needle);
	return (
		haystack.slice(0, index) +
		replacement +
		haystack.slice(index + needle.length)
	);
}
