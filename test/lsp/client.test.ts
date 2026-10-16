import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type LspClientOptions, StdioLspClient } from "../../src/lsp/client.js";
import { FAKE_LSP_SERVER, isAlive, waitFor } from "./helpers.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "my-agent-lsp-client-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function serverOptions(
	name: string,
	extra: {
		scenario?: string;
		log?: string;
		pid?: string;
		timeoutMs?: number;
		env?: Record<string, string>;
	} = {},
): LspClientOptions {
	const env: Record<string, string> = { ...extra.env };
	if (extra.scenario !== undefined) env.FAKE_LSP_SCENARIO = extra.scenario;
	if (extra.log !== undefined) env.FAKE_LSP_LOG = extra.log;
	if (extra.pid !== undefined) env.FAKE_LSP_PID_FILE = extra.pid;
	return {
		name,
		command: [process.execPath, FAKE_LSP_SERVER],
		workspaceRoot: process.cwd(),
		timeoutMs: extra.timeoutMs,
		env,
	};
}

async function readLog(log: string): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(log, "utf8");
	return text
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("StdioLspClient", () => {
	it("speaks the framed protocol and resolves diagnostics by uri", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioLspClient(serverOptions("ts", { log }));
		try {
			await client.ensureStarted();
			const diagnostics = await client.requestDiagnostics(
				pathToFileURL("/tmp/example.ts").toString(),
				"ts",
				"const x = 1;\n",
			);

			const received = await readLog(log);
			expect(received[0]).toEqual({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					processId: expect.any(Number),
					rootUri: pathToFileURL(process.cwd()).toString(),
					workspaceFolders: [
						{
							uri: pathToFileURL(process.cwd()).toString(),
							name: path.basename(process.cwd()),
						},
					],
					capabilities: {
						workspace: { workspaceFolders: true },
						textDocument: {
							publishDiagnostics: { relatedInformation: true },
						},
					},
					initializationOptions: {},
				},
			});
			expect(received[1]).toEqual({
				jsonrpc: "2.0",
				method: "initialized",
				params: {},
			});
			expect(received[2]).toEqual({
				jsonrpc: "2.0",
				method: "textDocument/didOpen",
				params: {
					textDocument: {
						uri: pathToFileURL("/tmp/example.ts").toString(),
						languageId: "ts",
						version: 1,
						text: "const x = 1;\n",
					},
				},
			});

			expect(diagnostics).toEqual([
				{
					range: { start: { line: 0, character: 0 } },
					severity: 1,
					message: "Cannot find name 'x'.",
					source: "fake-lsp",
				},
				{
					range: { start: { line: 2, character: 4 } },
					severity: 2,
					message: "Unused variable 'y'.",
					source: "fake-lsp",
				},
			]);
		} finally {
			await client.dispose();
		}
	});

	it("frames multi-byte UTF-8 messages by byte length", async () => {
		const client = new StdioLspClient(
			serverOptions("ts", { env: { FAKE_LSP_MESSAGE: "名字未定义 'x'." } }),
		);
		try {
			await client.ensureStarted();
			const diagnostics = await client.requestDiagnostics(
				"file:///tmp/mb.ts",
				"ts",
				"// 注释\n",
			);
			expect(diagnostics[0].message).toBe("名字未定义 'x'.");
		} finally {
			await client.dispose();
		}
	});

	it("errors with the server name when diagnostics never arrive", async () => {
		const client = new StdioLspClient(
			serverOptions("sleepy", { scenario: "silent", timeoutMs: 500 }),
		);
		try {
			await client.ensureStarted();
			await expect(
				client.requestDiagnostics("file:///tmp/never.ts", "ts", ""),
			).rejects.toThrow(
				"lsp sleepy: timed out waiting for diagnostics for file:///tmp/never.ts",
			);
		} finally {
			await client.dispose();
		}
	});

	it("errors when the server exits before initializing", async () => {
		const client = new StdioLspClient(
			serverOptions("gone", { scenario: "exit-early" }),
		);
		await expect(client.ensureStarted()).rejects.toThrow(
			"lsp gone: server exited (1)",
		);
		await client.dispose();
	});

	it("kills the child on dispose", async () => {
		const dir = await tempDir();
		const pidFile = path.join(dir, "pid");
		const client = new StdioLspClient(serverOptions("ts", { pid: pidFile }));
		await client.ensureStarted();
		await waitFor(() => {
			expect(existsSync(pidFile)).toBe(true);
		});
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		expect(isAlive(pid)).toBe(true);

		await client.dispose();

		await waitFor(() => expect(isAlive(pid)).toBe(false));
	});

	it("restarts after the server exits while ready", async () => {
		const dir = await tempDir();
		const pidFile = path.join(dir, "pid");
		const client = new StdioLspClient(serverOptions("ts", { pid: pidFile }));
		try {
			await client.ensureStarted();
			await waitFor(() => {
				expect(existsSync(pidFile)).toBe(true);
			});
			const firstPid = Number((await readFile(pidFile, "utf8")).trim());
			expect(isAlive(firstPid)).toBe(true);

			process.kill(firstPid, "SIGKILL");
			await waitFor(() => expect(isAlive(firstPid)).toBe(false));

			// A fresh child (a new pid) is the observable effect of clearing the
			// stale startup promise after the crash.
			await waitFor(async () => {
				await client.ensureStarted();
				const pid = Number((await readFile(pidFile, "utf8")).trim());
				expect(pid).not.toBe(firstPid);
			});

			const diagnostics = await client.requestDiagnostics(
				pathToFileURL("/tmp/restart.ts").toString(),
				"ts",
				"const x = 1;\n",
			);
			expect(diagnostics[0].message).toBe("Cannot find name 'x'.");
		} finally {
			await client.dispose();
		}
	});

	it("resolves two concurrent requests for the same uri", async () => {
		const client = new StdioLspClient(serverOptions("ts", { timeoutMs: 1000 }));
		try {
			await client.ensureStarted();
			const uri = pathToFileURL("/tmp/same.ts").toString();
			const [a, b] = await Promise.all([
				client.requestDiagnostics(uri, "ts", "const x = 1;\n"),
				client.requestDiagnostics(uri, "ts", "const x = 1;\n"),
			]);
			expect(a).toEqual(b);
			expect(a[0].message).toBe("Cannot find name 'x'.");
		} finally {
			await client.dispose();
		}
	});

	it("sends didChange, not a second didOpen, for a reopened uri", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioLspClient(serverOptions("ts", { log }));
		try {
			await client.ensureStarted();
			const uri = pathToFileURL("/tmp/versioned.ts").toString();
			await client.requestDiagnostics(uri, "ts", "const a = 1;\n");
			await client.requestDiagnostics(uri, "ts", "const b = 2;\n");

			const received = await readLog(log);
			const methods = received.map((message) => message.method);
			expect(
				methods.filter((method) => method === "textDocument/didOpen"),
			).toHaveLength(1);
			const didChange = received.find(
				(message) => message.method === "textDocument/didChange",
			);
			expect(didChange?.params).toEqual({
				textDocument: { uri, version: 2 },
				contentChanges: [{ text: "const b = 2;\n" }],
			});
		} finally {
			await client.dispose();
		}
	});

	it("sends didClose for every open uri before shutdown", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioLspClient(serverOptions("ts", { log }));
		const uri = pathToFileURL("/tmp/close.ts").toString();
		await client.ensureStarted();
		await client.requestDiagnostics(uri, "ts", "const x = 1;\n");
		await client.dispose();

		const received = await readLog(log);
		const methods = received.map((message) => message.method);
		const closeIndex = methods.indexOf("textDocument/didClose");
		const shutdownIndex = methods.indexOf("shutdown");
		expect(closeIndex).toBeGreaterThan(-1);
		expect(shutdownIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeLessThan(shutdownIndex);
	});

	it("rejects promptly when aborted mid-wait", async () => {
		const controller = new AbortController();
		const client = new StdioLspClient(
			serverOptions("ts", { scenario: "silent", timeoutMs: 5000 }),
		);
		try {
			await client.ensureStarted();
			const pending = client.requestDiagnostics(
				"file:///tmp/abort.ts",
				"ts",
				"",
				controller.signal,
			);
			setTimeout(() => controller.abort(), 20);
			await expect(pending).rejects.toThrow("aborted");
		} finally {
			await client.dispose();
		}
	});

	it("answers workspace/configuration with an array of nulls", async () => {
		const dir = await tempDir();
		const log = path.join(dir, "log.jsonl");
		const client = new StdioLspClient(
			serverOptions("ts", { scenario: "configuration", log }),
		);
		try {
			await client.ensureStarted();
			await waitFor(async () => {
				const response = (await readLog(log)).find((entry) => entry.id === 42);
				expect(response?.result).toEqual([null, null]);
			});
		} finally {
			await client.dispose();
		}
	});

	it("rejects an absurd Content-Length instead of buffering", async () => {
		const client = new StdioLspClient(
			serverOptions("ts", { scenario: "oversized-frame", timeoutMs: 1000 }),
		);
		try {
			await client.ensureStarted();
			await expect(
				client.requestDiagnostics("file:///tmp/big.ts", "ts", ""),
			).rejects.toThrow("invalid Content-Length");
		} finally {
			await client.dispose();
		}
	});
});
