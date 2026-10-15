import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileEntry, FileListResponse } from "../../shared/protocol.js";
import { loadGitignore } from "../util/gitignore.js";
import { resolveInWorkspace } from "../util/paths.js";

export interface ListDirectoryOptions {
	showHidden?: boolean;
	showIgnored?: boolean;
	limit?: number;
}

// How one path resolves inside the workspace: a download answers 404 for a
// missing path and 400 for a directory, so the stat is classified rather than
// re-derived by the route. `path` is the absolute, in-workspace target.
export interface PathStat {
	path: string;
	kind: "missing" | "directory" | "file";
	size: number;
}

// A read that found nothing to list: the path is missing or is not a directory.
// The route answers 404 for this, distinct from a real failure (500).
export class NotADirectoryError extends Error {
	constructor(relative: string) {
		super(`Not a directory: ${relative}`);
		this.name = "NotADirectoryError";
	}
}

// The visible list is bounded so a huge directory cannot exhaust the browser;
// the rest is reported through `truncated` rather than silently forgotten.
const DEFAULT_LIMIT = 5000;

// Lists one directory inside the workspace. Every path is bounded by
// resolveInWorkspace, so a `..` or a symlink out of the root is refused before
// any read. A dot-prefixed name is hidden and a .gitignore match (on the posix
// relative path) is ignored; both are held in `ignored` so the UI can reveal
// them without a second request. The visible entries are capped at `limit`.
export async function listDirectory(
	workspaceRoot: string,
	relPath: string,
	options: ListDirectoryOptions = {},
): Promise<FileListResponse> {
	const dir = resolveInWorkspace(workspaceRoot, relPath);
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) throw new NotADirectoryError(relPath);
		throw error;
	}

	const matcher = await loadGitignore(workspaceRoot);
	const kept: FileEntry[] = [];
	const ignored: FileEntry[] = [];
	for (const dirent of dirents) {
		const entryPath = joinRel(relPath, dirent.name);
		const kind = kindOf(dirent);
		// lstat, not stat: a symlink reports its own link stats and stays a
		// symlink even when it points at a directory or another file.
		const info = await lstat(path.join(dir, dirent.name));
		const entry: FileEntry = {
			name: dirent.name,
			path: entryPath,
			kind,
			size: kind === "dir" ? 0 : info.size,
			mtime: info.mtimeMs,
		};
		const hidden = dirent.name.startsWith(".");
		const ignoredByGit = matcher.ignores(matchPath(entryPath, kind));
		if (
			(!hidden || options.showHidden === true) &&
			(!ignoredByGit || options.showIgnored === true)
		) {
			kept.push(entry);
		} else {
			ignored.push(entry);
		}
	}

	kept.sort(byKindThenName);
	ignored.sort(byKindThenName);
	const limit = options.limit ?? DEFAULT_LIMIT;
	const truncated = kept.length > limit;
	return {
		path: relPath,
		entries: truncated ? kept.slice(0, limit) : kept,
		ignored,
		truncated,
	};
}

// Stats one path inside the workspace and classifies it, so a download route
// can answer 404 (missing) or 400 (directory) without re-implementing the
// check. resolveInWorkspace bounds the path first, so an escape throws before
// any read; a stat that finds nothing is a "missing" answer rather than an
// error, and any other failure propagates so the route can answer 500.
export async function statPath(
	workspaceRoot: string,
	relPath: string,
): Promise<PathStat> {
	const resolved = resolveInWorkspace(workspaceRoot, relPath);
	try {
		const info = await stat(resolved);
		if (info.isDirectory()) {
			return { path: resolved, kind: "directory", size: 0 };
		}
		return { path: resolved, kind: "file", size: info.size };
	} catch (error) {
		if (isMissing(error)) return { path: resolved, kind: "missing", size: 0 };
		throw error;
	}
}

function kindOf(dirent: Dirent) {
	if (dirent.isSymbolicLink()) return "symlink" as const;
	if (dirent.isDirectory()) return "dir" as const;
	return "file" as const;
}

function joinRel(base: string, name: string): string {
	return base === "" ? name : `${base}/${name}`;
}

// The `ignore` package only treats a path as a directory when it ends in "/",
// which is what a `dist/` pattern requires to match at all.
function matchPath(relative: string, kind: FileEntry["kind"]): string {
	return kind === "dir" ? `${relative}/` : relative;
}

// Directories first, then the rest, each alphabetical, so a listing reads the
// way a file manager sorts it.
function byKindThenName(a: FileEntry, b: FileEntry): number {
	if (a.kind === "dir" && b.kind !== "dir") return -1;
	if (a.kind !== "dir" && b.kind === "dir") return 1;
	return a.name.localeCompare(b.name);
}

function isMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}
