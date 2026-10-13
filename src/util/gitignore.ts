import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";

// These names never leave the machine: `semantic_search` ships file text to a
// third-party embeddings endpoint, so a secret denylist gates the index on top
// of every .gitignore rule. It is applied only where file text is shipped, not
// to grep/glob/mentions, which read files the user already asked for locally.
const SECRET_PATTERNS = [
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"id_rsa*",
	"*.p12",
	".npmrc",
	"credentials.json",
	"*.kdbx",
];

const secretMatcher = ignore().add(SECRET_PATTERNS);

// True for a relative path that must never be embedded, regardless of what any
// .gitignore says.
export function isSecretPath(relative: string): boolean {
	return secretMatcher.ignores(relative);
}

// Loads the root and nested .gitignore files. Nested rules are flattened with
// their directory as a prefix, which honors per-directory ignores and simple
// negations; a pattern with no slash still matches at any depth below the root.
export async function loadGitignore(workspaceRoot: string): Promise<Ignore> {
	const matcher = ignore();
	for (const relative of await findGitignores(workspaceRoot)) {
		let contents: string;
		try {
			contents = await readFile(path.join(workspaceRoot, relative), "utf8");
		} catch {
			continue;
		}
		matcher.add(patternsFor(contents, posixDirname(relative)));
	}
	return matcher;
}

async function findGitignores(workspaceRoot: string): Promise<string[]> {
	const matches = await fg("**/.gitignore", {
		cwd: workspaceRoot,
		onlyFiles: true,
		dot: true,
		absolute: false,
		followSymbolicLinks: false,
		ignore: ["**/node_modules/**", "**/.git/**"],
	});
	return matches
		.map((match) => toPosix(match))
		.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

function patternsFor(contents: string, baseDir: string): string[] {
	const prefix = baseDir === "" ? "" : `${baseDir}/`;
	const patterns: string[] = [];
	for (const raw of contents.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		let negated = false;
		let pattern = line;
		if (pattern.startsWith("!")) {
			negated = true;
			pattern = pattern.slice(1);
		}
		if (pattern.startsWith("/")) pattern = pattern.slice(1);
		patterns.push((negated ? "!" : "") + prefix + pattern);
	}
	return patterns;
}

function posixDirname(relative: string): string {
	const parts = relative.split("/");
	parts.pop();
	return parts.join("/");
}

function depth(relative: string): number {
	return relative.split("/").length;
}

export function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}
