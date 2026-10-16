import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodeForReason, runHeadless } from "../../src/cli/run.js";
import { listSessions, loadSession } from "../../src/session/store.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { FAKE_MCP_SERVER, isAlive } from "../mcp/helpers.js";

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

describe("runHeadless images", () => {
	let sessionsDir: string;
	let workspaceRoot: string;
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-run-img-"));
		workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-run-img-ws-"));
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

	it("sends the image part to the provider as an image content part", async () => {
		const imagePath = path.join(workspaceRoot, "shot.png");
		await writeFile(imagePath, "hello", "utf8");

		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "it is a png" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const code = await runHeadless({
			prompt: "what is this?",
			imagePaths: [imagePath],
			provider,
			workspaceRoot,
			env: { DEEPSEEK_API_KEY: "test-key" },
			homeDir: workspaceRoot,
		});

		expect(code).toBe(0);
		expect(provider.requests[0].messages).toContainEqual({
			role: "user",
			content: "what is this?",
			images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
		});
	});

	it("rejects an unsupported extension before calling the provider", async () => {
		const imagePath = path.join(workspaceRoot, "notes.txt");
		await writeFile(imagePath, "hello", "utf8");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const provider = createMockProvider([]);
			const code = await runHeadless({
				prompt: "hi",
				imagePaths: [imagePath],
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				`Unsupported image extension ".txt": ${imagePath}`,
			);
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects a missing file before calling the provider", async () => {
		const imagePath = path.join(workspaceRoot, "missing.png");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const provider = createMockProvider([]);
			const code = await runHeadless({
				prompt: "hi",
				imagePaths: [imagePath],
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				`Image file not found: ${imagePath}`,
			);
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects an oversized file before calling the provider", async () => {
		const imagePath = path.join(workspaceRoot, "huge.png");
		await writeFile(imagePath, Buffer.alloc(8 * 1024 * 1024 + 1), "utf8");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const provider = createMockProvider([]);
			const code = await runHeadless({
				prompt: "hi",
				imagePaths: [imagePath],
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				`Image file exceeds the 8 MiB limit: ${imagePath}`,
			);
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects more than 8 images before calling the provider", async () => {
		const imagePaths: string[] = [];
		for (let index = 0; index < 9; index += 1) {
			const imagePath = path.join(workspaceRoot, `shot${index}.png`);
			await writeFile(imagePath, "x", "utf8");
			imagePaths.push(imagePath);
		}
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const provider = createMockProvider([]);
			const code = await runHeadless({
				prompt: "hi",
				imagePaths,
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Too many images: 9 (limit 8)");
			expect(provider.requests).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("runHeadless with MCP servers", () => {
	let workspaceRoot: string;
	const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;
	let sessionsDir: string;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-run-mcp-"));
		workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-run-mcp-ws-"));
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

	it("connects a configured server, advertises its tool, and disposes it", async () => {
		const pidFile = path.join(workspaceRoot, "server.pid");
		await writeFile(
			path.join(workspaceRoot, "my-agent.json"),
			JSON.stringify({
				mcp: {
					servers: {
						memory: {
							command: [process.execPath, FAKE_MCP_SERVER],
							env: { FAKE_MCP_PID_FILE: pidFile },
						},
					},
				},
			}),
			"utf8",
		);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const provider = createMockProvider([
				[
					{
						type: "tool_call",
						id: "call_1",
						name: "mcp__memory__create_entity",
						args: { name: "Ada" },
					},
					{ type: "finish", reason: "tool_calls" },
				],
				[
					{ type: "text_delta", text: "created" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const code = await runHeadless({
				prompt: "create Ada",
				provider,
				workspaceRoot,
				env: { DEEPSEEK_API_KEY: "test-key" },
				homeDir: workspaceRoot,
				yesAll: true,
			});

			expect(code).toBe(0);
			expect(stderr).toHaveBeenCalledWith("[mcp] memory: 2 tools\n");
			const toolMessage = provider.requests[1].messages.find(
				(message) => message.role === "tool",
			);
			expect(toolMessage).toEqual({
				role: "tool",
				toolCallId: "call_1",
				content: 'create_entity:{"name":"Ada"}\nok',
				isError: false,
			});
		} finally {
			stderr.mockRestore();
		}
		// The run's finally disposed the client, so the server process is gone.
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		expect(isAlive(pid)).toBe(false);
	});
});
