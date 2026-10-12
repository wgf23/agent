import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { errorMessage } from "../util/errors.js";

export interface McpClientOptions {
	name: string;
	command: string[];
	env?: Record<string, string>;
	workspaceRoot: string;
	timeoutMs?: number;
}

export interface McpClient {
	initialize(): Promise<void>;
	listTools(): Promise<unknown>;
	callTool(name: string, args: unknown): Promise<unknown>;
	dispose(): Promise<void>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "my-agent";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30000;
const STDERR_TAIL_MAX = 2000;
const KILL_GRACE_MS = 200;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

// A minimal JSON-RPC 2.0 client over a child process's stdin/stdout. Messages
// are newline-delimited; requests are matched to responses by an incrementing
// id. A request that gets no reply within the timeout fails with a message
// naming the server.
export class StdioMcpClient implements McpClient {
	readonly name: string;
	private readonly timeoutMs: number;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly ready: Promise<void>;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = "";
	private stderrTail = "";
	private disposed = false;

	constructor(options: McpClientOptions) {
		this.name = options.name;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.child = spawn(options.command[0], options.command.slice(1), {
			cwd: options.workspaceRoot,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.ready = new Promise<void>((resolve, reject) => {
			this.child.once("spawn", () => resolve());
			// A spawn failure (for example a missing binary) rejects the wait and
			// every in-flight request, so callers see the server's name.
			this.child.on("error", (error) => {
				const wrapped = this.wrap(errorMessage(error));
				reject(wrapped);
				this.rejectAll(wrapped);
			});
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX);
		});
		this.child.on("exit", (code, signal) => {
			this.rejectAll(
				this.wrap(this.withStderr(`server exited (${signal ?? code})`)),
			);
		});
	}

	async initialize(): Promise<void> {
		await this.ready;
		await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
		});
		this.notify("notifications/initialized", {});
	}

	listTools(): Promise<unknown> {
		return this.request("tools/list", {});
	}

	callTool(name: string, args: unknown): Promise<unknown> {
		return this.request("tools/call", { name, arguments: args });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectAll(this.wrap("client disposed"));
		const child = this.child;
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		const kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		await exited;
		clearTimeout(kill);
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (this.disposed) {
			return Promise.reject(this.wrap("client disposed"));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					this.wrap(
						this.withStderr(
							`request "${method}" timed out after ${this.timeoutMs}ms`,
						),
					),
				);
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: Record<string, unknown>): void {
		if (this.disposed) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.handleLine(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			// The server may log non-JSON to stdout; ignore it.
			return;
		}
		if (!isRecord(message)) return;
		if (
			typeof message.id === "number" &&
			("result" in message || "error" in message)
		) {
			this.settle(message.id, message);
			return;
		}
		// A message with a method and an id is a server-initiated request.
		if (typeof message.method === "string" && message.id !== undefined) {
			this.answer(message.id, message.method);
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

	private answer(id: unknown, method: string): void {
		if (method === "ping") {
			this.write({ jsonrpc: "2.0", id, result: {} });
			return;
		}
		this.write({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `Method not supported: ${method}` },
		});
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private wrap(message: string): Error {
		return new Error(`mcp ${this.name}: ${message}`);
	}

	private withStderr(message: string): string {
		const tail = this.stderrTail.trim();
		return tail === "" ? message : `${message}: ${tail}`;
	}
}

function describeError(value: unknown): string {
	if (isRecord(value) && typeof value.message === "string")
		return value.message;
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
