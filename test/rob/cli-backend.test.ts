import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Authorize } from "../../src/agent/authorize.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { PermissionRules } from "../../src/permissions/rules.js";
import type { TurnResult } from "../../src/rob/backend.js";
import {
	createCliBackend,
	defaultSessionDir,
	piToolAllowlist,
} from "../../src/rob/cli-backend.js";
import type { Inbound } from "../../src/rob/types.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-pi.mjs", import.meta.url),
);

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-cli-backend-");
	await chmod(FIXTURE, 0o755);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	delete process.env.FAKE_PI_SCENARIO;
	delete process.env.FAKE_PI_ARGV_FILE;
	delete process.env.FAKE_PI_PID_FILE;
	delete process.env.FAKE_PI_STEER_FILE;
});

describe("piToolAllowlist", () => {
	it("maps an allow for every mapped tool in pi's own order", () => {
		expect(
			piToolAllowlist({
				read_file: "allow",
				write_file: "allow",
				edit_file: "allow",
				bash: "allow",
			}),
		).toEqual(["read", "write", "edit", "bash"]);
	});

	it("includes only read when the others resolve to ask or deny", () => {
		expect(
			piToolAllowlist({
				read_file: "allow",
				write_file: "ask",
				edit_file: "ask",
				bash: "deny",
			}),
		).toEqual(["read"]);
	});

	it("adds ask tools only when the approval bridge is enabled", () => {
		const rules: PermissionRules = {
			read_file: "allow",
			write_file: "ask",
			edit_file: "deny",
			bash: "ask",
		};
		expect(piToolAllowlist(rules)).toEqual(["read"]);
		expect(piToolAllowlist(rules, true)).toEqual(["read", "write", "bash"]);
	});

	it("returns nothing when every mapped tool is denied", () => {
		expect(
			piToolAllowlist({
				read_file: "deny",
				write_file: "deny",
				edit_file: "deny",
				bash: "deny",
			}),
		).toEqual([]);
	});
});

describe("cli backend", () => {
	it("parses a pi rpc stream into ordered agent events and a final answer", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_PI_ARGV_FILE = argvFile;

		const { result, events } = await runTurn({
			rules: { read_file: "allow", write_file: "allow" },
		});

		expect(events).toEqual([
			{
				type: "usage",
				inputTokens: 100,
				outputTokens: 20,
				cacheHitTokens: 5,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			{
				type: "tool_started",
				id: "call_1",
				name: "read_file",
				args: { path: "a.txt" },
			},
			{
				type: "tool_finished",
				id: "call_1",
				name: "read_file",
				ok: true,
				status: "ok",
				summary: `${"A".repeat(200)}...`,
				output: `${"A".repeat(4000)}[truncated]`,
			},
			{
				type: "usage",
				inputTokens: 50,
				outputTokens: 10,
				cacheHitTokens: 2,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			{ type: "text_delta", text: "The final answer." },
			{ type: "done", reason: "finished", steps: 2 },
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("The final answer.");
		expect(result.usage).toEqual({
			inputTokens: 150,
			outputTokens: 30,
			cacheHitTokens: 7,
			cacheMissTokens: 0,
			reasoningTokens: 0,
		});
		expect(result.messages).toEqual([
			{ role: "user", content: "[from user] hello" },
			{
				role: "assistant",
				content: [{ type: "text", text: "The final answer." }],
			},
		]);

		const sessionDir = defaultSessionDir(workspace, "reviewer");
		expect(await stat(sessionDir)).toBeDefined();
		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		expect(argv).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-flash",
			"--append-system-prompt",
			"review code",
			"--session-dir",
			sessionDir,
			"--continue",
			"--tools",
			"read,write",
		]);
	});

	it("passes --no-tools when nothing is allowed and keeps the prompt off argv", async () => {
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_PI_ARGV_FILE = argvFile;

		await runTurn({
			rules: {
				read_file: "deny",
				write_file: "deny",
				edit_file: "deny",
				bash: "deny",
			},
			inbound: [{ kind: "user", from: "user", text: "hello; rm -rf /", at: 0 }],
		});

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		expect(argv).toContain("--no-tools");
		expect(argv).not.toContain("--tools");
		expect(argv).not.toContain("[from user] hello; rm -rf /");
	});

	it("returns an error result with the captured stderr on a non-zero exit", async () => {
		process.env.FAKE_PI_SCENARIO = "error";

		const { result, events } = await runTurn({ rules: { read_file: "allow" } });

		expect(events).toEqual([
			{ type: "error", message: "boom: fake pi failed" },
			{ type: "done", reason: "error", steps: 0 },
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("boom: fake pi failed");
	});

	it("streams one text_delta per message_update delta in order", async () => {
		process.env.FAKE_PI_SCENARIO = "stream";

		const { result, events } = await runTurn({ rules: { read_file: "allow" } });

		const deltas = events.filter((event) => event.type === "text_delta");
		expect(deltas).toEqual([
			{ type: "text_delta", text: "The " },
			{ type: "text_delta", text: "final " },
			{ type: "text_delta", text: "answer." },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("The final answer.");
		expect(result.messages.at(-1)).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "The final answer." }],
		});
	});

	it("returns an error result when an assistant message stops with error", async () => {
		process.env.FAKE_PI_SCENARIO = "model-error";

		const { result, events } = await runTurn({ rules: {} });

		expect(events).toEqual([
			{
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheHitTokens: 0,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			{ type: "error", message: "model exploded" },
			{ type: "done", reason: "error", steps: 1 },
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("model exploded");
	});

	it("steers a queued interjection into the running turn", async () => {
		process.env.FAKE_PI_SCENARIO = "interjection";
		const steerFile = path.join(workspace, "steers.txt");
		process.env.FAKE_PI_STEER_FILE = steerFile;

		let queued: Inbound[] = [];
		let steered = false;
		const events: AgentEvent[] = [];
		const backend = createCliBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			drain: () => {
				const items = queued;
				queued = [];
				return items;
			},
		});
		const running = backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "long task", at: 0 }],
			workspaceRoot: workspace,
			rules: {},
			signal: new AbortController().signal,
			onEvent: (event) => {
				events.push(event);
				if (!steered && event.type === "tool_started") {
					steered = true;
					queued = [
						{ kind: "user", from: "user", text: "actually stop", at: 1 },
					];
				}
			},
		});

		const result = await running;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("STEERED");
		expect(events.filter((event) => event.type === "text_delta")).toEqual([
			{ type: "text_delta", text: "STEERED" },
		]);
		expect(await readFile(steerFile, "utf8")).toContain(
			"[from user] actually stop",
		);
	});

	it("routes a pi tool call through the approval bridge and allows it", async () => {
		process.env.FAKE_PI_SCENARIO = "approval";
		const argvFile = path.join(workspace, "argv.json");
		process.env.FAKE_PI_ARGV_FILE = argvFile;

		const { result, events } = await runTurn({
			rules: { bash: "ask" },
			authorize: allowAuthorize,
		});

		expect(result.ok).toBe(true);
		expect(
			events.find((event) => event.type === "tool_finished"),
		).toMatchObject({
			name: "bash",
			ok: true,
			status: "ok",
		});

		const argv = JSON.parse(await readFile(argvFile, "utf8"));
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,write,edit,bash");
		expect(argv).toContain("--extension");
		const extensionFile = argv[argv.indexOf("--extension") + 1];
		expect(await stat(extensionFile)).toBeDefined();
	});

	it("blocks a pi tool call when the approval bridge denies it", async () => {
		process.env.FAKE_PI_SCENARIO = "approval";

		const { result, events } = await runTurn({
			rules: { bash: "ask" },
			authorize: async () => ({ allowed: false, reason: "nope" }),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("blocked");
		expect(
			events.find((event) => event.type === "tool_finished"),
		).toMatchObject({
			name: "bash",
			ok: false,
			status: "error",
		});
	});

	it("kills the child on abort and ends the turn as aborted", async () => {
		const pidFile = path.join(workspace, "pid.txt");
		process.env.FAKE_PI_SCENARIO = "sleep";
		process.env.FAKE_PI_PID_FILE = pidFile;

		const events: AgentEvent[] = [];
		const controller = new AbortController();
		const backend = createCliBackend({
			rob: "reviewer",
			role: "review code",
			command: FIXTURE,
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		const running = backend.run({
			history: [],
			inbound: [{ kind: "user", from: "user", text: "sleep", at: 0 }],
			workspaceRoot: workspace,
			rules: { read_file: "allow" },
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		await waitForFile(pidFile);
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort();

		const result = await running;
		expect(events).toEqual([{ type: "done", reason: "aborted", steps: 0 }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("Turn aborted.");

		await waitFor(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, "the child process to exit");
	});
});

const allowAuthorize: Authorize = async () => ({ allowed: true });

async function runTurn(options: {
	rules?: PermissionRules;
	inbound?: Inbound[];
	authorize?: Authorize;
	drain?: () => Inbound[];
}): Promise<{ result: TurnResult; events: AgentEvent[] }> {
	const events: AgentEvent[] = [];
	const backend = createCliBackend({
		rob: "reviewer",
		role: "review code",
		command: FIXTURE,
		provider: "deepseek",
		model: "deepseek-v4-flash",
		authorize: options.authorize,
		drain: options.drain,
	});
	const result = await backend.run({
		history: [],
		inbound: options.inbound ?? [
			{ kind: "user", from: "user", text: "hello", at: 0 },
		],
		workspaceRoot: workspace,
		rules: options.rules ?? {},
		signal: new AbortController().signal,
		onEvent: (event) => events.push(event),
	});
	return { result, events };
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await readFile(file, "utf8");
			return;
		} catch {
			if (Date.now() > deadline)
				throw new Error(`Timed out waiting for ${file}`);
			await sleep(10);
		}
	}
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
