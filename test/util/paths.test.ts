import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../../src/util/paths.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-paths-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("resolveInWorkspace", () => {
	it("resolves a relative path against the root", async () => {
		await writeFile(join(workspace, "a.txt"), "x", "utf8");
		expect(resolveInWorkspace(workspace, "a.txt")).toBe(
			join(realpathSync(workspace), "a.txt"),
		);
	});

	it("resolves a not-yet-existing path through its existing parent", async () => {
		await mkdir(join(workspace, "sub"));
		expect(resolveInWorkspace(workspace, "sub/new.txt")).toBe(
			join(realpathSync(workspace), "sub", "new.txt"),
		);
	});

	it("rejects absolute paths", () => {
		expect(() => resolveInWorkspace(workspace, "/etc/passwd")).toThrow(
			"Absolute paths are not allowed: /etc/passwd",
		);
	});

	it("rejects a path that leaves the root", () => {
		expect(() => resolveInWorkspace(workspace, "../escape.txt")).toThrow(
			"Path escapes the workspace: ../escape.txt",
		);
	});

	it("allows a file whose name starts with two dots", async () => {
		await writeFile(join(workspace, "..config"), "x", "utf8");
		expect(resolveInWorkspace(workspace, "..config")).toBe(
			join(realpathSync(workspace), "..config"),
		);
	});

	it("rejects a symlink pointing to /etc", async () => {
		await symlink("/etc", join(workspace, "etc-link"));
		expect(() => resolveInWorkspace(workspace, "etc-link")).toThrow(
			"escapes the workspace through a symlink",
		);
		expect(() => resolveInWorkspace(workspace, "etc-link/passwd")).toThrow(
			"escapes the workspace through a symlink",
		);
	});

	it("rejects a symlink to a directory outside the workspace", async () => {
		const outside = await makeWorkspace("my-agent-outside-");
		await writeFile(join(outside, "secret.txt"), "x", "utf8");
		await symlink(outside, join(workspace, "outside-link"));
		expect(() =>
			resolveInWorkspace(workspace, "outside-link/secret.txt"),
		).toThrow("escapes the workspace through a symlink");
		await removeWorkspace(outside);
	});

	it("allows a symlink that points inside the workspace", async () => {
		await mkdir(join(workspace, "real"));
		await symlink(join(workspace, "real"), join(workspace, "inside-link"));
		expect(resolveInWorkspace(workspace, "inside-link/file.txt")).toBe(
			join(realpathSync(workspace), "inside-link", "file.txt"),
		);
	});
});
