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

describe("resolveConfig compaction", () => {
	it("uses the built-in compaction defaults", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.compaction).toEqual({
			auto: true,
			thresholdTokens: 100000,
			keepRecentTokens: 20000,
		});
	});

	it("merges project over global over defaults per field", async () => {
		await writeGlobal({
			compaction: { auto: false, thresholdTokens: 5000 },
		});
		await writeProject({ compaction: { thresholdTokens: 1234 } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.compaction).toEqual({
			auto: false,
			thresholdTokens: 1234,
			keepRecentTokens: 20000,
		});
	});

	it("reads compaction from the global file", async () => {
		await writeGlobal({ compaction: { keepRecentTokens: 7 } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.compaction.keepRecentTokens).toBe(7);
		expect(result.config.compaction.thresholdTokens).toBe(100000);
	});

	it("rejects an invalid compaction block and names the file", async () => {
		await writeProject({ compaction: { thresholdTokens: "big" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid compaction");
		expect(result.error).toContain(path.join(workspaceRoot, "my-agent.json"));
	});
});

describe("resolveConfig sandbox", () => {
	it("uses the built-in sandbox defaults", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.sandbox).toEqual({
			mode: "auto",
			network: false,
			writablePaths: [],
		});
	});

	it("merges project over global over defaults per field", async () => {
		await writeGlobal({ sandbox: { mode: "require", network: true } });
		await writeProject({
			sandbox: { network: false, writablePaths: ["/data"] },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.sandbox).toEqual({
			mode: "require",
			network: false,
			writablePaths: ["/data"],
		});
	});

	it("reads sandbox from the global file", async () => {
		await writeGlobal({ sandbox: { mode: "off" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.sandbox).toEqual({
			mode: "off",
			network: false,
			writablePaths: [],
		});
	});

	it("rejects an invalid sandbox block and names the file", async () => {
		await writeProject({ sandbox: { mode: "sometimes" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid sandbox");
		expect(result.error).toContain(path.join(workspaceRoot, "my-agent.json"));
	});
});

describe("resolveConfig mcp", () => {
	it("defaults to no servers", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.mcpServers).toEqual({});
	});

	it("merges project servers over global servers by name", async () => {
		await writeGlobal({
			mcp: {
				servers: {
					memory: { command: ["global-memory"] },
					files: { command: ["global-files"], env: { ROOT: "/global" } },
				},
			},
		});
		await writeProject({
			mcp: {
				servers: {
					memory: {
						command: ["project-memory", "--flag"],
						env: { ROOT: "/w" },
					},
				},
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.mcpServers).toEqual({
			memory: {
				command: ["project-memory", "--flag"],
				env: { ROOT: "/w" },
			},
			files: { command: ["global-files"], env: { ROOT: "/global" } },
		});
	});

	it("rejects a bad server name with the literal error", async () => {
		await writeProject({
			mcp: { servers: { "bad name": { command: ["memory"] } } },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid mcp in ${path.join(workspaceRoot, "my-agent.json")}: server name "bad name" is invalid. Use letters, digits, "_" and "-".`,
		);
	});

	it("rejects an empty command with the literal error", async () => {
		await writeProject({ mcp: { servers: { memory: { command: [] } } } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid mcp in ${path.join(workspaceRoot, "my-agent.json")}: server "memory": "command" must be a non-empty array of strings.`,
		);
	});

	it("rejects an http server with the literal error", async () => {
		await writeProject({
			mcp: { servers: { memory: { url: "https://example.com/mcp" } } },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid mcp in ${path.join(workspaceRoot, "my-agent.json")}: only stdio command servers are supported for now (server "memory").`,
		);
	});
});

describe("resolveConfig embeddings", () => {
	it("is undefined by default", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.embeddings).toBeUndefined();
	});

	it("reads an embeddings block from the project file", async () => {
		await writeProject({
			embeddings: {
				baseURL: "https://api.openai.com/v1",
				model: "text-embedding-3-small",
				apiKeyEnv: "OPENAI_API_KEY",
				dimensions: 1536,
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.embeddings).toEqual({
			baseURL: "https://api.openai.com/v1",
			model: "text-embedding-3-small",
			apiKeyEnv: "OPENAI_API_KEY",
			dimensions: 1536,
		});
	});

	it("merges project over global per field", async () => {
		await writeGlobal({
			embeddings: {
				baseURL: "https://global.example/v1",
				model: "global-model",
				apiKeyEnv: "GLOBAL_KEY",
				dimensions: 1024,
			},
		});
		await writeProject({
			embeddings: {
				baseURL: "https://project.example/v1",
				model: "project-model",
				apiKeyEnv: "PROJECT_KEY",
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.embeddings).toEqual({
			baseURL: "https://project.example/v1",
			model: "project-model",
			apiKeyEnv: "PROJECT_KEY",
			dimensions: 1024,
		});
	});

	it("rejects an incomplete embeddings block and names the file", async () => {
		await writeProject({ embeddings: { model: "text-embedding-3-small" } });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid embeddings");
		expect(result.error).toContain(path.join(workspaceRoot, "my-agent.json"));
	});
});

describe("resolveConfig plugins", () => {
	it("defaults to no plugins", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.plugins).toEqual([]);
	});

	it("merges project and global plugins and dedupes by spec", async () => {
		await writeGlobal({ plugins: ["plugin-a", "plugin-b"] });
		await writeProject({ plugins: ["plugin-b", "plugin-c"] });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.plugins).toEqual(["plugin-a", "plugin-b", "plugin-c"]);
	});

	it("rejects a non-array plugins value and names the file", async () => {
		await writeProject({ plugins: "plugin-a" });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid plugins");
		expect(result.error).toContain(path.join(workspaceRoot, "my-agent.json"));
	});

	it("rejects a non-string entry and names the file", async () => {
		await writeProject({ plugins: ["plugin-a", 7] });

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid plugins");
		expect(result.error).toContain(path.join(workspaceRoot, "my-agent.json"));
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
