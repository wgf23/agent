import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/resolve.js";
import { matchingHooks, runHook } from "../../src/hooks/hooks.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeAll(async () => {
	workspace = await makeWorkspace("my-agent-hooks-");
});

afterAll(async () => {
	await removeWorkspace(workspace);
});

async function script(name: string, body: string): Promise<string> {
	const filePath = path.join(workspace, name);
	await writeFile(filePath, body, "utf8");
	await chmod(filePath, 0o755);
	return filePath;
}

describe("matchingHooks", () => {
	it("matches exact names and the * wildcard", () => {
		const entries = [
			{ match: "bash", command: "bash-hook" },
			{ match: "*", command: "all-hook" },
		];
		expect(
			matchingHooks(entries, "bash").map((entry) => entry.command),
		).toEqual(["bash-hook", "all-hook"]);
		expect(
			matchingHooks(entries, "read_file").map((entry) => entry.command),
		).toEqual(["all-hook"]);
	});

	it("matches a glob and excludes non-matching tools", () => {
		const entries = [{ match: "read_*", command: "reader" }];
		expect(
			matchingHooks(entries, "read_file").map((entry) => entry.command),
		).toEqual(["reader"]);
		expect(matchingHooks(entries, "write_file")).toEqual([]);
	});

	it("returns nothing when entries are undefined", () => {
		expect(matchingHooks(undefined, "bash")).toEqual([]);
	});
});

describe("runHook", () => {
	it("feeds the hook payload as JSON on stdin and returns the exit code", async () => {
		const filePath = await script("cat.sh", "#!/bin/sh\ncat\n");

		const outcome = await runHook(
			filePath,
			{ hook: "preToolUse", tool: "bash", args: { command: "ls -la" } },
			workspace,
		);

		expect(outcome).toEqual({
			kind: "exit",
			code: 0,
			stdout: '{"hook":"preToolUse","tool":"bash","args":{"command":"ls -la"}}',
			stderr: "",
		});
	});

	it("exposes the tool name as MY_AGENT_TOOL", async () => {
		const filePath = await script(
			"tool.sh",
			'#!/bin/sh\nprintf "%s" "$MY_AGENT_TOOL"\n',
		);

		const outcome = await runHook(
			filePath,
			{ hook: "postToolUse", tool: "grep", args: {} },
			workspace,
		);

		expect(outcome).toEqual({
			kind: "exit",
			code: 0,
			stdout: "grep",
			stderr: "",
		});
	});

	it("returns a non-zero exit code and its stdout", async () => {
		const filePath = await script(
			"fail.sh",
			"#!/bin/sh\nprintf 'denied reason'\nexit 3\n",
		);

		const outcome = await runHook(
			filePath,
			{ hook: "preToolUse", tool: "bash", args: {} },
			workspace,
		);

		expect(outcome).toEqual({
			kind: "exit",
			code: 3,
			stdout: "denied reason",
			stderr: "",
		});
	});
});

describe("resolveConfig hooks", () => {
	it("parses the hooks block from the project file", async () => {
		const homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-home-"));
		const ws = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-ws-"));
		try {
			await writeFile(
				path.join(ws, "my-agent.json"),
				JSON.stringify({
					hooks: {
						preToolUse: [{ match: "bash", command: "node scripts/check.mjs" }],
						postToolUse: [{ match: "*", command: "echo done" }],
					},
				}),
				"utf8",
			);

			const result = resolveConfig({ workspaceRoot: ws, env: {}, homeDir });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.config.hooks).toEqual({
				preToolUse: [{ match: "bash", command: "node scripts/check.mjs" }],
				postToolUse: [{ match: "*", command: "echo done" }],
			});
		} finally {
			await rm(ws, { recursive: true, force: true });
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("ignores hooks in the global file", async () => {
		const homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-home-"));
		const ws = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-ws-"));
		try {
			const globalDir = path.join(homeDir, ".config", "my-agent");
			await mkdir(globalDir, { recursive: true });
			await writeFile(
				path.join(globalDir, "config.json"),
				JSON.stringify({
					hooks: { preToolUse: [{ match: "bash", command: "echo nope" }] },
				}),
				"utf8",
			);

			const result = resolveConfig({ workspaceRoot: ws, env: {}, homeDir });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.config.hooks).toEqual({});
		} finally {
			await rm(ws, { recursive: true, force: true });
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid hooks block and names the file", async () => {
		const homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-home-"));
		const ws = await mkdtemp(path.join(tmpdir(), "my-agent-hooks-ws-"));
		try {
			await writeFile(
				path.join(ws, "my-agent.json"),
				JSON.stringify({ hooks: { preToolUse: [{ match: "bash" }] } }),
				"utf8",
			);

			const result = resolveConfig({ workspaceRoot: ws, env: {}, homeDir });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain("Invalid hooks");
			expect(result.error).toContain(path.join(ws, "my-agent.json"));
		} finally {
			await rm(ws, { recursive: true, force: true });
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});
