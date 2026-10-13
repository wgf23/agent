import { realpathSync } from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathEscapeError";
	}
}

export function resolveInWorkspace(
	workspaceRoot: string,
	userPath: string,
): string {
	if (path.isAbsolute(userPath)) {
		throw new PathEscapeError(`Absolute paths are not allowed: ${userPath}`);
	}

	const root = realpathSync(workspaceRoot);
	const candidate = path.resolve(root, userPath);
	if (!isInside(root, candidate)) {
		throw new PathEscapeError(`Path escapes the workspace: ${userPath}`);
	}

	// A symlink can point outside the workspace even when its lexical path is
	// inside. realpath() fails on a path that does not exist yet, so resolve the
	// deepest existing ancestor and re-attach the missing suffix before checking.
	const real = realpathDeepestExisting(candidate);
	if (!isInside(root, real)) {
		throw new PathEscapeError(
			`Path escapes the workspace through a symlink: ${userPath}`,
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
