import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalConfigPath, resolveConfig } from "../../src/config/resolve.js";

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

describe("resolveConfig lsp", () => {
	it("defaults to no servers", async () => {
		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.lspServers).toEqual({});
	});

	it("parses a valid block with env, initialization, and disabled", async () => {
		await writeProject({
			lsp: {
				servers: {
					typescript: {
						command: ["typescript-language-server", "--stdio"],
						extensions: [".ts", ".tsx"],
						env: { KEY: "v" },
						initialization: { preference: { includeInlayHints: true } },
						disabled: false,
					},
				},
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.lspServers).toEqual({
			typescript: {
				command: ["typescript-language-server", "--stdio"],
				extensions: [".ts", ".tsx"],
				env: { KEY: "v" },
				initialization: { preference: { includeInlayHints: true } },
				disabled: false,
			},
		});
	});

	it("merges project servers over global servers by name", async () => {
		await writeGlobal({
			lsp: {
				servers: {
					typescript: { command: ["global-ts"], extensions: [".ts"] },
					python: { command: ["global-py"], extensions: [".py"] },
				},
			},
		});
		await writeProject({
			lsp: {
				servers: {
					typescript: {
						command: ["project-ts", "--flag"],
						extensions: [".ts", ".tsx"],
					},
				},
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.lspServers).toEqual({
			typescript: {
				command: ["project-ts", "--flag"],
				extensions: [".ts", ".tsx"],
			},
			python: { command: ["global-py"], extensions: [".py"] },
		});
	});

	it("drops a server disabled by the project over a global one", async () => {
		await writeGlobal({
			lsp: {
				servers: {
					typescript: { command: ["global-ts"], extensions: [".ts"] },
				},
			},
		});
		await writeProject({
			lsp: {
				servers: {
					typescript: {
						command: ["project-ts"],
						extensions: [".ts"],
						disabled: true,
					},
				},
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.lspServers).toEqual({});
	});

	it("rejects a bad server name with the literal error", async () => {
		await writeProject({
			lsp: {
				servers: { "bad name": { command: ["ts"], extensions: [".ts"] } },
			},
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid lsp in ${path.join(workspaceRoot, "my-agent.json")}: server name "bad name" is invalid. Use letters, digits, "_" and "-".`,
		);
	});

	it("rejects an empty command with the literal error", async () => {
		await writeProject({
			lsp: { servers: { typescript: { command: [], extensions: [".ts"] } } },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid lsp in ${path.join(workspaceRoot, "my-agent.json")}: server "typescript": "command" must be a non-empty array of strings.`,
		);
	});

	it("rejects empty extensions with the literal error", async () => {
		await writeProject({
			lsp: { servers: { typescript: { command: ["ts"], extensions: [] } } },
		});

		const result = resolveConfig({ workspaceRoot, env: {}, homeDir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(
			`Invalid lsp in ${path.join(workspaceRoot, "my-agent.json")}: server "typescript": "extensions" must be a non-empty array of strings.`,
		);
	});
});
