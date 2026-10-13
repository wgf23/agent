import { readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export async function loadGitignore(workspaceRoot: string): Promise<Ignore> {
	const matcher = ignore();
	try {
		matcher.add(await readFile(path.join(workspaceRoot, ".gitignore"), "utf8"));
	} catch {
		// A missing .gitignore is not an error; the empty matcher ignores nothing.
	}
	return matcher;
}

export function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}
