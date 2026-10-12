import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInitCommand } from "../../src/cli/init.js";
import { createMockProvider } from "../helpers/mock-provider.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-init-home-"));
	workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-init-ws-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
	await rm(workspaceRoot, { recursive: true, force: true });
});

const agentsMdPath = (): string => path.join(workspaceRoot, "AGENTS.md");

function captureError(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("runInitCommand", () => {
	it("writes AGENTS.md from the stub text and prints the path", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "## Overview\n\n" },
				{ type: "text_delta", text: "A coding agent workspace.\n" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const code = await runInitCommand({
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir,
				provider,
			});

			expect(code).toBe(0);
			expect(await readFile(agentsMdPath(), "utf8")).toBe(
				"## Overview\n\nA coding agent workspace.\n",
			);
			expect(logSpy).toHaveBeenCalledWith(agentsMdPath());
		} finally {
			logSpy.mockRestore();
		}
	});

	it("refuses an existing AGENTS.md without --force and leaves it unchanged", async () => {
		await writeFile(agentsMdPath(), "existing content", "utf8");
		const provider = createMockProvider([]);
		const errorSpy = captureError();

		try {
			const code = await runInitCommand({
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir,
				provider,
			});

			expect(code).toBe(1);
			expect(await readFile(agentsMdPath(), "utf8")).toBe("existing content");
			expect(provider.requests).toHaveLength(0);
			expect(errorSpy).toHaveBeenCalledWith(
				`AGENTS.md already exists at ${agentsMdPath()}. Pass --force to overwrite it.`,
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("overwrites an existing AGENTS.md when --force is passed", async () => {
		await writeFile(agentsMdPath(), "existing content", "utf8");
		const provider = createMockProvider([
			[{ type: "text_delta", text: "fresh content" }],
		]);

		const code = await runInitCommand({
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir,
			provider,
			force: true,
		});

		expect(code).toBe(0);
		expect(await readFile(agentsMdPath(), "utf8")).toBe("fresh content");
	});

	it("exits non-zero with the friendly message and no provider call when the key is missing", async () => {
		const provider = createMockProvider([]);
		const errorSpy = captureError();

		try {
			const code = await runInitCommand({
				workspaceRoot,
				env: {},
				homeDir,
				provider,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				'Missing DEEPSEEK_API_KEY. Run "my-agent setup" to store a key, or set the DEEPSEEK_API_KEY environment variable.',
			);
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
