import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npmGlobalBinDir, probeVersion } from "../../src/agents/probe.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const AGENT_FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-agent.mjs", import.meta.url),
);
const NPM_FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-npm.mjs", import.meta.url),
);

let workspace: string;
let agent: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-probe-");
	agent = path.join(workspace, "agent");
	await copyFile(AGENT_FIXTURE, agent);
	await chmod(agent, 0o755);
	await chmod(NPM_FIXTURE, 0o755);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	delete process.env.FAKE_AGENT_SCENARIO;
	delete process.env.FAKE_AGENT_ARGV_FILE;
	delete process.env.FAKE_AGENT_PID_FILE;
	delete process.env.FAKE_NPM_SCENARIO;
	delete process.env.FAKE_NPM_PREFIX;
});

describe("probeVersion", () => {
	it("captures the first non-empty stdout line as the version", async () => {
		const result = await probeVersion(agent, { timeoutMs: 2000 });
		expect(result).toEqual({ ok: true, version: "1.2.3", path: agent });
	});

	it("runs the resolved path with --version and no shell", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_AGENT_ARGV_FILE = argvFile;

		await probeVersion(agent, { timeoutMs: 2000 });

		expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(["--version"]);
	});

	it("reports a missing command as not_found without throwing", async () => {
		const result = await probeVersion("my-agent-no-such-cli", {
			pathEnv: workspace,
			timeoutMs: 2000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("not_found");
		expect(result.error).toMatch(/my-agent-no-such-cli/);
	});

	it("returns a null version when the binary prints nothing", async () => {
		process.env.FAKE_AGENT_SCENARIO = "empty";
		const result = await probeVersion(agent, { timeoutMs: 2000 });
		expect(result).toEqual({ ok: true, version: null, path: agent });
	});

	it("falls back to the first non-empty stderr line when stdout is empty", async () => {
		process.env.FAKE_AGENT_SCENARIO = "stderr-only";
		const result = await probeVersion(agent, { timeoutMs: 2000 });
		expect(result).toEqual({ ok: true, version: "9.9.9", path: agent });
	});

	it("resolves a command that is only in the npm global bin dir", async () => {
		const globalBin = path.join(workspace, "globalbin");
		const emptyPath = path.join(workspace, "empty");
		await mkdir(globalBin, { recursive: true });
		await copyFile(AGENT_FIXTURE, path.join(globalBin, "agent"));
		await chmod(path.join(globalBin, "agent"), 0o755);

		const result = await probeVersion("agent", {
			pathEnv: emptyPath,
			globalBinDir: async () => globalBin,
			timeoutMs: 2000,
		});

		expect(result).toEqual({
			ok: true,
			version: "1.2.3",
			path: path.join(globalBin, "agent"),
		});
	});

	it("kills a hung binary and resolves timeout instead of throwing", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_AGENT_SCENARIO = "sleep";
		process.env.FAKE_AGENT_PID_FILE = pidFile;

		const result = await probeVersion(agent, { timeoutMs: 150 });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("timeout");

		const pid = Number(await readFile(pidFile, "utf8"));
		await waitForGone(pid);
	});
});

describe("npmGlobalBinDir", () => {
	it("appends bin to the posix npm prefix", async () => {
		process.env.FAKE_NPM_SCENARIO = "prefix";
		process.env.FAKE_NPM_PREFIX = "/opt/node";
		expect(
			await npmGlobalBinDir({ command: NPM_FIXTURE, platform: "linux" }),
		).toBe(path.join("/opt/node", "bin"));
	});

	it("uses the prefix as-is on win32", async () => {
		process.env.FAKE_NPM_SCENARIO = "prefix";
		process.env.FAKE_NPM_PREFIX = "C:\\node";
		expect(
			await npmGlobalBinDir({ command: NPM_FIXTURE, platform: "win32" }),
		).toBe("C:\\node");
	});

	it("returns null when npm cannot report a prefix", async () => {
		process.env.FAKE_NPM_SCENARIO = "fail";
		expect(
			await npmGlobalBinDir({ command: NPM_FIXTURE, platform: "linux" }),
		).toBeNull();
	});

	it("returns null when the command does not exist", async () => {
		expect(
			await npmGlobalBinDir({
				command: path.join(workspace, "no-npm"),
				platform: "linux",
			}),
		).toBeNull();
	});
});

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
