import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
	FileEntry,
	FileListResponse,
	FsDirEntry,
} from "../../shared/protocol.js";
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

// A browse target that exists but could not be read (a permission denial, an
// I/O failure). The route answers 400 with this reason, distinct from the 404
// a missing path gets.
export class BrowseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowseError";
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

// Whether an absolute path is one of the browse roots or lives inside one.
// Purely lexical, so it is trivially unit-testable and never touches disk: both
// sides are normalized, which is what makes a `..` that climbs back out of a
// root read as false even though the string still starts with the root. A
// symlink out of a root is not caught here; the browse route only ever lists
// under a root the user already opened.
export function isInsideBrowseRoots(
	target: string,
	roots: readonly string[],
): boolean {
	const resolved = path.resolve(target);
	return roots.some((root) => isInside(path.resolve(root), resolved));
}

// The lexical check above passes for a path that is textually inside a root but
// reaches it through a symlink, so the real path is checked too. This is the
// same rule resolveInWorkspace applies to files: a link inside the home must not
// widen the browse boundary to the rest of the host.
export async function assertBrowsePath(
	absPath: string,
	roots: readonly string[],
): Promise<void> {
	if (!isInsideBrowseRoots(absPath, roots)) {
		throw new BrowseError(`Path is outside the browse roots: ${absPath}`);
	}
	const realTarget = await realpathDeepest(absPath);
	const realRoots = await Promise.all(roots.map((root) => realpath(root)));
	if (!realRoots.some((root) => isInside(root, realTarget))) {
		throw new BrowseError(
			`Path escapes the browse roots through a symlink: ${absPath}`,
		);
	}
}

// realpath() fails on a path that does not exist yet, so resolve the deepest
// existing ancestor and re-attach the missing suffix, exactly as the workspace
// resolver does. A read of the missing part is left to the caller's readdir.
async function realpathDeepest(target: string): Promise<string> {
	const suffix: string[] = [];
	let current = target;
	for (;;) {
		try {
			const real = await realpath(current);
			return path.join(real, ...suffix.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) return target;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

function isInside(root: string, target: string): boolean {
	if (target === root) return true;
	const rel = path.relative(root, target);
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	);
}

// Lists only the subdirectories of one absolute browse path, sorted by name.
// A missing or non-directory path is the same NotADirectoryError the workspace
// listing raises (a 404); anything else that stops the read (a permission
// denial) is a BrowseError the route answers 400 for, so an unreadable root is
// never mistaken for an empty one.
export async function browseDirectories(
	absPath: string,
): Promise<FsDirEntry[]> {
	let dirents: Dirent[];
	try {
		dirents = await readdir(absPath, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) throw new NotADirectoryError(absPath);
		throw new BrowseError(`Cannot read directory: ${absPath}`);
	}

	// Directories only: a file is not a browse target, and a symlink is left
	// out rather than followed, so a link can never widen the browse boundary.
	const dirs: FsDirEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue;
		dirs.push({ name: dirent.name, path: path.join(absPath, dirent.name) });
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	return dirs;
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
