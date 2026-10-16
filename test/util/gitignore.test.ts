import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSecretPath, loadGitignore } from "../../src/util/gitignore.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "gitignore-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("loadGitignore", () => {
	it("honors nested .gitignore rules", async () => {
		await mkdir(path.join(dir, "sub"), { recursive: true });
		await writeFile(path.join(dir, ".gitignore"), "*.log\n", "utf8");
		await writeFile(
			path.join(dir, "sub", ".gitignore"),
			"secret.txt\n",
			"utf8",
		);

		const matcher = await loadGitignore(dir);

		expect(matcher.ignores("debug.log")).toBe(true);
		expect(matcher.ignores("sub/secret.txt")).toBe(true);
		expect(matcher.ignores("sub/keep.txt")).toBe(false);
	});

	it("always excludes the secret denylist", () => {
		expect(isSecretPath("credentials.json")).toBe(true);
		expect(isSecretPath("sub/private.key")).toBe(true);
		expect(isSecretPath("id_rsa")).toBe(true);
		expect(isSecretPath(".env")).toBe(true);
		expect(isSecretPath("notes.txt")).toBe(false);
	});
});
