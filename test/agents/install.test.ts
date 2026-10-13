import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npmInstallGlobal } from "../../src/agents/install.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const NPM_FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-npm.mjs", import.meta.url),
);

let workspace: string;
let originalPath: string | undefined;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-install-");
	const binDir = path.join(workspace, "bin");
	await mkdir(binDir, { recursive: true });
	await copyFile(NPM_FIXTURE, path.join(binDir, "npm"));
	await chmod(path.join(binDir, "npm"), 0o755);
	originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
});

afterEach(async () => {
	process.env.PATH = originalPath;
	await removeWorkspace(workspace);
	delete process.env.FAKE_NPM_SCENARIO;
	delete process.env.FAKE_NPM_ARGV_FILE;
	delete process.env.FAKE_NPM_PID_FILE;
});

describe("npmInstallGlobal", () => {
	it("runs the exact global-install argv with no dangerous argument", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_NPM_ARGV_FILE = argvFile;

		const result = await npmInstallGlobal("@openai/codex", {});

		expect(result).toEqual({ ok: true });
		const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
		expect(argv).toEqual([
			"install",
			"-g",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			"--",
			"@openai/codex",
		]);
		for (const arg of argv) {
			expect(arg).not.toContain("sudo");
			expect(arg).not.toContain("|");
			expect(arg).not.toContain("&&");
			expect(arg).not.toContain("curl");
		}
	});

	it("folds stderr into the line stream and reports the last stderr line", async () => {
		process.env.FAKE_NPM_SCENARIO = "fail";
		const lines: string[] = [];

		const result = await npmInstallGlobal("pi", {
			onOutput: (line) => lines.push(line),
		});

		expect(lines).toContain("npm notice first line");
		expect(lines).toContain("npm ERR! install failed hard");
		expect(result).toEqual({
			ok: false,
			error: "npm ERR! install failed hard",
			cancelled: false,
		});
	});

	it("kills npm and resolves cancelled when the signal aborts", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_NPM_SCENARIO = "sleep";
		process.env.FAKE_NPM_PID_FILE = pidFile;
		const controller = new AbortController();

		const running = npmInstallGlobal("pi", { signal: controller.signal });
		const pid = Number(await waitForFile(pidFile));
		controller.abort();

		const result = await running;
		expect(result).toEqual({
			ok: false,
			error: "The npm install was cancelled.",
			cancelled: true,
		});
		await waitForGone(pid);
	});

	it("kills a hung npm and resolves a timeout failure", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_NPM_SCENARIO = "sleep";
		process.env.FAKE_NPM_PID_FILE = pidFile;

		const result = await npmInstallGlobal("pi", { timeoutMs: 150 });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.cancelled).toBe(false);
		expect(result.error).toMatch(/timed out after 150ms/);
		await waitForGone(Number(await readFile(pidFile, "utf8")));
	});

	it("reports an actionable error when npm is not on PATH", async () => {
		process.env.PATH = path.join(workspace, "empty");

		const result = await npmInstallGlobal("pi", {});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/npm is not on PATH/);
	});
});

async function waitForFile(file: string, timeoutMs = 3000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await readFile(file, "utf8");
		} catch {
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${file}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

async function waitForGone(pid: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() > deadline) throw new Error(`pid ${pid} is still alive`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
