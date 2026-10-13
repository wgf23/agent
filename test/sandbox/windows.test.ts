import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ensureWindowsHelperFile,
	windowsArgv,
	windowsHelperPath,
} from "../../src/sandbox/windows.js";

describe("windowsArgv", () => {
	it("builds the helper argv for pwsh and the workspace root", () => {
		expect(
			windowsArgv({
				command: "echo hi",
				pwsh: "C:/pwsh.exe",
				workspaceRoot: "C:/ws",
			}),
		).toEqual({
			argv: [
				"C:/pwsh.exe",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				windowsHelperPath(),
				"-Command",
				"echo hi",
				"-Cwd",
				"C:/ws",
			],
			env: {},
		});
	});
});

describe("ensureWindowsHelperFile", () => {
	it("writes a helper whose content matches the shipped script", async () => {
		const file = await ensureWindowsHelperFile();

		expect(file).toBe(windowsHelperPath());
		const written = readFileSync(file, "utf8");
		expect(written).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
		expect(written).toContain("AssignProcessToJobObject");

		const shipped = readFileSync(
			new URL("../../src/sandbox/windows-helper.ps1", import.meta.url),
			"utf8",
		);
		expect(written.trim()).toBe(shipped.trim());
	});
});
