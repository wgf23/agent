import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { runHeadless } from "../../src/cli/run.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { PluginCommand } from "../../src/plugins/types.js";
import { App } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { createMockProvider } from "../helpers/mock-provider.js";

const FAKE_PLUGIN = fileURLToPath(
	new URL("../fixtures/fake-plugin.mjs", import.meta.url),
);

describe("runHeadless with plugins", () => {
	let sessionsDir: string;
	let workspaceRoot: string;
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-run-plugin-"));
		workspaceRoot = await mkdtemp(
			path.join(tmpdir(), "my-agent-run-plugin-ws-"),
		);
		process.env.MY_AGENT_SESSIONS_DIR = sessionsDir;
	});

	afterEach(async () => {
		if (originalSessionsDir === undefined) {
			delete process.env.MY_AGENT_SESSIONS_DIR;
		} else {
			process.env.MY_AGENT_SESSIONS_DIR = originalSessionsDir;
		}
		await rm(sessionsDir, { recursive: true, force: true });
		await rm(workspaceRoot, { recursive: true, force: true });
	});

	it("advertises the plugin tool in the tool list and runs it", async () => {
		await writeFile(
			path.join(workspaceRoot, "my-agent.json"),
			JSON.stringify({ plugins: [FAKE_PLUGIN] }),
			"utf8",
		);

		const provider = createMockProvider([
			[
				{ type: "tool_call", id: "call_1", name: "greet", args: {} },
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "greeted" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const code = await runHeadless({
			prompt: "greet",
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
			yesAll: true,
		});

		expect(code).toBe(0);
		expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
			"greet",
		);
		const toolMessage = provider.requests[1].messages.find(
			(message) => message.role === "tool",
		);
		expect(toolMessage).toEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "hello from fake-plugin",
			isError: false,
		});
	});

	it("delivers a tool error when a plugin tool throws at execute time", async () => {
		const plugin = path.join(workspaceRoot, "thrower.mjs");
		await writeFile(
			plugin,
			'export default { name: "thrower", tools: [{ name: "boom", description: "Boom", readOnly: true, execute() { throw new Error("boom"); } }] };\n',
			"utf8",
		);
		await writeFile(
			path.join(workspaceRoot, "my-agent.json"),
			JSON.stringify({ plugins: [plugin] }),
			"utf8",
		);

		const provider = createMockProvider([
			[
				{ type: "tool_call", id: "call_1", name: "boom", args: {} },
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "handled" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const code = await runHeadless({
			prompt: "boom",
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
			yesAll: true,
		});

		expect(code).toBe(0);
		const toolMessage = provider.requests[1].messages.find(
			(message) => message.role === "tool",
		);
		expect(toolMessage).toEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "boom failed: boom",
			isError: true,
		});
	});

	it("leaves the tool list unchanged with no plugins configured", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const code = await runHeadless({
			prompt: "hi",
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
		});

		expect(code).toBe(0);
		expect(provider.requests[0].tools.map((tool) => tool.name)).not.toContain(
			"greet",
		);
	});
});

describe("TUI plugin commands", () => {
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;
	let sessionsDir: string;
	let workspaceRoot: string;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-tui-plugin-"));
		workspaceRoot = await mkdtemp(
			path.join(tmpdir(), "my-agent-tui-plugin-ws-"),
		);
		process.env.MY_AGENT_SESSIONS_DIR = sessionsDir;
	});

	afterEach(async () => {
		if (originalSessionsDir === undefined) {
			delete process.env.MY_AGENT_SESSIONS_DIR;
		} else {
			process.env.MY_AGENT_SESSIONS_DIR = originalSessionsDir;
		}
		await rm(sessionsDir, { recursive: true, force: true });
		await rm(workspaceRoot, { recursive: true, force: true });
		cleanup();
	});

	it("expands a submitted plugin command into the prompt", async () => {
		const commands: PluginCommand[] = [
			{
				name: "greet",
				description: "Greet someone by name",
				body: "Say hello to $ARGUMENTS.",
			},
		];
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { stdin } = render(
			createElement(App, {
				provider,
				authorize: readOnlyAuthorize,
				approval: createApprovalBridge(),
				allowAll: createAllowAll(),
				model: "deepseek-flash",
				workspaceRoot,
				pluginCommands: commands,
			}),
		);

		stdin.write("/greet Ada");
		stdin.write("\r");
		const deadline = Date.now() + 4000;
		while (provider.requests.length === 0) {
			if (Date.now() > deadline) throw new Error("no provider request");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "Say hello to Ada.",
		});
	});
});
