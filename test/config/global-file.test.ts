import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGlobalProviderSettings } from "../../src/config/global-file.js";
import { globalConfigPath } from "../../src/config/resolve.js";

let homeDir: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-global-file-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

describe("writeGlobalProviderSettings", () => {
	it("writes the provider block as two-space JSON with a trailing newline", async () => {
		const result = await writeGlobalProviderSettings(homeDir, {
			preset: "deepseek",
			model: "deepseek-flash",
		});

		expect(result).toEqual({ ok: true });
		expect(await readFile(globalConfigPath(homeDir), "utf8")).toBe(`{
  "provider": {
    "preset": "deepseek",
    "model": "deepseek-flash"
  }
}
`);
	});

	it("merges into an existing file and preserves unrelated keys", async () => {
		const filePath = globalConfigPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(
			filePath,
			`${JSON.stringify(
				{ provider: { thinking: "disabled" }, custom: true },
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await writeGlobalProviderSettings(homeDir, {
			preset: "openai",
			model: "gpt-4o-mini",
			baseURL: "http://localhost:11434/v1",
			apiKeyEnv: "OLLAMA_API_KEY",
		});

		expect(result).toEqual({ ok: true });
		expect(await readFile(filePath, "utf8")).toBe(`{
  "provider": {
    "thinking": "disabled",
    "preset": "openai",
    "model": "gpt-4o-mini",
    "baseURL": "http://localhost:11434/v1",
    "apiKeyEnv": "OLLAMA_API_KEY"
  },
  "custom": true
}
`);
	});

	it("drops baseURL and apiKeyEnv when a built-in preset is written", async () => {
		const filePath = globalConfigPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(
			filePath,
			`${JSON.stringify(
				{
					provider: {
						preset: "openai",
						baseURL: "http://localhost:11434/v1",
						apiKeyEnv: "OLLAMA_API_KEY",
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		await writeGlobalProviderSettings(homeDir, {
			preset: "deepseek",
			model: "deepseek-flash",
		});

		expect(await readFile(filePath, "utf8")).toBe(`{
  "provider": {
    "preset": "deepseek",
    "model": "deepseek-flash"
  }
}
`);
	});

	it("never writes an apiKey field", async () => {
		const filePath = globalConfigPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(
			filePath,
			JSON.stringify({ provider: { apiKey: "sk-secret", thinking: "low" } }),
			"utf8",
		);

		await writeGlobalProviderSettings(homeDir, {
			preset: "deepseek",
			model: "deepseek-flash",
		});

		expect(await readFile(filePath, "utf8")).not.toContain("apiKey");
	});
});
