import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteEntry,
	FileOpError,
	isValidEntryName,
	listDirectory,
	mkdirInWorkspace,
	moveEntry,
	NotADirectoryError,
	renameEntry,
} from "../../src/serve/files.js";
import { PathEscapeError } from "../../src/util/paths.js";

// The fixture mirrors the acceptance case: directories, a plain file, a
// dotfile, a `.gitignore` that hides `dist/`, and a symlink under src/.
const README_BYTES = Buffer.byteLength("# hi\n");

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "files-"));
	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "dist"));
	await writeFile(path.join(root, ".gitignore"), "dist/\n", "utf8");
	await writeFile(path.join(root, ".env"), "SECRET=1\n", "utf8");
	await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
	await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
	await symlink("../README.md", path.join(root, "src", "link.md"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("listDirectory", () => {
	it("returns directories first and holds dotfiles and ignored entries back", async () => {
		const listing = await listDirectory(root, "");

		expect(listing.path).toBe("");
		expect(listing.truncated).toBe(false);
		expect(listing.entries.map((entry) => entry.name)).toEqual([
			"src",
			"README.md",
		]);
		expect(listing.entries.map((entry) => entry.kind)).toEqual(["dir", "file"]);
		// dirs first inside the held-back list too, then the two dotfiles.
		expect(listing.ignored.map((entry) => entry.name)).toEqual([
			"dist",
			".env",
			".gitignore",
		]);
	});

	it("carries a real byte size and a numeric mtime for a file, size 0 for a directory", async () => {
		const listing = await listDirectory(root, "");
		const readme = listing.entries.find((entry) => entry.name === "README.md");
		const src = listing.entries.find((entry) => entry.name === "src");

		expect(readme?.size).toBe(README_BYTES);
		expect(typeof readme?.mtime).toBe("number");
		expect(readme?.mtime ?? 0).toBeGreaterThan(0);
		expect(src?.size).toBe(0);
	});

	it("reveals hidden entries only with showHidden", async () => {
		const listing = await listDirectory(root, "", { showHidden: true });

		expect(listing.entries.map((entry) => entry.name)).toEqual([
			"src",
			".env",
			".gitignore",
			"README.md",
		]);
		expect(listing.ignored.map((entry) => entry.name)).toEqual(["dist"]);
	});

	it("reveals gitignored entries only with showIgnored", async () => {
		const listing = await listDirectory(root, "", { showIgnored: true });

		expect(listing.entries.map((entry) => entry.name)).toEqual([
			"dist",
			"src",
			"README.md",
		]);
		expect(listing.ignored.map((entry) => entry.name)).toEqual([
			".env",
			".gitignore",
		]);
	});

	it("lists a subdirectory with posix relative paths and the right kinds", async () => {
		const listing = await listDirectory(root, "src");

		expect(listing.path).toBe("src");
		expect(listing.entries.map((entry) => entry.name)).toEqual([
			"index.ts",
			"link.md",
		]);
		expect(
			listing.entries.find((entry) => entry.name === "index.ts"),
		).toMatchObject({ path: "src/index.ts", kind: "file" });
		// A symlink keeps its own kind; lstat gives its link stats, not the
		// target's.
		expect(
			listing.entries.find((entry) => entry.name === "link.md"),
		).toMatchObject({ path: "src/link.md", kind: "symlink" });
	});

	it("clips the visible list at limit and reports the dropped entry", async () => {
		const full = await listDirectory(root, "");
		expect(full.entries).toHaveLength(2);

		const listing = await listDirectory(root, "", { limit: 1 });

		expect(listing.entries.map((entry) => entry.name)).toEqual(["src"]);
		expect(listing.truncated).toBe(true);
	});

	it("refuses a path that escapes the workspace", async () => {
		await expect(listDirectory(root, "../etc")).rejects.toBeInstanceOf(
			PathEscapeError,
		);
	});

	it("reports a missing or non-directory path as NotADirectoryError", async () => {
		await expect(listDirectory(root, "nope")).rejects.toBeInstanceOf(
			NotADirectoryError,
		);
		await expect(listDirectory(root, "README.md")).rejects.toBeInstanceOf(
			NotADirectoryError,
		);
	});
});

describe("isValidEntryName", () => {
	it("accepts an ordinary file or directory name", () => {
		expect(isValidEntryName("notes.txt")).toBe(true);
		expect(isValidEntryName(".env")).toBe(true);
		expect(isValidEntryName("目录")).toBe(true);
	});

	it("rejects empty, the dot tokens, and any separator or NUL", () => {
		expect(isValidEntryName("")).toBe(false);
		expect(isValidEntryName(".")).toBe(false);
		expect(isValidEntryName("..")).toBe(false);
		expect(isValidEntryName("a/b")).toBe(false);
		expect(isValidEntryName("a\\b")).toBe(false);
		expect(isValidEntryName("a\0b")).toBe(false);
	});
});

describe("mkdirInWorkspace", () => {
	it("creates the directory and any missing parents", async () => {
		await mkdirInWorkspace(root, "a/b/c");

		await expect(
			access(path.join(root, "a", "b", "c")),
		).resolves.toBeUndefined();
	});

	it("refuses an existing target with a reason", async () => {
		await mkdirInWorkspace(root, "one");

		await expect(mkdirInWorkspace(root, "one")).rejects.toMatchObject({
			name: "FileOpError",
			status: 400,
		});
	});

	it("refuses a name that is not a plain entry", async () => {
		// The name guard catches the `..` before the resolver ever sees it, so
		// both a climbing path and a smuggled second segment are the same 400.
		await expect(mkdirInWorkspace(root, "../x")).rejects.toMatchObject({
			name: "FileOpError",
			status: 400,
		});
		await expect(mkdirInWorkspace(root, "a/../x")).rejects.toBeInstanceOf(
			FileOpError,
		);
		await expect(mkdirInWorkspace(root, "")).rejects.toBeInstanceOf(
			FileOpError,
		);
	});
});

describe("renameEntry", () => {
	it("changes the on-disk name and leaves the bytes", async () => {
		await writeFile(path.join(root, "old.txt"), "keep\n", "utf8");

		await renameEntry(root, "old.txt", "new.txt");

		expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("keep\n");
		await expect(access(path.join(root, "old.txt"))).rejects.toBeDefined();
	});

	it("refuses an existing destination and changes nothing", async () => {
		await writeFile(path.join(root, "a.txt"), "A", "utf8");
		await writeFile(path.join(root, "b.txt"), "B", "utf8");

		await expect(renameEntry(root, "a.txt", "b.txt")).rejects.toBeInstanceOf(
			FileOpError,
		);

		expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("A");
		expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("B");
	});

	it("refuses the workspace root and a missing source", async () => {
		await expect(renameEntry(root, "", "top")).rejects.toBeInstanceOf(
			FileOpError,
		);
		await expect(renameEntry(root, "nope.txt", "x.txt")).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("moveEntry", () => {
	it("puts the entry under the new directory and removes it from the old one", async () => {
		await mkdir(path.join(root, "dest"));
		await writeFile(path.join(root, "src", "movable.ts"), "bytes", "utf8");

		await moveEntry(root, "src/movable.ts", "dest/movable.ts");

		expect(await readFile(path.join(root, "dest", "movable.ts"), "utf8")).toBe(
			"bytes",
		);
		await expect(
			access(path.join(root, "src", "movable.ts")),
		).rejects.toBeDefined();
	});

	it("refuses moving a directory into its own subtree and touches nothing", async () => {
		await mkdir(path.join(root, "box"));
		await writeFile(path.join(root, "box", "x.txt"), "x", "utf8");

		await expect(moveEntry(root, "box", "box/inner")).rejects.toBeInstanceOf(
			FileOpError,
		);

		expect(await readFile(path.join(root, "box", "x.txt"), "utf8")).toBe("x");
		await expect(access(path.join(root, "box", "inner"))).rejects.toBeDefined();
	});

	it("refuses an existing destination", async () => {
		await mkdir(path.join(root, "d1"));
		await mkdir(path.join(root, "d2"));
		await writeFile(path.join(root, "d1", "f.txt"), "1", "utf8");
		await writeFile(path.join(root, "d2", "f.txt"), "2", "utf8");

		await expect(
			moveEntry(root, "d1/f.txt", "d2/f.txt"),
		).rejects.toBeInstanceOf(FileOpError);

		expect(await readFile(path.join(root, "d1", "f.txt"), "utf8")).toBe("1");
		expect(await readFile(path.join(root, "d2", "f.txt"), "utf8")).toBe("2");
	});
});

describe("deleteEntry", () => {
	it("removes a file", async () => {
		await writeFile(path.join(root, "gone.txt"), "x", "utf8");

		await deleteEntry(root, "gone.txt", false);

		await expect(access(path.join(root, "gone.txt"))).rejects.toBeDefined();
	});

	it("refuses a non-empty directory without recursive and leaves it", async () => {
		await mkdir(path.join(root, "keep"));
		await writeFile(path.join(root, "keep", "x.txt"), "x", "utf8");

		await expect(deleteEntry(root, "keep", false)).rejects.toBeInstanceOf(
			FileOpError,
		);

		await expect(
			access(path.join(root, "keep", "x.txt")),
		).resolves.toBeUndefined();
	});

	it("removes a directory with recursive", async () => {
		await mkdir(path.join(root, "tree", "deep"), { recursive: true });
		await writeFile(path.join(root, "tree", "deep", "f"), "x", "utf8");

		await deleteEntry(root, "tree", true);

		await expect(access(path.join(root, "tree"))).rejects.toBeDefined();
	});

	it("refuses the workspace root and a missing path", async () => {
		await expect(deleteEntry(root, "", true)).rejects.toBeInstanceOf(
			FileOpError,
		);
		await expect(deleteEntry(root, "nope", false)).rejects.toMatchObject({
			status: 404,
		});
	});
});
