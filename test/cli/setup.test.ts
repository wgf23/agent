import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	missingKeyDecision,
	runSetupWizard,
	type SetupIo,
	type SetupVerify,
} from "../../src/cli/setup.js";
import {
	readCredentials,
	writeCredential,
} from "../../src/config/credentials.js";
import { globalConfigPath } from "../../src/config/resolve.js";

const KEY = "sk-live-1234567890abcdef";

let homeDir: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-setup-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

function fakeIo(answers: string[]): { io: SetupIo; lines: string[] } {
	const lines: string[] = [];
	let index = 0;
	const next = (): Promise<string> => {
		const value = answers[index] ?? "";
		index += 1;
		return Promise.resolve(value);
	};
	return {
		io: {
			ask: next,
			askHidden: next,
			print: (line) => {
				lines.push(line);
			},
		},
		lines,
	};
}

const acceptAll: SetupVerify = async () => ({ ok: true });

describe("runSetupWizard", () => {
	it("stores the key under DEEPSEEK_API_KEY for the default preset", async () => {
		const { io, lines } = fakeIo(["", "", KEY]);
		const verify = vi.fn(async () => ({ ok: true as const }));

		const code = await runSetupWizard({ io, homeDir, env: {}, verify });

		expect(code).toBe(0);
		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { DEEPSEEK_API_KEY: KEY },
		});
		expect(verify).toHaveBeenCalledWith({
			baseURL: "https://api.deepseek.com",
			model: "deepseek-flash",
			apiKeyEnv: "DEEPSEEK_API_KEY",
			apiKey: KEY,
		});
		expect(lines.join("\n")).not.toContain(KEY);
	});

	it("writes the global config and stores a custom endpoint key", async () => {
		const { io, lines } = fakeIo([
			"custom",
			"http://localhost:11434/v1",
			"OLLAMA_API_KEY",
			"qwen3",
			KEY,
		]);

		const code = await runSetupWizard({
			io,
			homeDir,
			env: {},
			verify: acceptAll,
		});

		expect(code).toBe(0);
		expect(await readFile(globalConfigPath(homeDir), "utf8")).toBe(`{
  "provider": {
    "preset": "openai",
    "model": "qwen3",
    "baseURL": "http://localhost:11434/v1",
    "apiKeyEnv": "OLLAMA_API_KEY"
  }
}
`);
		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { OLLAMA_API_KEY: KEY },
		});
		expect(lines.join("\n")).not.toContain(KEY);
	});

	it("exits 1 and writes nothing when verification fails and the user declines", async () => {
		const { io } = fakeIo(["", "", KEY, ""]);
		const verify: SetupVerify = async () => ({
			ok: false,
			error: "The API key was rejected.",
		});

		const code = await runSetupWizard({ io, homeDir, env: {}, verify });

		expect(code).toBe(1);
		expect(readCredentials(homeDir)).toEqual({ ok: true, keys: {} });
		expect(existsSync(globalConfigPath(homeDir))).toBe(false);
	});

	it("stores the key when verification fails but the user saves anyway", async () => {
		const { io } = fakeIo(["", "", KEY, "y"]);
		const verify: SetupVerify = async () => ({
			ok: false,
			error: "The API key was rejected.",
		});

		const code = await runSetupWizard({ io, homeDir, env: {}, verify });

		expect(code).toBe(0);
		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { DEEPSEEK_API_KEY: KEY },
		});
	});

	it("keeps an existing stored key when the answer is empty", async () => {
		await writeCredential(homeDir, "DEEPSEEK_API_KEY", "stored-old");
		const { io } = fakeIo(["", "", ""]);
		const verify = vi.fn(async () => ({ ok: true as const }));

		const code = await runSetupWizard({ io, homeDir, env: {}, verify });

		expect(code).toBe(0);
		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { DEEPSEEK_API_KEY: "stored-old" },
		});
		expect(verify).not.toHaveBeenCalled();
	});

	it("offers to keep an environment key without storing it", async () => {
		const { io, lines } = fakeIo(["", "", ""]);

		const code = await runSetupWizard({
			io,
			homeDir,
			env: { DEEPSEEK_API_KEY: "env-key" },
			verify: acceptAll,
		});

		expect(code).toBe(0);
		expect(readCredentials(homeDir)).toEqual({ ok: true, keys: {} });
		expect(lines.join("\n")).toContain(
			"A key is already configured via the environment variable DEEPSEEK_API_KEY.",
		);
		expect(lines.join("\n")).not.toContain("env-key");
	});

	it("re-asks once for an empty key and exits 1 when it stays empty", async () => {
		const { io } = fakeIo(["", "", "", ""]);
		const verify = vi.fn(async () => ({ ok: true as const }));

		const code = await runSetupWizard({ io, homeDir, env: {}, verify });

		expect(code).toBe(1);
		expect(readCredentials(homeDir)).toEqual({ ok: true, keys: {} });
		expect(verify).not.toHaveBeenCalled();
	});
});

describe("missingKeyDecision", () => {
	it("returns none when a key is present", () => {
		expect(missingKeyDecision("k", true)).toBe("none");
		expect(missingKeyDecision("k", false)).toBe("none");
	});

	it("returns setup when the key is missing on a TTY", () => {
		expect(missingKeyDecision(undefined, true)).toBe("setup");
	});

	it("returns error when the key is missing and stdin is not a TTY", () => {
		expect(missingKeyDecision(undefined, false)).toBe("error");
	});
});
