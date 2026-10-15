import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRobs } from "../../src/config/project-file.js";
import { globalConfigPath, resolveConfig } from "../../src/config/resolve.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;
let homeDir: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-backend-");
	homeDir = await makeWorkspace("my-agent-backend-home-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
	await removeWorkspace(homeDir);
});

const PI_BACKEND = {
	kind: "cli",
	command: "pi",
	provider: "deepseek",
	model: "deepseek-v4-flash",
};

describe("rob backend schema", () => {
	it("accepts a native backend and a valid pi cli backend", () => {
		const result = parseRobs([
			{ name: "planner", role: "plan", backend: { kind: "native" } },
			{
				name: "reviewer",
				role: "review",
				permissions: { read_file: "allow" },
				backend: { ...PI_BACKEND, sessionDir: "sessions/reviewer" },
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[1].backend).toEqual({
			...PI_BACKEND,
			sessionDir: "sessions/reviewer",
		});
	});

	it("accepts a cli rob that configures no tools", () => {
		const result = parseRobs([
			{ name: "reviewer", role: "review", backend: PI_BACKEND },
		]);

		expect(result.ok).toBe(true);
	});

	it("accepts delegate in a cli rob's permissions", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				permissions: { delegate: "allow" },
				backend: PI_BACKEND,
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[0].permissions).toEqual({ delegate: "allow" });
	});

	it("accepts send_message in a cli rob's permissions", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				permissions: { send_message: "allow", read_file: "allow" },
				backend: PI_BACKEND,
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[0].permissions).toEqual({
			send_message: "allow",
			read_file: "allow",
		});
	});

	it("rejects an unknown cli command with a friendly message", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				backend: { ...PI_BACKEND, command: "codex" },
			},
		]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('Unsupported CLI command "codex"');
		expect(result.error).toContain(
			'Only "pi", "opencode", and "claude" are supported',
		);
	});

	it("accepts an opencode cli backend with a provider and model", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				backend: {
					kind: "cli",
					command: "opencode",
					provider: "deepseek",
					model: "deepseek-v4-flash",
				},
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[0].backend).toEqual({
			kind: "cli",
			command: "opencode",
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
	});

	it("accepts an opencode cli backend without a provider or model", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				backend: { kind: "cli", command: "opencode" },
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[0].backend).toEqual({
			kind: "cli",
			command: "opencode",
		});
	});

	it("rejects a pi cli backend that omits provider or model", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				backend: { kind: "cli", command: "pi" },
			},
		]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(
			'A "pi" cli backend requires "provider" and "model"',
		);
	});

	it("accepts send_message in an opencode cli rob's permissions", () => {
		const result = parseRobs([
			{
				name: "reviewer",
				role: "review",
				permissions: { send_message: "allow", read_file: "allow" },
				backend: { kind: "cli", command: "opencode" },
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.robs[0].permissions).toEqual({
			send_message: "allow",
			read_file: "allow",
		});
	});

	it("rejects a global config that sets backend", async () => {
		const filePath = globalConfigPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify({ backend: PI_BACKEND }), "utf8");

		const result = resolveConfig({
			workspaceRoot: workspace,
			env: {},
			homeDir,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cannot set backend");
		expect(result.error).toContain(globalConfigPath(homeDir));
	});

	it("resolves a project file that carries a cli rob backend", async () => {
		await writeFile(
			path.join(workspace, "my-agent.json"),
			JSON.stringify({
				robs: [{ name: "reviewer", role: "review", backend: PI_BACKEND }],
			}),
			"utf8",
		);

		const result = resolveConfig({
			workspaceRoot: workspace,
			env: {},
			homeDir,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.robs[0].backend).toEqual(PI_BACKEND);
	});
});
