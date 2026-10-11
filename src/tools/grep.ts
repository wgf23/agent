import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { loadGitignore, toPosix } from "../util/gitignore.js";
import { resolveInWorkspace } from "../util/paths.js";
import type { Tool } from "./types.js";

const MAX_MATCHES = 500;
const MAX_RG_OUTPUT_BYTES = 10 * 1024 * 1024;

const schema = z
	.object({
		pattern: z.string().describe("Regular expression to search for."),
		path: z
			.string()
			.optional()
			.describe("Directory to search, relative to the workspace root."),
		glob: z
			.string()
			.optional()
			.describe("Glob filter for the files to search, for example **/*.ts."),
		case_insensitive: z
			.boolean()
			.default(false)
			.describe("Match without regard to letter case."),
	})
	.strict();

interface SearchArgs {
	pattern: string;
	glob?: string;
	case_insensitive: boolean;
}

type SearchResult =
	| { ok: true; matches: string[] }
	| { ok: false; error: string };

export const grepTool: Tool<typeof schema> = {
	name: "grep",
	description:
		"Search file contents with a regular expression. Honors the root .gitignore. Returns matches as file:line:text.",
	readOnly: true,
	schema,
	async execute(args, ctx) {
		let base: string;
		try {
			base = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		let regex: RegExp;
		try {
			regex = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
		} catch (error) {
			return {
				ok: false,
				error: `grep: invalid pattern: ${errorMessage(error)}`,
			};
		}

		const search = hasRipgrep()
			? runRipgrep(args, ctx.workspaceRoot, base)
			: await runJsSearch(args, ctx.workspaceRoot, base, regex);
		if (!search.ok) {
			return { ok: false, error: search.error };
		}

		if (search.matches.length <= MAX_MATCHES) {
			return { ok: true, output: search.matches.join("\n") };
		}
		const omitted = search.matches.length - MAX_MATCHES;
		return {
			ok: true,
			output: `${search.matches.slice(0, MAX_MATCHES).join("\n")}\n[truncated: ${omitted} matches omitted]`,
		};
	},
};

function hasRipgrep(): boolean {
	const probe = spawnSync("rg", ["--version"], { stdio: "ignore" });
	return probe.error === undefined && probe.status === 0;
}

function runRipgrep(
	args: SearchArgs,
	workspaceRoot: string,
	base: string,
): SearchResult {
	const target = toPosix(path.relative(workspaceRoot, base)) || ".";
	const rgArgs = [
		"--line-number",
		"--no-heading",
		"--color=never",
		"--with-filename",
		// Honor .gitignore even when the workspace is not inside a git repository.
		"--no-require-git",
		"--glob",
		"!**/node_modules/**",
		"--glob",
		"!**/.git/**",
	];
	if (args.case_insensitive) rgArgs.push("--ignore-case");
	if (args.glob) rgArgs.push("--glob", args.glob);
	rgArgs.push("--", args.pattern, target);

	const result = spawnSync("rg", rgArgs, {
		cwd: workspaceRoot,
		encoding: "utf8",
		maxBuffer: MAX_RG_OUTPUT_BYTES,
	});
	if (result.error) {
		return {
			ok: false,
			error: `grep: failed to run ripgrep: ${result.error.message}`,
		};
	}
	// ripgrep exits 1 when there are no matches and 2 or more on a real error.
	if (result.status !== 0 && result.status !== 1) {
		return {
			ok: false,
			error: `grep: ripgrep exited with code ${result.status}: ${(result.stderr ?? "").trim()}`,
		};
	}

	const matches: string[] = [];
	for (const line of (result.stdout ?? "").split("\n")) {
		if (line === "") continue;
		const parsed = parseRgLine(line);
		if (!parsed) continue;
		const relative = toPosix(
			path.relative(workspaceRoot, path.resolve(workspaceRoot, parsed.file)),
		);
		matches.push(`${relative}:${parsed.lineNumber}:${parsed.text}`);
	}
	matches.sort();
	return { ok: true, matches };
}

function parseRgLine(
	line: string,
): { file: string; lineNumber: string; text: string } | undefined {
	const match = /^(.*?):(\d+):(.*)$/.exec(line);
	if (!match) return undefined;
	return { file: match[1], lineNumber: match[2], text: match[3] };
}

async function runJsSearch(
	args: SearchArgs,
	workspaceRoot: string,
	base: string,
	regex: RegExp,
): Promise<SearchResult> {
	const matcher = await loadGitignore(workspaceRoot);
	let files: string[];
	try {
		files = await fg(args.glob ?? "**/*", {
			cwd: base,
			onlyFiles: true,
			dot: false,
			absolute: false,
			followSymbolicLinks: false,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
	} catch (error) {
		return { ok: false, error: `grep: ${errorMessage(error)}` };
	}

	const matches: string[] = [];
	for (const file of files) {
		const relative = toPosix(
			path.relative(workspaceRoot, path.resolve(base, file)),
		);
		if (matcher.ignores(relative)) continue;
		let content: string;
		try {
			content = await readFile(path.resolve(base, file), "utf8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (regex.test(lines[index])) {
				matches.push(`${relative}:${index + 1}:${lines[index]}`);
			}
		}
	}
	matches.sort();
	return { ok: true, matches };
}
