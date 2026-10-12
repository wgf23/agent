import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost, formatCost } from "../../src/agent/cost.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { runHeadless } from "../../src/cli/run.js";
import { createMockProvider } from "../helpers/mock-provider.js";

describe("estimateCost", () => {
	it("prices known models per input, output, and cache-read tokens", () => {
		expect(
			estimateCost(
				{ inputTokens: 1_000_000, outputTokens: 0, cacheHitTokens: 0 },
				"deepseek-flash",
			),
		).toBe(0.15);
		expect(
			estimateCost(
				{ inputTokens: 0, outputTokens: 1_000_000, cacheHitTokens: 0 },
				"deepseek-flash",
			),
		).toBe(0.6);
		expect(
			estimateCost(
				{ inputTokens: 0, outputTokens: 0, cacheHitTokens: 1_000_000 },
				"deepseek-flash",
			),
		).toBe(0.003);
		expect(
			estimateCost(
				{ inputTokens: 1_000_000, outputTokens: 0, cacheHitTokens: 0 },
				"deepseek-v4-pro",
			),
		).toBe(0.66);
		expect(
			estimateCost(
				{ inputTokens: 0, outputTokens: 1_000_000, cacheHitTokens: 0 },
				"deepseek-v4-pro",
			),
		).toBe(1.98);
		expect(
			estimateCost(
				{ inputTokens: 0, outputTokens: 0, cacheHitTokens: 1_000_000 },
				"deepseek-v4-pro",
			),
		).toBe(0.022);
	});

	it("returns 0 for an unknown model", () => {
		expect(
			estimateCost(
				{
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
					cacheHitTokens: 1_000_000,
				},
				"gpt-4o-mini",
			),
		).toBe(0);
	});
});

describe("formatCost", () => {
	it("prints a dollar amount without trailing zeros", () => {
		expect(formatCost(0.00015)).toBe("$0.00015");
		expect(formatCost(0.15)).toBe("$0.15");
		expect(formatCost(0)).toBe("$0");
	});
});

describe("runHeadless max-cost budget", () => {
	let sessionsDir: string;
	let workspaceRoot: string;
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-cost-"));
		workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-cost-ws-"));
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

	it("stops with reason budget once the cost exceeds the cap", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const provider = createMockProvider([
				[
					{ type: "usage", inputTokens: 1000, outputTokens: 0 },
					{
						type: "tool_call",
						id: "call_1",
						name: "read_file",
						args: { path: "a.txt" },
					},
					{ type: "finish", reason: "tool_calls" },
				],
				[
					{ type: "text_delta", text: "done" },
					{ type: "finish", reason: "stop" },
				],
			]);
			const events: AgentEvent[] = [];

			const code = await runHeadless({
				prompt: "read a.txt",
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
				maxCost: 0.0001,
				onEvent: (event) => events.push(event),
			});

			expect(code).toBe(1);
			expect(events).toContainEqual({
				type: "done",
				reason: "budget",
				steps: 1,
			});
			expect(provider.requests).toHaveLength(1);
			expect(stderr).toHaveBeenCalledWith(
				"[usage] input=1000 output=0 cache_hit=0 cache_miss=0 reasoning=0 cost=$0.00015\n",
			);
		} finally {
			stderr.mockRestore();
		}
	});
});
