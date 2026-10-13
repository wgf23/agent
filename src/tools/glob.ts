import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { loadGitignore, toPosix } from "../util/gitignore.js";
import { resolveInWorkspace } from "../util/paths.js";
import type { Tool } from "./types.js";

const MAX_RESULTS = 1000;

const schema = z
	.object({
		pattern: z.string().describe("Glob pattern, for example **/*.ts."),
		path: z
			.string()
			.optional()
			.describe("Directory to search, relative to the workspace root."),
	})
	.strict();

export const globTool: Tool<typeof schema> = {
	name: "glob",
	description:
		"Find files by glob pattern. Ignores node_modules, .git, and paths listed in the root .gitignore. Returns workspace-relative paths.",
	readOnly: true,
	schema,
	async execute(args, ctx) {
		let base: string;
		try {
			base = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		const matcher = await loadGitignore(ctx.workspaceRoot);
		let matches: string[];
		try {
			matches = await fg(args.pattern, {
				cwd: base,
				onlyFiles: true,
				dot: false,
				absolute: false,
				followSymbolicLinks: false,
				ignore: ["**/node_modules/**", "**/.git/**"],
			});
		} catch (error) {
			return { ok: false, error: `glob: ${errorMessage(error)}` };
		}

		const kept = matches
			.map((match) =>
				toPosix(path.relative(ctx.workspaceRoot, path.resolve(base, match))),
			)
			.filter((relative) => !matcher.ignores(relative))
			.sort();

		if (kept.length <= MAX_RESULTS) {
			return { ok: true, output: kept.join("\n") };
		}
		const omitted = kept.length - MAX_RESULTS;
		return {
			ok: true,
			output: `${kept.slice(0, MAX_RESULTS).join("\n")}\n[truncated: ${omitted} paths omitted]`,
		};
	},
};
