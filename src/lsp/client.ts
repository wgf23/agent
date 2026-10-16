import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";

export interface LspDiagnostic {
	range: { start: { line: number; character: number } };
	severity?: number;
	message: string;
	source?: string;
	code?: unknown;
}

export interface LspClientOptions {
	name: string;
	command: string[];
	env?: Record<string, string>;
	initializationOptions?: Record<string, unknown>;
	workspaceRoot: string;
	timeoutMs?: number;
}

// A server lives in one of four states: idle until first use, starting while
// the initialize request is in flight, ready once initialized, or failed when
// the spawn, handshake, or an early exit goes wrong. The state is a single
// field, not scattered booleans, so every transition is visible in one place.
export type LspState = "idle" | "starting" | "ready" | "failed";

const DEFAULT_TIMEOUT_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const STDERR_TAIL_MAX = 2000;
const KILL_GRACE_MS = 200;
// A frame this large is never legitimate; reject it instead of buffering bytes
// until a body that size arrives (or never does).
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const diagnosticSchema = z.object({
	range: z.object({
		start: z.object({
			line: z.number().int().min(0),
			character: z.number().int().min(0),
		}),
	}),
	severity: z.number().int().optional(),
	message: z.string(),
	source: z.string().optional(),
	code: z.unknown().optional(),
});

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface Waiter {
	resolve: (diagnostics: LspDiagnostic[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

// A minimal JSON-RPC 2.0 client over a child process's stdin/stdout using LSP
// Content-Length framing. Requests are matched to responses by an incrementing
// id; a `textDocument/publishDiagnostics` notification resolves the waiter that
// opened that document.
export class StdioLspClient {
	readonly name: string;
	private readonly command: string[];
	private readonly env?: Record<string, string>;
	private readonly initializationOptions: Record<string, unknown>;
	private readonly workspaceRoot: string;
	private readonly timeoutMs: number;
	private state: LspState = "idle";
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<number, Pending>();
	private readonly waiters = new Map<string, Waiter[]>();
	// Per-uri open state: the version and last text sent to the server, so the
	// first request opens a document and later ones send an incremented change.
	private readonly documents = new Map<
		string,
		{ version: number; text: string }
	>();
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private stderrTail = "";
	private disposed = false;
	private startup: Promise<void> | null = null;

	constructor(options: LspClientOptions) {
		this.name = options.name;
		this.command = options.command;
		this.env = options.env;
		this.initializationOptions = options.initializationOptions ?? {};
		this.workspaceRoot = options.workspaceRoot;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	// Starts the server on first use and reuses it afterwards. Concurrent first
	// callers share one startup promise instead of racing two child processes.
	ensureStarted(): Promise<void> {
		if (this.state === "ready") return Promise.resolve();
		if (this.startup !== null) return this.startup;
		this.startup = this.start();
		return this.startup;
	}

	requestDiagnostics(
		uri: string,
		languageId: string,
		text: string,
		signal?: AbortSignal,
	): Promise<LspDiagnostic[]> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(this.wrap("aborted"));
				return;
			}
			const timer = setTimeout(() => {
				this.removeWaiter(uri, waiter);
				reject(this.wrap(`timed out waiting for diagnostics for ${uri}`));
			}, this.timeoutMs);
			const waiter: Waiter = { resolve, reject, timer };
			this.addWaiter(uri, waiter);
			if (signal !== undefined) {
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(waiter.timer);
						this.removeWaiter(uri, waiter);
						this.rejectAll(this.wrap("aborted"));
						reject(this.wrap("aborted"));
					},
					{ once: true },
				);
			}
			this.openOrChange(uri, languageId, text);
		});
	}

	private addWaiter(uri: string, waiter: Waiter): void {
		const list = this.waiters.get(uri);
		if (list === undefined) {
			this.waiters.set(uri, [waiter]);
		} else {
			list.push(waiter);
		}
	}

	private removeWaiter(uri: string, waiter: Waiter): void {
		const list = this.waiters.get(uri);
		if (list === undefined) return;
		const next = list.filter((entry) => entry !== waiter);
		if (next.length === 0) {
			this.waiters.delete(uri);
		} else {
			this.waiters.set(uri, next);
		}
	}

	private openOrChange(uri: string, languageId: string, text: string): void {
		const open = this.documents.get(uri);
		if (open === undefined) {
			this.documents.set(uri, { version: 1, text });
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			});
			return;
		}
		open.version += 1;
		open.text = text;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: open.version },
			contentChanges: [{ text }],
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectWaiters(this.wrap("client disposed"));
		const child = this.child;
		if (child === undefined) return;
		if (
			this.state === "ready" &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			for (const uri of this.documents.keys()) {
				this.notify("textDocument/didClose", {
					textDocument: { uri },
				});
			}
			this.documents.clear();
			try {
				await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
			} catch {
				// A server that ignores shutdown still gets exit and the kill.
			}
			this.notify("exit", null);
		}
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		const kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		await exited;
		clearTimeout(kill);
	}

	private async start(): Promise<void> {
		this.state = "starting";
		this.buffer = Buffer.alloc(0);
		this.documents.clear();
		this.child = spawn(this.command[0], this.command.slice(1), {
			cwd: this.workspaceRoot,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdin.on("error", () => {});
		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX);
		});
		this.child.on("error", (error) => {
			const wrapped = this.wrap(errorMessage(error));
			this.state = "failed";
			this.startup = null;
			this.rejectAll(wrapped);
			this.rejectWaiters(wrapped);
		});
		this.child.on("exit", (code, signal) => {
			const wrapped = this.wrap(
				this.withStderr(`server exited (${signal ?? code})`),
			);
			this.state = "failed";
			this.startup = null;
			this.rejectAll(wrapped);
			this.rejectWaiters(wrapped);
		});

		try {
			// typescript-language-server and other servers attach the project only
			// when the client advertises workspaceFolders; with only rootUri they
			// initialize cleanly but never publish diagnostics.
			const rootUri = pathToFileURL(this.workspaceRoot).toString();
			await this.request("initialize", {
				processId: process.pid,
				rootUri,
				workspaceFolders: [
					{ uri: rootUri, name: path.basename(this.workspaceRoot) },
				],
				capabilities: {
					workspace: { workspaceFolders: true },
					textDocument: { publishDiagnostics: { relatedInformation: true } },
				},
				initializationOptions: this.initializationOptions,
			});
		} catch (error) {
			this.state = "failed";
			this.startup = null;
			throw error;
		}
		this.notify("initialized", {});
		this.state = "ready";
	}

	private request(
		method: string,
		params: unknown,
		timeoutMs = this.timeoutMs,
	): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					this.wrap(
						this.withStderr(
							`request "${method}" timed out after ${timeoutMs}ms`,
						),
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: Record<string, unknown>): void {
		const child = this.child;
		if (child === undefined) return;
		if (child.exitCode !== null || child.signalCode !== null) return;
		const body = JSON.stringify(message);
		child.stdin.write(
			`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
		);
	}

	// Content-Length counts UTF-8 bytes, so the buffer stays a Buffer until a
	// complete frame is split off; decoding per frame keeps multi-byte text
	// intact while the byte offsets stay exact.
	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /^Content-Length: (-?\d+)$/im.exec(header);
			if (match === null) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_FRAME_BYTES
			) {
				this.failProtocol(`invalid Content-Length ${match[1]}`);
				return;
			}
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return;
			const body = this.buffer
				.subarray(bodyStart, bodyStart + length)
				.toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.handleMessage(body);
		}
	}

	private handleMessage(body: string): void {
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		if (typeof message.method === "string") {
			if (message.id !== undefined) {
				this.answer(message.id, message.method, message.params);
			} else if (message.method === "textDocument/publishDiagnostics") {
				this.onPublishDiagnostics(message.params);
			}
			return;
		}
		if (
			typeof message.id === "number" &&
			("result" in message || "error" in message)
		) {
			this.settle(message.id, message);
		}
	}

	private settle(id: number, message: Record<string, unknown>): void {
		const pending = this.pending.get(id);
		if (pending === undefined) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if ("error" in message) {
			pending.reject(
				this.wrap(`request failed: ${describeError(message.error)}`),
			);
			return;
		}
		pending.resolve(message.result);
	}

	private answer(id: unknown, method: string, params: unknown): void {
		// Some real servers request workspace/configuration during startup; a
		// -32601 there breaks them. Answer it with one null per requested item.
		if (method === "workspace/configuration") {
			const items =
				isRecord(params) && Array.isArray(params.items) ? params.items : [];
			this.write({
				jsonrpc: "2.0",
				id,
				result: items.map(() => null),
			});
			return;
		}
		this.write({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `Method not supported: ${method}` },
		});
	}

	private onPublishDiagnostics(params: unknown): void {
		if (!isRecord(params) || typeof params.uri !== "string") return;
		const waiters = this.waiters.get(params.uri);
		if (waiters === undefined) return;
		this.waiters.delete(params.uri);
		const diagnostics = parseDiagnostics(params.diagnostics);
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(diagnostics);
		}
	}

	private failProtocol(message: string): void {
		const error = this.wrap(message);
		this.state = "failed";
		this.startup = null;
		this.buffer = Buffer.alloc(0);
		this.rejectAll(error);
		this.rejectWaiters(error);
		this.child?.kill("SIGKILL");
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private rejectWaiters(error: Error): void {
		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		this.waiters.clear();
	}

	private wrap(message: string): Error {
		return new Error(`lsp ${this.name}: ${message}`);
	}

	private withStderr(message: string): string {
		const tail = this.stderrTail.trim();
		return tail === "" ? message : `${message}: ${tail}`;
	}
}

function parseDiagnostics(value: unknown): LspDiagnostic[] {
	if (!Array.isArray(value)) return [];
	const diagnostics: LspDiagnostic[] = [];
	for (const raw of value) {
		const parsed = diagnosticSchema.safeParse(raw);
		if (parsed.success) diagnostics.push(parsed.data);
	}
	return diagnostics;
}

function describeError(value: unknown): string {
	if (isRecord(value) && typeof value.message === "string") {
		return value.message;
	}
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
