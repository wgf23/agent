import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../../src/cli/config.js";
import { writeCredential } from "../../src/config/credentials.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-config-home-"));
	workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-config-ws-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
	await rm(workspaceRoot, { recursive: true, force: true });
});

function capture(fn: () => number): { code: number; lines: string[] } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
		lines.push(String(line));
	});
	try {
		return { code: fn(), lines };
	} finally {
		spy.mockRestore();
	}
}

function apiKeyLine(lines: string[]): string {
	const line = lines.find((candidate) => candidate.startsWith("apiKey "));
	if (line === undefined) throw new Error("no apiKey row");
	return line;
}

describe("runConfigCommand apiKey label", () => {
	it("shows missing when neither source has a key", () => {
		const { lines } = capture(() =>
			runConfigCommand({ workspaceRoot, env: {}, homeDir }),
		);

		expect(apiKeyLine(lines)).toBe("apiKey     missing");
	});

	it("shows set (env) for an environment key", () => {
		const { lines } = capture(() =>
			runConfigCommand({
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "k" },
				homeDir,
			}),
		);

		expect(apiKeyLine(lines)).toBe("apiKey     set (env)");
	});

	it("shows set (credentials) for a stored key", async () => {
		await writeCredential(homeDir, "DEEPSEEK_API_KEY", "k");

		const { lines } = capture(() =>
			runConfigCommand({ workspaceRoot, env: {}, homeDir }),
		);

		expect(apiKeyLine(lines)).toBe("apiKey     set (credentials)");
	});
});
