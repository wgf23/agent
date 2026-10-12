import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodeForReason, runHeadless } from "../../src/cli/run.js";
import { listSessions, loadSession } from "../../src/session/store.js";
import { createMockProvider } from "../helpers/mock-provider.js";

describe("exitCodeForReason", () => {
	it("maps finished to 0 and every other reason to 1", () => {
		expect(exitCodeForReason("finished")).toBe(0);
		expect(exitCodeForReason("max_steps")).toBe(1);
		expect(exitCodeForReason("aborted")).toBe(1);
		expect(exitCodeForReason("error")).toBe(1);
	});
});

describe("runHeadless", () => {
	const originalKey = process.env.DEEPSEEK_API_KEY;

	beforeEach(() => {
		delete process.env.DEEPSEEK_API_KEY;
	});

	afterEach(() => {
		if (originalKey === undefined) {
			delete process.env.DEEPSEEK_API_KEY;
		} else {
			process.env.DEEPSEEK_API_KEY = originalKey;
		}
	});

	it("returns 1 and prints the missing-key message without a key", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const code = await runHeadless({ prompt: "hi" });

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				'Missing DEEPSEEK_API_KEY. Run "my-agent setup" to store a key, or set the DEEPSEEK_API_KEY environment variable.',
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("runHeadless sessions", () => {
	let sessionsDir: string;
	let workspaceRoot: string;
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-run-"));
		workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-run-ws-"));
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

	async function runWith(
		provider: ReturnType<typeof createMockProvider>,
		options: { prompt: string; continueSession?: boolean; sessionId?: string },
	): Promise<number> {
		return runHeadless({
			...options,
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
		});
	}

	it("continues the latest session and sends the earlier history", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const first = createMockProvider([
				[
					{ type: "text_delta", text: "first answer" },
					{ type: "finish", reason: "stop" },
				],
			]);
			expect(await runWith(first, { prompt: "first question" })).toBe(0);

			const summaries = await listSessions(workspaceRoot);
			expect(summaries).toHaveLength(1);
			const sessionId = summaries[0].id;
			expect(sessionId).toMatch(/^ses_[0-9a-f]{32}$/);

			const second = createMockProvider([
				[
					{ type: "text_delta", text: "second answer" },
					{ type: "finish", reason: "stop" },
				],
			]);
			expect(
				await runWith(second, {
					prompt: "second question",
					continueSession: true,
				}),
			).toBe(0);

			expect(second.requests[0].messages).toContainEqual({
				role: "user",
				content: "first question",
			});

			const loaded = await loadSession(workspaceRoot, sessionId);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) return;
			expect(loaded.session.messages).toContainEqual({
				role: "user",
				content: "second question",
			});
			expect(loaded.session.messages).toContainEqual({
				role: "assistant",
				content: [{ type: "text", text: "second answer" }],
			});
			expect(loaded.session.usage).toEqual({ input: 0, output: 0 });
			expect(stderr).toHaveBeenCalledWith(`[session] ${sessionId}\n`);
		} finally {
			stderr.mockRestore();
		}
	});

	it("falls back to a new session when continue finds none", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const provider = createMockProvider([
				[
					{ type: "text_delta", text: "hi" },
					{ type: "finish", reason: "stop" },
				],
			]);
			expect(
				await runWith(provider, { prompt: "hello", continueSession: true }),
			).toBe(0);

			expect(await listSessions(workspaceRoot)).toHaveLength(1);
			const note = stderr.mock.calls
				.map((call) => String(call[0]))
				.find((line) => line.includes("starting a new one"));
			expect(note).toBe(
				"[session] no saved session for this workspace; starting a new one\n",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("errors on an unknown --session id without running the provider", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const provider = createMockProvider([]);
			const code = await runWith(provider, {
				prompt: "hi",
				sessionId: "ses_missing",
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Unknown session: ses_missing");
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("writes the compacted line to stderr when the history is over the threshold", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await writeFile(
				path.join(workspaceRoot, "my-agent.json"),
				JSON.stringify({
					compaction: { thresholdTokens: 1, keepRecentTokens: 1 },
				}),
				"utf8",
			);

			const first = createMockProvider([
				[
					{ type: "text_delta", text: "first answer" },
					{ type: "finish", reason: "stop" },
				],
			]);
			expect(await runWith(first, { prompt: "first question" })).toBe(0);

			const second = createMockProvider([
				[
					{ type: "text_delta", text: "SUMMARY" },
					{ type: "finish", reason: "stop" },
				],
				[
					{ type: "text_delta", text: "second answer" },
					{ type: "finish", reason: "stop" },
				],
			]);
			expect(
				await runWith(second, {
					prompt: "second question",
					continueSession: true,
				}),
			).toBe(0);

			expect(stderr).toHaveBeenCalledWith("· compacted 2 messages\n");
		} finally {
			stderr.mockRestore();
		}
	});
});
