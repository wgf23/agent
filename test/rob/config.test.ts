import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalConfigPath, resolveConfig } from "../../src/config/resolve.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-rob-home-"));
	workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-rob-ws-"));
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

function resolve() {
	return resolveConfig({ workspaceRoot, env: {}, homeDir });
}

describe("rob config", () => {
	it("rejects duplicate rob names with a friendly message", async () => {
		await writeProject({
			robs: [
				{ name: "planner", role: "a" },
				{ name: "planner", role: "b" },
			],
		});

		const result = resolve();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('Duplicate rob name "planner"');
		expect(result.error).toContain("Rob names must be unique");
	});

	it("rejects an invalid rob name", async () => {
		await writeProject({ robs: [{ name: "Planner One", role: "a" }] });

		const result = resolve();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(
			"Rob names must start with a lowercase letter",
		);
	});

	it("rejects a global config that sets robs", async () => {
		await writeGlobal({ robs: [{ name: "planner", role: "a" }] });

		const result = resolve();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cannot set robs");
		expect(result.error).toContain(globalConfigPath(homeDir));
	});

	it("resolves robs and defaults a missing model to the resolved model", async () => {
		await writeProject({
			robs: [
				{ name: "planner", role: "plan" },
				{ name: "worker", role: "work", model: "deepseek-v4-pro" },
			],
		});

		const result = resolve();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.robs).toEqual([
			{ name: "planner", role: "plan", model: "deepseek-flash" },
			{ name: "worker", role: "work", model: "deepseek-v4-pro" },
		]);
	});

	it("returns an empty robs array when none are configured", async () => {
		const result = resolve();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.robs).toEqual([]);
	});

	it("accepts a claude cli backend without a provider or model", async () => {
		await writeProject({
			robs: [
				{
					name: "reviewer",
					role: "review",
					backend: { kind: "cli", command: "claude" },
				},
			],
		});

		const result = resolve();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.robs).toEqual([
			{
				name: "reviewer",
				role: "review",
				model: "deepseek-flash",
				backend: { kind: "cli", command: "claude" },
			},
		]);
	});

	it("accepts a claude cli backend with an optional model", async () => {
		await writeProject({
			robs: [
				{
					name: "reviewer",
					role: "review",
					backend: { kind: "cli", command: "claude", model: "sonnet" },
				},
			],
		});

		const result = resolve();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.robs).toEqual([
			{
				name: "reviewer",
				role: "review",
				model: "deepseek-flash",
				backend: { kind: "cli", command: "claude", model: "sonnet" },
			},
		]);
	});
});
