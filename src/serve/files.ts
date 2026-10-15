import type { Dirent } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
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

// A structure-operation refusal. It carries the HTTP status the route should
// answer, so the rule lives next to the check that raised it: a boundary or a
// validation failure is a 400 and a missing source a 404.
export class FileOpError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "FileOpError";
		this.status = status;
	}
}

// A leaf name an entry operation may create or rename to: non-empty, never the
// current or parent directory token, and free of any path separator or NUL.
// resolveInWorkspace normalizes a `..` away, so this is what keeps a name a
// name rather than a silent second path segment.
export function isValidEntryName(name: string): boolean {
	return (
		name !== "" &&
		name !== "." &&
		name !== ".." &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0")
	);
}

// Every segment of a relative path must be a valid entry name. A multi-segment
// path is allowed (mkdir creates the missing parents), but no part may be `..`
// or carry a separator smuggled through a decoded value.
function invalidEntryPath(relPath: string): string | null {
	if (relPath === "") return "path is empty";
	for (const segment of relPath.split("/")) {
		if (!isValidEntryName(segment)) return `Invalid name: ${segment}`;
	}
	return null;
}

// Creates a directory at `relPath`, creating any missing parents. An existing
// target is refused rather than silently accepted: mkdir recursive resolves on
// an existing directory, so without this check the UI could not tell a new
// folder from one that was already there.
export async function mkdirInWorkspace(
	workspaceRoot: string,
	relPath: string,
): Promise<void> {
	const nameError = invalidEntryPath(relPath);
	if (nameError !== null) throw new FileOpError(nameError);
	const target = resolveInWorkspace(workspaceRoot, relPath);
	if (await entryExists(target)) {
		throw new FileOpError(`Already exists: ${relPath}`);
	}
	await mkdir(target, { recursive: true });
}

// Renames one entry inside the workspace. The workspace root itself cannot be
// renamed, an existing destination is refused so a rename never clobbers, and
// a missing source is reported as such.
export async function renameEntry(
	workspaceRoot: string,
	fromRel: string,
	toRel: string,
): Promise<void> {
	const fromError = invalidEntryPath(fromRel);
	if (fromError !== null) throw new FileOpError(fromError);
	const toError = invalidEntryPath(toRel);
	if (toError !== null) throw new FileOpError(`Invalid target: ${toError}`);
	if (fromRel === "") {
		throw new FileOpError("cannot rename the workspace root");
	}
	const from = resolveInWorkspace(workspaceRoot, fromRel);
	const to = resolveInWorkspace(workspaceRoot, toRel);
	if (to === from) throw new FileOpError(`Already exists: ${toRel}`);
	if (await entryExists(to)) throw new FileOpError(`Already exists: ${toRel}`);
	if (!(await entryExists(from))) {
		throw new FileOpError(`No such path: ${fromRel}`, 404);
	}
	await rename(from, to);
}

// Moves one entry to `toRel` inside the workspace. A destination inside the
// source's own subtree would detach the tree from itself, an existing
// destination is refused, and a missing source is a 404. A rename is attempted
// first; across filesystems (EXDEV) the entry is copied and the source then
// removed, with the copy rolled back if that removal fails.
export async function moveEntry(
	workspaceRoot: string,
	fromRel: string,
	toRel: string,
): Promise<void> {
	const fromError = invalidEntryPath(fromRel);
	if (fromError !== null) throw new FileOpError(fromError);
	const toError = invalidEntryPath(toRel);
	if (toError !== null) throw new FileOpError(`Invalid target: ${toError}`);
	if (fromRel === "") {
		throw new FileOpError("cannot move the workspace root");
	}
	const from = resolveInWorkspace(workspaceRoot, fromRel);
	const to = resolveInWorkspace(workspaceRoot, toRel);
	if (to === from) throw new FileOpError(`Already exists: ${toRel}`);
	if (isInside(from, to)) {
		throw new FileOpError("cannot move a directory into its own subtree");
	}
	if (await entryExists(to)) throw new FileOpError(`Already exists: ${toRel}`);
	if (!(await entryExists(from))) {
		throw new FileOpError(`No such path: ${fromRel}`, 404);
	}
	try {
		await rename(from, to);
	} catch (error) {
		if (!isCrossDevice(error)) throw error;
		await copyThenDelete(from, to);
	}
}

// Deletes one entry. The workspace root is refused; a directory requires the
// caller to opt into `recursive`, so a stray call can never remove a subtree a
// user did not confirm; and a missing path is a 404.
export async function deleteEntry(
	workspaceRoot: string,
	relPath: string,
	recursive: boolean,
): Promise<void> {
	const nameError = invalidEntryPath(relPath);
	if (nameError !== null) throw new FileOpError(nameError);
	if (relPath === "") {
		throw new FileOpError("cannot delete the workspace root");
	}
	const target = resolveInWorkspace(workspaceRoot, relPath);
	const info = await lstatEntry(target, relPath);
	if (info.isDirectory() && !recursive) {
		throw new FileOpError("deleting a directory requires recursive");
	}
	await rm(target, { recursive, force: false });
}

// Classifies one entry for delete: a missing path is a clear 404 reason and any
// other stat failure propagates for the route to report as unexpected.
async function lstatEntry(target: string, relPath: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if (isMissing(error)) {
			throw new FileOpError(`No such path: ${relPath}`, 404);
		}
		throw error;
	}
}

// A destination check for the structure ops: lstat, not stat, so a broken
// symlink counts as present and rename/mkdir never replaces it. A missing path
// is false; any other stat failure propagates.
async function entryExists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

// The cross-device fallback for a move: copy the whole entry, then remove the
// source. If the removal half fails the copy is rolled back, so a move is
// all-or-nothing rather than leaving a duplicate behind.
async function copyThenDelete(from: string, to: string): Promise<void> {
	await cp(from, to, { recursive: true });
	try {
		await rm(from, { recursive: true, force: false });
	} catch (error) {
		await rm(to, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

function isCrossDevice(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return (error as { code?: unknown }).code === "EXDEV";
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
