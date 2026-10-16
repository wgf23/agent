import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesChangedTracker } from "../../src/serve/files-changed.js";

// A real directory so the tracker's realpath-based escape check has a root.
let workspaceRoot: string;

beforeEach(() => {
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-files-changed-"));
});

// Feeds one started/finished pair, the way the agent loop emits them, and
// returns what the tracker decided the event means for the tree.
function finish(
	tracker: FilesChangedTracker,
	name: string,
	args: unknown,
	status: "ok" | "error" | "blocked" = "ok",
): string[] | null {
	tracker.onEvent(workspaceRoot, {
		type: "tool_started",
		id: "call-1",
		name,
		args,
	});
	return tracker.onEvent(workspaceRoot, {
		type: "tool_finished",
		id: "call-1",
		name,
		ok: status === "ok",
		status,
		summary: "",
		output: "",
	});
}

describe("FilesChangedTracker", () => {
	it("names the literal workspace-relative path a write wrote", () => {
		const tracker = new FilesChangedTracker();
		expect(finish(tracker, "write_file", { path: "notes/hello.txt" })).toEqual([
			"notes/hello.txt",
		]);
		expect(finish(tracker, "edit_file", { path: "src/a.ts" })).toEqual([
			"src/a.ts",
		]);
	});

	it("normalizes a path before naming it", () => {
		const tracker = new FilesChangedTracker();
		expect(finish(tracker, "write_file", { path: "sub/../a.txt" })).toEqual([
			"a.txt",
		]);
	});

	it("emits nothing for a read", () => {
		const tracker = new FilesChangedTracker();
		expect(finish(tracker, "read_file", { path: "a.txt" })).toBeNull();
		expect(finish(tracker, "glob", { pattern: "**/*.ts" })).toBeNull();
	});

	it("refreshes blindly after a bash run, whose paths are unknown", () => {
		const tracker = new FilesChangedTracker();
		expect(finish(tracker, "bash", { command: "touch a.txt" })).toEqual([]);
	});

	it("drops a path that escapes the workspace or is absent", () => {
		const tracker = new FilesChangedTracker();
		expect(finish(tracker, "write_file", { path: "../escape.txt" })).toEqual(
			[],
		);
		expect(finish(tracker, "write_file", { path: "/etc/passwd" })).toEqual([]);
		expect(finish(tracker, "write_file", {})).toEqual([]);
		expect(finish(tracker, "write_file", { path: "" })).toEqual([]);
	});

	it("ignores a write that did not succeed", () => {
		const tracker = new FilesChangedTracker();
		expect(
			finish(tracker, "write_file", { path: "a.txt" }, "error"),
		).toBeNull();
		expect(
			finish(tracker, "edit_file", { path: "a.txt" }, "blocked"),
		).toBeNull();
	});
});
