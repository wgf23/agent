import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { resolveInWorkspace } from "../util/paths.js";
import { truncateOutput } from "../util/truncate.js";
import type { Tool } from "./types.js";

const schema = z
	.object({
		path: z.string().describe("File path relative to the workspace root."),
		offset: z
			.number()
			.int()
			.min(1)
			.default(1)
			.describe("1-based line number to start reading from."),
		limit: z
			.number()
			.int()
			.min(1)
			.default(2000)
			.describe("Maximum number of lines to return."),
	})
	.strict();

export const readFileTool: Tool<typeof schema> = {
	name: "read_file",
	description:
		"Read a text file. Returns each line prefixed with its 1-based line number.",
	readOnly: true,
	schema,
	async execute(args, ctx) {
		let target: string;
		try {
			target = resolveInWorkspace(ctx.workspaceRoot, args.path);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		let isDirectory: boolean;
		try {
			isDirectory = (await stat(target)).isDirectory();
		} catch {
			return { ok: false, error: `read_file: file not found: ${args.path}` };
		}
		if (isDirectory) {
			return {
				ok: false,
				error: `read_file: path is a directory: ${args.path}`,
			};
		}

		const content = await readFile(target, "utf8");
		const lines = content.split("\n");
		const start = args.offset - 1;
		const numbered = lines
			.slice(start, start + args.limit)
			.map((line, index) => `${start + index + 1}\t${line}`)
			.join("\n");
		return { ok: true, output: truncateOutput(numbered).text };
	},
};
