import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILLS_DIR_ENV = "MY_AGENT_SKILLS_DIR";

export class SkillPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillPathError";
	}
}

// The one place that reads the skills-prefix override. Tests point
// MY_AGENT_SKILLS_DIR at a temp directory so they never read or write the real
// home directory.
export function skillsRoot(
	env: Record<string, string | undefined> = process.env,
	homeDir: string = os.homedir(),
): string {
	const override = env[SKILLS_DIR_ENV];
	if (override !== undefined && override.trim() !== "") {
		return path.resolve(override);
	}
	return path.join(homeDir, ".config", "my-agent", "skills");
}

// Mirrors resolveInWorkspace in src/util/paths.ts: a lexical check plus a
// realpath check so a symlink cannot point outside root.
export function resolveInside(root: string, relative: string): string {
	const realRoot = realpathSync(root);
	const candidate = path.resolve(realRoot, relative);
	if (!isInside(realRoot, candidate)) {
		throw new SkillPathError(`Path escapes ${root}: ${relative}`);
	}

	const real = realpathDeepestExisting(candidate);
	if (!isInside(realRoot, real)) {
		throw new SkillPathError(
			`Path escapes ${root} through a symlink: ${relative}`,
		);
	}

	return candidate;
}

function isInside(root: string, target: string): boolean {
	if (target === root) return true;
	const rel = path.relative(root, target);
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	);
}

function realpathDeepestExisting(target: string): string {
	const suffix: string[] = [];
	let current = target;
	for (;;) {
		try {
			return path.join(realpathSync(current), ...suffix.reverse());
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) return target;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
