import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	credentialsPath,
	writeCredential,
} from "../../src/config/credentials.js";
import {
	globalConfigPath,
	missingApiKeyMessage,
	resolveConfig,
} from "../../src/config/resolve.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-home-"));
	workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-ws-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
	await rm(workspaceRoot, { recursive: true, force: true });
});

async function writeGlobal(config: unknown): Promise<void> {
	const filePath = globalConfigPath(homeDir);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(config), "utf8");
}

async function writeProject(config: unknown): Promise<void> {
	await writeFile(
		path.join(workspaceRoot, "my-agent.json"),
		JSON.stringify(config),
		"utf8",
	);
}

describe("resolveConfig precedence", () => {
	it("lets a CLI model beat the environment and every file", async () => {
		await writeGlobal({ provider: { model: "deepseek-from-global" } });
		await writeProject({ provider: { model: "deepseek-from-project" } });

		const result = resolveConfig({
			cliModel: "deepseek/deepseek-v4-pro",
			workspaceRoot,
			env: { MY_AGENT_MODEL: "deepseek-from-env" },
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider.model).toBe("deepseek-v4-pro");
		expect(result.config.sources.model).toBe("cli");
		expect(result.config.sources.preset).toBe("cli");
	});

	it("lets MY_AGENT_MODEL beat the project and global files", async () => {
		await writeGlobal({ provider: { model: "deepseek-from-global" } });
		await writeProject({ provider: { model: "deepseek-from-project" } });

		const result = resolveConfig({
			workspaceRoot,
			env: { MY_AGENT_MODEL: "deepseek/deepseek-v4-pro" },
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider.model).toBe("deepseek-v4-pro");
		expect(result.config.sources.model).toBe("env");
	});

	it("lets the project file beat the global file", async () => {
		await writeGlobal({ provider: { model: "deepseek-from-global" } });
		await writeProject({ provider: { model: "deepseek-from-project" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider.model).toBe("deepseek-from-project");
		expect(result.config.sources.model).toBe("project");
	});

	it("lets the global file beat the built-in defaults", async () => {
		await writeGlobal({ provider: { model: "deepseek-v4-pro" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider.model).toBe("deepseek-v4-pro");
		expect(result.config.sources.model).toBe("global");
	});

	it("uses the built-in defaults when nothing else sets a field", async () => {
		const result = resolveConfig({
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "secret" },
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider).toEqual({
			preset: "deepseek",
			model: "deepseek-flash",
			thinking: "enabled",
			reasoningEffort: "high",
			baseURL: "https://api.deepseek.com",
			apiKeyEnv: "DEEPSEEK_API_KEY",
			maxSteps: 25,
		});
		expect(result.config.apiKey).toBe("secret");
		expect(result.config.permissions).toEqual({});
	});

	it("records the source of every field and reads permissions from the project", async () => {
		await writeGlobal({ provider: { reasoningEffort: "low", maxSteps: 7 } });
		await writeProject({
			provider: { baseURL: "http://localhost:8080/v1", thinking: "disabled" },
			permissions: { bash: [{ pattern: "git status*", action: "allow" }] },
		});

		const result = resolveConfig({
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "k" },
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.sources).toEqual({
			preset: "default",
			model: "default",
			thinking: "project",
			reasoningEffort: "global",
			baseURL: "project",
			apiKeyEnv: "default",
			maxSteps: "global",
		});
		expect(result.config.provider).toEqual({
			preset: "deepseek",
			model: "deepseek-flash",
			thinking: "disabled",
			reasoningEffort: "low",
			baseURL: "http://localhost:8080/v1",
			apiKeyEnv: "DEEPSEEK_API_KEY",
			maxSteps: 7,
		});
		expect(result.config.permissions).toEqual({
			bash: [{ pattern: "git status*", action: "allow" }],
		});
	});

	it("applies CLI maxSteps over the files", async () => {
		await writeProject({ provider: { maxSteps: 5 } });

		const result = resolveConfig({
			cliMaxSteps: 3,
			workspaceRoot,
			env: {},
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider.maxSteps).toBe(3);
		expect(result.config.sources.maxSteps).toBe("cli");
	});
});

describe("resolveConfig errors", () => {
	it("rejects a global file that tries to set permissions", async () => {
		await writeGlobal({
			provider: { model: "deepseek-flash" },
			permissions: { bash: "allow" },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cannot set permissions");
		expect(result.error).toContain(globalConfigPath(homeDir));
	});

	it("rejects a file that contains apiKey and points at an environment variable", async () => {
		await writeProject({ provider: { apiKey: "sk-secret" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('cannot set "apiKey"');
		expect(result.error).toContain("environment variable");
	});

	it("rejects an unknown preset and names the file", async () => {
		await writeGlobal({ provider: { preset: "ollama" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('Unknown preset "ollama"');
		expect(result.error).toContain(globalConfigPath(homeDir));
	});

	it("rejects a model that does not belong to the preset", async () => {
		await writeProject({
			provider: { preset: "openai", model: "deepseek-flash" },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("does not belong to preset");
	});

	it("rejects invalid JSON and names the file", async () => {
		await writeFile(
			path.join(workspaceRoot, "my-agent.json"),
			"{ not json",
			"utf8",
		);

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid JSON");
	});
});

describe("resolveConfig api key resolution", () => {
	it("prefers the environment key over a stored credential", async () => {
		await writeCredential(homeDir, "DEEPSEEK_API_KEY", "from-file");

		const result = resolveConfig({
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "from-env" },
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.apiKey).toBe("from-env");
		expect(result.config.apiKeySource).toBe("env");
	});

	it("falls back to the stored credential when the environment is absent", async () => {
		await writeCredential(homeDir, "DEEPSEEK_API_KEY", "from-file");

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.apiKey).toBe("from-file");
		expect(result.config.apiKeySource).toBe("credentials");
	});

	it("leaves the key undefined when neither source has one", () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.apiKey).toBeUndefined();
		expect(result.config.apiKeySource).toBeUndefined();
	});

	it("fails and names the credentials file when it is corrupt", async () => {
		const filePath = credentialsPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "{ not json", "utf8");

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(filePath);
	});
});

describe("missingApiKeyMessage", () => {
	it("points at my-agent setup and the environment variable", () => {
		expect(missingApiKeyMessage("DEEPSEEK_API_KEY")).toBe(
			'Missing DEEPSEEK_API_KEY. Run "my-agent setup" to store a key, or set the DEEPSEEK_API_KEY environment variable.',
		);
	});
});
