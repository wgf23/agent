import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectory, NotADirectoryError } from "../../src/serve/files.js";
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
