import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { resolveInWorkspace } from "../util/paths.js";
import type { Tool } from "./types.js";

const schema = z
	.object({
		path: z.string().describe("File path relative to the workspace root."),
		content: z.string().describe("Full content to write to the file."),
	})
	.strict();

export const writeFileTool: Tool<typeof schema> = {
	name: "write_file",
	description:
		"Write a file. Creates missing parent directories and overwrites any existing file.",
	readOnly: false,
	schema,
	async execute(args, ctx) {
		let target: string;
		try {
			target = resolveInWorkspace(ctx.workspaceRoot, args.path);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		try {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, args.content, "utf8");
		} catch (error) {
			return { ok: false, error: `write_file: ${errorMessage(error)}` };
		}

		const bytes = Buffer.byteLength(args.content, "utf8");
		return { ok: true, output: `Wrote ${bytes} bytes to ${args.path}` };
	},
};
