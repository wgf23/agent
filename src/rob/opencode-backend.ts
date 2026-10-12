import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { UsageTotals } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { type PermissionRules, resolveAction } from "../permissions/rules.js";
import type { Message } from "../providers/types.js";
import { errorMessage } from "../util/errors.js";
import {
	emptyUsage,
	promptFor,
	type RobBackend,
	type TurnResult,
	toUserMessage,
} from "./backend.js";
import type { Inbound, RobName } from "./types.js";

const OPENCODE_COMMAND = "opencode";
const LISTEN_TIMEOUT_MS = 20000;
const INFO_TIMEOUT_MS = 20000;
const INTERJECT_POLL_MS = 250;
const ABORT_GRACE_MS = 1500;
const RECONNECT_MS = 250;
const SUMMARY_MAX_CHARS = 200;
const UI_OUTPUT_MAX_CHARS = 4000;

const LISTEN_PATTERN = /server listening on (http:\/\/\S+)/;

// Our tool to the permission action opencode gates it by. write_file and
// edit_file share the "edit" action.
const TOOL_PERMISSION_ACTIONS: ReadonlyArray<readonly [string, string]> = [
	["read_file", "read"],
	["glob", "glob"],
	["grep", "grep"],
	["write_file", "edit"],
	["edit_file", "edit"],
	["bash", "shell"],
];

// opencode's tool name to ours, for display in the event stream.
const OPENCODE_TOOL_NAMES = new Map<string, string>([
	["read", "read_file"],
	["write", "write_file"],
	["edit", "edit_file"],
	["shell", "bash"],
]);

export interface OpencodePermissionRule {
	action: string;
	resource: string;
	effect: "allow" | "deny" | "ask";
}

// opencode's default policy is allow-everything, so the ruleset starts from a
// total deny and only opens the tools this rob resolved to "allow". An "ask"
// tool has no approval channel in v1, so it stays denied and unavailable.
export function opencodePermissions(
	rules: PermissionRules,
): OpencodePermissionRule[] {
	const result: OpencodePermissionRule[] = [
		{ action: "*", resource: "*", effect: "deny" },
	];
	const allowed = new Set<string>();
	for (const [tool, action] of TOOL_PERMISSION_ACTIONS) {
		if (allowed.has(action)) continue;
		if (resolveAction(rules, tool, "*") === "allow") {
			result.push({ action, resource: "*", effect: "allow" });
			allowed.add(action);
		}
	}
	return result;
}

export interface OpencodeResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
	body?: ReadableStream<Uint8Array> | null;
}

export interface OpencodeRequestInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export type OpencodeFetch = (
	input: string,
	init?: OpencodeRequestInit,
) => Promise<OpencodeResponse>;

export interface OpencodeStream {
	setEncoding?(encoding: string): unknown;
	on(event: string, listener: (chunk: string) => void): unknown;
}

export interface OpencodeChild {
	stdout: OpencodeStream;
	stderr: OpencodeStream;
	on(event: string, listener: (value: unknown) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
	pid?: number;
}

export type OpencodeSpawn = (
	command: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		stdio: ["ignore", "pipe", "pipe"];
	},
) => OpencodeChild;

export interface OpencodeBackendOptions {
	rob: RobName;
	role: string;
	provider?: string;
	model?: string;
	rules: PermissionRules;
	drain: () => Inbound[];
	// Isolates the child's opencode data and state from the user's own opencode.
	dataDir?: string;
	// Env the child needs beyond process.env, such as the provider API key
	// stored by "my-agent setup". Never allowed to override OPENCODE_*.
	extraEnv?: Record<string, string>;
	spawn?: OpencodeSpawn;
	fetch?: OpencodeFetch;
	now?: () => number;
}

interface TurnState {
	messages: Message[];
	usage: UsageTotals;
	steps: number;
	lastText: string;
	aborted: boolean;
	settled: boolean;
	onEvent: (event: AgentEvent) => void;
	signal: AbortSignal;
	onAbort: () => void;
	poller: NodeJS.Timeout | null;
	abortTimer: NodeJS.Timeout | null;
	toolNames: Map<string, string>;
	deltaText: Map<string, string>;
	resolve: (result: TurnResult) => void;
}

export function createOpencodeBackend(
	options: OpencodeBackendOptions,
): RobBackend {
	const fetchFn = options.fetch ?? defaultFetch;
	const spawnFn = options.spawn ?? defaultSpawn;
	const now = options.now ?? Date.now;

	const password = randomPassword();
	const agentID = `myagent-${options.rob}`;
	// Each rob gets its own XDG tree so its sessions stay out of the user's
	// session list and never contend with the user's server for the SQLite DB.
	const dataDir =
		options.dataDir ??
		path.join(os.homedir(), ".config", "my-agent", "opencode", options.rob);
	const modelRef =
		options.provider !== undefined && options.model !== undefined
			? { providerID: options.provider, id: options.model }
			: undefined;
	const configContent = JSON.stringify({
		agents: {
			[agentID]: {
				description: `my-agent rob "${options.rob}"`,
				mode: "primary",
				system: options.role,
				permissions: opencodePermissions(options.rules),
			},
		},
	});

	let child: OpencodeChild | null = null;
	let baseUrl: string | null = null;
	let authHeader: string | null = null;
	let sessionID: string | null = null;
	let startPromise: Promise<void> | null = null;
	let disposed = false;
	let sseAbort: AbortController | null = null;
	let active: TurnState | null = null;
	let stderr = "";

	const request = (
		method: string,
		apiPath: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<OpencodeResponse> => {
		const headers: Record<string, string> = {
			authorization: authHeader ?? "",
		};
		const init: OpencodeRequestInit = { method, headers };
		if (body !== undefined) {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		if (signal !== undefined) init.signal = signal;
		return fetchFn(`${baseUrl}${apiPath}`, init);
	};

	const diagnostics = (): string => {
		const detail = stderr.trim();
		return detail === "" ? "" : `\n${capStderr(detail)}`;
	};

	const ensureStarted = (workspaceRoot: string): Promise<void> => {
		if (startPromise === null) {
			startPromise = start(workspaceRoot).catch((error: unknown) => {
				startPromise = null;
				throw error;
			});
		}
		return startPromise;
	};

	const start = async (workspaceRoot: string): Promise<void> => {
		child = spawnFn(
			OPENCODE_COMMAND,
			["serve", "--port", "0", "--hostname", "127.0.0.1"],
			{
				cwd: workspaceRoot,
				env: {
					...process.env,
					...options.extraEnv,
					XDG_DATA_HOME: dataDir,
					XDG_STATE_HOME: path.join(dataDir, "state"),
					OPENCODE_PASSWORD: password,
					OPENCODE_CONFIG_CONTENT: configContent,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stderr.setEncoding?.("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const url = await waitForListening();
		baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
		authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
		await waitForInfo();
		startEvents();
		// A server that dies mid-turn would otherwise leave the turn hanging.
		child.on("close", (code) => {
			if (disposed) return;
			if (active !== null && !active.settled) {
				complete(
					active,
					"error",
					`opencode serve exited unexpectedly (code ${String(code)}).`,
				);
			}
		});
	};

	const waitForListening = (): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			const deadline = now() + LISTEN_TIMEOUT_MS;
			let buffer = "";
			let settled = false;
			const finish = (action: () => void): void => {
				if (settled) return;
				settled = true;
				clearInterval(timer);
				action();
			};
			const timer = setInterval(() => {
				if (now() > deadline) {
					finish(() => reject(new Error(listenError())));
				}
			}, 100);
			timer.unref?.();

			const onData = (chunk: string): void => {
				buffer += chunk;
				const match = LISTEN_PATTERN.exec(buffer);
				if (match !== null) finish(() => resolve(match[1]));
			};

			child?.stdout.setEncoding?.("utf8");
			child?.stdout.on("data", onData);
			child?.on("error", (error) => finish(() => reject(asError(error))));
			child?.on("close", (code) =>
				finish(() =>
					reject(
						new Error(
							`opencode serve exited before it was ready (code ${String(code)}).${diagnostics()}`,
						),
					),
				),
			);
		});

	const listenError = (): string =>
		`opencode serve did not report a listening URL within ${LISTEN_TIMEOUT_MS}ms.${diagnostics()}`;

	const waitForInfo = async (): Promise<void> => {
		const deadline = now() + INFO_TIMEOUT_MS;
		for (;;) {
			try {
				const response = await request("GET", "/api/info");
				if (response.ok) return;
			} catch {
				// Not ready yet; keep polling until the deadline.
			}
			if (now() > deadline) {
				throw new Error(
					`opencode serve did not answer GET /api/info within ${INFO_TIMEOUT_MS}ms.${diagnostics()}`,
				);
			}
			await delay(200);
		}
	};

	const startEvents = (): void => {
		const controller = new AbortController();
		sseAbort = controller;
		void (async () => {
			while (!disposed && !controller.signal.aborted) {
				try {
					const response = await request(
						"GET",
						"/api/event",
						undefined,
						controller.signal,
					);
					if (
						!response.ok ||
						response.body === null ||
						response.body === undefined
					) {
						throw new Error("event stream unavailable");
					}
					await pumpEvents(response.body);
				} catch {
					if (disposed || controller.signal.aborted) return;
				}
				await delay(RECONNECT_MS);
			}
		})();
	};

	const pumpEvents = async (
		body: ReadableStream<Uint8Array>,
	): Promise<void> => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "") continue;
				let event: unknown;
				try {
					event = JSON.parse(payload);
				} catch {
					continue;
				}
				handleEvent(event);
			}
		}
	};

	const handleEvent = (raw: unknown): void => {
		if (!isRecord(raw)) return;
		const type = stringField(raw.type);
		const data = isRecord(raw.data) ? raw.data : {};
		const session = stringField(data.sessionID) || stringField(raw.sessionID);
		if (session === "" || session !== sessionID) return;
		const turn = active;
		if (turn === null || turn.settled) return;
		switch (type) {
			case "session.step.started":
				turn.steps += 1;
				return;
			case "session.step.ended":
				recordUsage(turn, data.tokens);
				return;
			case "session.text.delta":
				recordTextDelta(turn, data);
				return;
			case "session.text.ended":
				recordTextEnded(turn, data);
				return;
			case "session.reasoning.delta":
				emit(turn, { type: "reasoning_delta", text: stringField(data.delta) });
				return;
			case "session.tool.input.started":
				turn.toolNames.set(stringField(data.id), stringField(data.name));
				return;
			case "session.tool.called":
				emit(turn, {
					type: "tool_started",
					id: stringField(data.id),
					name: mapToolName(turn.toolNames.get(stringField(data.id)) ?? ""),
					args: data.input,
				});
				return;
			case "session.tool.success":
				recordToolFinished(turn, data, true);
				return;
			case "session.tool.failed":
				recordToolFinished(turn, data, false);
				return;
			case "session.execution.succeeded":
				complete(turn, "finished");
				return;
			case "session.execution.failed":
				complete(
					turn,
					"error",
					stringField(isRecord(data.error) ? data.error.message : ""),
				);
				return;
			case "session.execution.interrupted":
				complete(turn, "aborted");
				return;
			default:
				return;
		}
	};

	const recordUsage = (turn: TurnState, tokens: unknown): void => {
		if (!isRecord(tokens)) return;
		const cache = isRecord(tokens.cache) ? tokens.cache : {};
		const inputTokens = numberField(tokens.input);
		const outputTokens = numberField(tokens.output);
		const reasoningTokens = numberField(tokens.reasoning);
		const cacheHitTokens = numberField(cache.read);
		const cacheMissTokens = numberField(cache.write);
		turn.usage.inputTokens += inputTokens;
		turn.usage.outputTokens += outputTokens;
		turn.usage.cacheHitTokens += cacheHitTokens;
		turn.usage.cacheMissTokens += cacheMissTokens;
		turn.usage.reasoningTokens += reasoningTokens;
		emit(turn, {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheHitTokens,
			cacheMissTokens,
			reasoningTokens,
		});
	};

	const recordTextDelta = (
		turn: TurnState,
		data: Record<string, unknown>,
	): void => {
		const delta = stringField(data.delta);
		if (delta === "") return;
		const id = stringField(data.assistantMessageID);
		turn.deltaText.set(id, (turn.deltaText.get(id) ?? "") + delta);
		emit(turn, { type: "text_delta", text: delta });
	};

	const recordTextEnded = (
		turn: TurnState,
		data: Record<string, unknown>,
	): void => {
		const text = stringField(data.text);
		if (text === "") return;
		const id = stringField(data.assistantMessageID);
		const streamed = turn.deltaText.get(id) ?? "";
		// text.ended carries the full part; emit only what streaming did not.
		const rest = text.startsWith(streamed) ? text.slice(streamed.length) : text;
		if (rest !== "") emit(turn, { type: "text_delta", text: rest });
		turn.deltaText.set(id, text);
		turn.lastText = text;
	};

	const recordToolFinished = (
		turn: TurnState,
		data: Record<string, unknown>,
		ok: boolean,
	): void => {
		const error = isRecord(data.error) ? stringField(data.error.message) : "";
		const text = ok
			? contentText(data.content)
			: error || contentText(data.content);
		emit(turn, {
			type: "tool_finished",
			id: stringField(data.id),
			name: mapToolName(turn.toolNames.get(stringField(data.id)) ?? ""),
			ok,
			status: ok ? "ok" : "error",
			summary: summarize(text),
			output: capOutput(text),
		});
	};

	const emit = (turn: TurnState, event: AgentEvent): void => {
		turn.onEvent(event);
	};

	const complete = (
		turn: TurnState,
		kind: "finished" | "aborted" | "error",
		failure?: string,
	): void => {
		if (turn.settled) return;
		turn.settled = true;
		if (turn.poller !== null) clearInterval(turn.poller);
		if (turn.abortTimer !== null) clearTimeout(turn.abortTimer);
		turn.signal.removeEventListener("abort", turn.onAbort);
		if (active === turn) active = null;

		if (kind === "finished") {
			if (turn.lastText !== "") {
				turn.messages.push({
					role: "assistant",
					content: [{ type: "text", text: turn.lastText }],
				});
			}
			emit(turn, { type: "done", reason: "finished", steps: turn.steps });
			turn.resolve({
				ok: true,
				text: turn.lastText,
				usage: turn.usage,
				messages: turn.messages,
			});
			return;
		}
		if (kind === "aborted") {
			emit(turn, { type: "done", reason: "aborted", steps: turn.steps });
			turn.resolve({
				ok: false,
				error: "Turn aborted.",
				usage: turn.usage,
				messages: turn.messages,
			});
			return;
		}
		const message =
			failure !== undefined && failure !== ""
				? failure
				: "opencode turn failed.";
		emit(turn, { type: "error", message });
		emit(turn, { type: "done", reason: "error", steps: turn.steps });
		turn.resolve({
			ok: false,
			error: message,
			usage: turn.usage,
			messages: turn.messages,
		});
	};

	const ensureSession = async (): Promise<void> => {
		if (sessionID !== null) return;
		const body: Record<string, unknown> = { agent: agentID };
		if (modelRef !== undefined) body.model = modelRef;
		const response = await request("POST", "/api/session", body);
		if (!response.ok) {
			throw new Error(
				`opencode session creation failed (${response.status}): ${await safeText(response)}`,
			);
		}
		const json = await response.json();
		const id =
			isRecord(json) && isRecord(json.data) ? stringField(json.data.id) : "";
		if (id === "") {
			throw new Error("opencode session creation returned no session id.");
		}
		sessionID = id;
	};

	const postSteer = async (turn: TurnState, text: string): Promise<void> => {
		if (sessionID === null || turn.settled) return;
		try {
			await request("POST", `/api/session/${sessionID}/prompt`, {
				text,
				delivery: "steer",
			});
		} catch {
			// The turn's own completion or abort path reports failures; a dropped
			// steer here must not reject an otherwise finished run.
		}
	};

	const abort = (turn: TurnState): void => {
		if (turn.settled || turn.aborted) return;
		turn.aborted = true;
		if (sessionID !== null) {
			void request("POST", `/api/session/${sessionID}/interrupt`).catch(
				() => undefined,
			);
		}
		// If the interrupt produces no execution.interrupted event, end anyway.
		turn.abortTimer = setTimeout(
			() => complete(turn, "aborted"),
			ABORT_GRACE_MS,
		);
		turn.abortTimer.unref?.();
	};

	return {
		async run(turn) {
			const state: TurnState = {
				messages: [...turn.history, ...turn.inbound.map(toUserMessage)],
				usage: emptyUsage(),
				steps: 0,
				lastText: "",
				aborted: false,
				settled: false,
				onEvent: turn.onEvent,
				signal: turn.signal,
				onAbort: () => abort(state),
				poller: null,
				abortTimer: null,
				toolNames: new Map(),
				deltaText: new Map(),
				resolve: () => undefined,
			};
			const result = new Promise<TurnResult>((resolve) => {
				state.resolve = resolve;
			});
			active = state;

			try {
				await ensureStarted(turn.workspaceRoot);
				await ensureSession();
				const text = turn.inbound.map(promptFor).join("\n\n");
				let response = await request(
					"POST",
					`/api/session/${sessionID}/prompt`,
					{ text },
				);
				if (response.status === 404) {
					sessionID = null;
					await ensureSession();
					response = await request("POST", `/api/session/${sessionID}/prompt`, {
						text,
					});
				}
				if (!response.ok) {
					complete(
						state,
						"error",
						`opencode rejected the prompt (${response.status}): ${await safeText(response)}`,
					);
					return result;
				}
			} catch (error) {
				complete(state, "error", errorMessage(error));
				return result;
			}

			state.poller = setInterval(() => {
				if (state.settled || disposed) return;
				for (const item of options.drain()) {
					void postSteer(state, promptFor(item));
				}
			}, INTERJECT_POLL_MS);
			state.poller.unref?.();
			state.signal.addEventListener("abort", state.onAbort, { once: true });
			if (state.signal.aborted) state.onAbort();
			return result;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			sseAbort?.abort();
			sseAbort = null;
			// Resolve any in-flight turn so a caller awaiting run() (Team.stop)
			// is not left hanging when the timer that would end it is cleared.
			if (active !== null && !active.settled) {
				complete(active, "aborted");
			}
			if (child !== null) {
				try {
					child.kill("SIGTERM");
				} catch {
					// Best-effort teardown; the process may already be gone.
				}
			}
			child = null;
		},
	};
}

function defaultFetch(
	input: string,
	init?: OpencodeRequestInit,
): Promise<OpencodeResponse> {
	return fetch(input, init) as unknown as Promise<OpencodeResponse>;
}

function defaultSpawn(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		stdio: ["ignore", "pipe", "pipe"];
	},
): OpencodeChild {
	return spawn(command, args, options) as unknown as OpencodeChild;
}

function randomPassword(): string {
	return randomBytes(24).toString("hex");
}

function mapToolName(opencodeName: string): string {
	return OPENCODE_TOOL_NAMES.get(opencodeName) ?? opencodeName;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function summarize(text: string): string {
	const firstLine = text.split("\n")[0] ?? "";
	return firstLine.length > SUMMARY_MAX_CHARS
		? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}...`
		: firstLine;
}

function capOutput(text: string): string {
	return text.length > UI_OUTPUT_MAX_CHARS
		? `${text.slice(0, UI_OUTPUT_MAX_CHARS)}[truncated]`
		: text;
}

function capStderr(text: string): string {
	return text.length > 1000 ? text.slice(0, 1000) : text;
}

async function safeText(response: OpencodeResponse): Promise<string> {
	try {
		const text = await response.text();
		return text.length > 500 ? text.slice(0, 500) : text;
	} catch {
		return "";
	}
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
