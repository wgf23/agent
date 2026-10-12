import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { PermissionRules } from "../../src/permissions/rules.js";
import type { Message } from "../../src/providers/types.js";
import {
	createOpencodeBackend,
	type OpencodeBackendOptions,
	type OpencodeChild,
	type OpencodeFetch,
	type OpencodeResponse,
	type OpencodeSpawn,
	type OpencodeStream,
	opencodePermissions,
} from "../../src/rob/opencode-backend.js";
import type { Inbound } from "../../src/rob/types.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const SESSION = "ses_1";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-opencode-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("opencodePermissions", () => {
	it("denies everything and opens only the tools resolved to allow", () => {
		expect(
			opencodePermissions({
				read_file: "allow",
				glob: "allow",
				grep: "allow",
				write_file: "allow",
				edit_file: "allow",
				bash: "allow",
			}),
		).toEqual([
			{ action: "*", resource: "*", effect: "deny" },
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "glob", resource: "*", effect: "allow" },
			{ action: "grep", resource: "*", effect: "allow" },
			{ action: "edit", resource: "*", effect: "allow" },
			{ action: "shell", resource: "*", effect: "allow" },
		]);
	});

	it("keeps write and edit behind a single edit allow", () => {
		expect(
			opencodePermissions({
				read_file: "allow",
				glob: "deny",
				grep: "deny",
				write_file: "allow",
				edit_file: "deny",
				bash: "deny",
			}),
		).toEqual([
			{ action: "*", resource: "*", effect: "deny" },
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "edit", resource: "*", effect: "allow" },
		]);
	});

	it("stays a total deny when nothing is allowed", () => {
		expect(
			opencodePermissions({
				read_file: "ask",
				glob: "deny",
				grep: "deny",
				write_file: "ask",
				edit_file: "ask",
				bash: "deny",
			}),
		).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
	});
});

interface Probes {
	spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
	sessions: Array<Record<string, unknown>>;
	prompts: Array<{ sessionID: string; body: Record<string, unknown> }>;
	interrupts: string[];
	killed: string[];
	sendEvent(event: Record<string, unknown>): void;
	eventsReady: Promise<void>;
	failNextPrompt404(): void;
	closeChild(code?: number): void;
	spawn: OpencodeSpawn;
	fetch: OpencodeFetch;
}

function makeProbes(): Probes {
	const spawned: Probes["spawned"] = [];
	const sessions: Probes["sessions"] = [];
	const prompts: Probes["prompts"] = [];
	const interrupts: Probes["interrupts"] = [];
	const killed: Probes["killed"] = [];
	let sessionSeq = 0;
	let promptFails404 = false;

	let send: (chunk: string) => void = () => undefined;
	let resolveReady: () => void = () => undefined;
	const eventsReady = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	const stdout = makeStream();
	const stderr = makeStream();
	const closeListeners: Array<(value: unknown) => void> = [];
	const child: OpencodeChild = {
		stdout,
		stderr,
		on(event, listener) {
			if (event === "close") closeListeners.push(listener);
			return this;
		},
		kill(signal) {
			killed.push(signal ?? "SIGTERM");
			for (const listener of closeListeners) listener(0);
			return true;
		},
		pid: 4242,
	};

	const spawn: OpencodeSpawn = (command, args, spawnOptions) => {
		spawned.push({ command, args, env: spawnOptions.env });
		setTimeout(() => {
			stdout.emitData("server listening on http://127.0.0.1:45678\n");
		}, 0);
		return child;
	};

	const fetch: OpencodeFetch = async (input, init) => {
		const path = new URL(input).pathname;
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string"
				? (JSON.parse(init.body) as Record<string, unknown>)
				: {};

		if (path === "/api/info") return json({ version: "test" });
		if (path === "/api/event") {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					send = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
					resolveReady();
				},
			});
			return {
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "",
				body: stream,
			};
		}
		if (path === "/api/session" && method === "POST") {
			sessions.push(body);
			sessionSeq += 1;
			return json({ data: { id: `ses_${sessionSeq}` } });
		}
		const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
		if (promptMatch !== null && method === "POST") {
			if (promptFails404) {
				promptFails404 = false;
				return json({ message: "gone" }, 404);
			}
			prompts.push({ sessionID: promptMatch[1], body });
			return json({ data: {} });
		}
		const interruptMatch = /^\/api\/session\/([^/]+)\/interrupt$/.exec(path);
		if (interruptMatch !== null && method === "POST") {
			interrupts.push(interruptMatch[1]);
			return {
				ok: true,
				status: 204,
				json: async () => ({}),
				text: async () => "",
			};
		}
		return json({ message: `unhandled ${method} ${path}` }, 500);
	};

	return {
		spawned,
		sessions,
		prompts,
		interrupts,
		killed,
		sendEvent: (event) => send(`data: ${JSON.stringify(event)}\n\n`),
		eventsReady,
		failNextPrompt404: () => {
			promptFails404 = true;
		},
		closeChild: (code = 1) => {
			for (const listener of closeListeners) listener(code);
		},
		spawn,
		fetch,
	};
}

function createHarness(
	options: Partial<Omit<OpencodeBackendOptions, "rob" | "role">> = {},
): { backend: ReturnType<typeof createOpencodeBackend>; probes: Probes } {
	const probes = makeProbes();
	const backend = createOpencodeBackend({
		rob: "reviewer",
		role: "review code",
		rules: {},
		drain: () => [],
		...options,
		spawn: probes.spawn,
		fetch: probes.fetch,
	});
	return { backend, probes };
}

function json(value: unknown, status = 200): OpencodeResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => value,
		text: async () => JSON.stringify(value),
	};
}

function makeStream(): OpencodeStream & { emitData(chunk: string): void } {
	const listeners: Array<(chunk: string) => void> = [];
	return {
		setEncoding: () => undefined,
		on(event, listener) {
			if (event === "data") listeners.push(listener);
			return undefined;
		},
		emitData: (chunk) => {
			for (const listener of listeners) listener(chunk);
		},
	};
}

interface TurnHarness {
	events: AgentEvent[];
	options: {
		history: Message[];
		inbound: Inbound[];
		workspaceRoot: string;
		rules: PermissionRules;
		signal: AbortSignal;
		onEvent: (event: AgentEvent) => void;
	};
}

function turnOptions(
	overrides: Partial<TurnHarness["options"]> = {},
): TurnHarness {
	const events: AgentEvent[] = [];
	return {
		events,
		options: {
			history: overrides.history ?? [],
			inbound: overrides.inbound ?? [
				{ kind: "user", from: "user", text: "hello", at: 0 },
			],
			workspaceRoot: workspace,
			rules: overrides.rules ?? {},
			signal: overrides.signal ?? new AbortController().signal,
			onEvent: (event) => events.push(event),
		},
	};
}

function sessionEvent(
	type: string,
	data: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type, data: { sessionID: SESSION, ...data } };
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

describe("opencode backend", () => {
	it("starts one server and one session across two turns and reuses them", async () => {
		const { backend, probes } = createHarness();

		const first = turnOptions();
		const running1 = backend.run(first.options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "first prompt");
		probes.sendEvent(
			sessionEvent("session.text.started", {
				assistantMessageID: "m1",
				ordinal: 0,
			}),
		);
		probes.sendEvent(
			sessionEvent("session.text.delta", {
				assistantMessageID: "m1",
				ordinal: 0,
				delta: "hi there",
			}),
		);
		probes.sendEvent(
			sessionEvent("session.text.ended", {
				assistantMessageID: "m1",
				ordinal: 0,
				text: "hi there",
			}),
		);
		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		const result1 = await running1;

		const second = turnOptions({
			inbound: [{ kind: "user", from: "user", text: "again", at: 1 }],
		});
		const running2 = backend.run(second.options);
		await waitFor(() => probes.prompts.length === 2, "second prompt");
		probes.sendEvent(
			sessionEvent("session.text.ended", {
				assistantMessageID: "m2",
				ordinal: 0,
				text: "ok",
			}),
		);
		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		const result2 = await running2;

		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		expect(result1.text).toBe("hi there");
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;
		expect(result2.text).toBe("ok");
		expect(probes.spawned).toHaveLength(1);
		expect(probes.spawned[0].command).toBe("opencode");
		expect(probes.spawned[0].args).toEqual([
			"serve",
			"--port",
			"0",
			"--hostname",
			"127.0.0.1",
		]);
		expect(probes.sessions).toHaveLength(1);
		expect(probes.prompts.map((p) => p.sessionID)).toEqual(["ses_1", "ses_1"]);
		expect(probes.prompts[0].body).toEqual({ text: "[from user] hello" });
		expect(probes.prompts[1].body).toEqual({ text: "[from user] again" });
		backend.dispose?.();
	});

	it("passes the role and translated permissions as an injected agent", async () => {
		const { backend, probes } = createHarness({
			rules: {
				read_file: "allow",
				glob: "deny",
				grep: "deny",
				write_file: "deny",
				edit_file: "deny",
				bash: "allow",
			},
		});
		const running = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		const config = JSON.parse(
			probes.spawned[0].env.OPENCODE_CONFIG_CONTENT ?? "{}",
		);
		expect(config).toEqual({
			agents: {
				"myagent-reviewer": {
					description: 'my-agent rob "reviewer"',
					mode: "primary",
					system: "review code",
					permissions: [
						{ action: "*", resource: "*", effect: "deny" },
						{ action: "read", resource: "*", effect: "allow" },
						{ action: "shell", resource: "*", effect: "allow" },
					],
				},
			},
		});
		expect(probes.spawned[0].env.OPENCODE_PASSWORD).toMatch(/^[0-9a-f]{48}$/);

		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;
		backend.dispose?.();
	});

	it("isolates the child under an injected data dir", async () => {
		const dataDir = "/tmp/my-agent-opencode-isolated";
		const { backend, probes } = createHarness({ dataDir });
		const running = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		expect(probes.spawned[0].env.XDG_DATA_HOME).toBe(dataDir);
		expect(probes.spawned[0].env.XDG_STATE_HOME).toBe(`${dataDir}/state`);

		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;
		backend.dispose?.();
	});

	it("merges extraEnv but keeps OPENCODE_PASSWORD and config authoritative", async () => {
		const { backend, probes } = createHarness({
			rules: { read_file: "allow" },
			extraEnv: {
				DEEPSEEK_API_KEY: "sk-forwarded",
				OPENCODE_PASSWORD: "collided-password",
				OPENCODE_CONFIG_CONTENT: "collided-config",
			},
		});
		const running = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		const env = probes.spawned[0].env;
		expect(env.DEEPSEEK_API_KEY).toBe("sk-forwarded");
		expect(env.OPENCODE_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
		const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
		expect(Object.keys(config.agents)).toEqual(["myagent-reviewer"]);

		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;
		backend.dispose?.();
	});

	it("sends a model ref only when provider and model are both present", async () => {
		const withModel = createHarness({
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		const running = withModel.backend.run(turnOptions().options);
		await withModel.probes.eventsReady;
		await waitFor(
			() => withModel.probes.prompts.length === 1,
			"prompt with model",
		);
		expect(withModel.probes.sessions[0]).toEqual({
			agent: "myagent-reviewer",
			model: { providerID: "deepseek", id: "deepseek-v4-flash" },
		});
		withModel.probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;
		withModel.backend.dispose?.();

		const withoutModel = createHarness();
		const running2 = withoutModel.backend.run(turnOptions().options);
		await withoutModel.probes.eventsReady;
		await waitFor(
			() => withoutModel.probes.prompts.length === 1,
			"prompt without model",
		);
		expect(withoutModel.probes.sessions[0]).toEqual({
			agent: "myagent-reviewer",
		});
		withoutModel.probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running2;
		withoutModel.backend.dispose?.();
	});

	it("steers a drained interjection into the running turn", async () => {
		let queued: Inbound[] = [];
		const { backend, probes } = createHarness({
			drain: () => {
				const items = queued;
				queued = [];
				return items;
			},
		});
		const running = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		queued = [{ kind: "user", from: "user", text: "actually stop", at: 1 }];
		await waitFor(() => probes.prompts.length === 2, "steer prompt", 2000);
		expect(probes.prompts[1]).toEqual({
			sessionID: "ses_1",
			body: { text: "[from user] actually stop", delivery: "steer" },
		});

		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;
		backend.dispose?.();
	});

	it("maps tool events to tool_started and tool_finished with a 4000 char cap", async () => {
		const { backend, probes } = createHarness();
		const turn = turnOptions();
		const running = backend.run(turn.options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		probes.sendEvent(
			sessionEvent("session.tool.input.started", {
				id: "call_1",
				name: "write",
			}),
		);
		probes.sendEvent(
			sessionEvent("session.tool.called", {
				id: "call_1",
				input: { path: "a.txt", content: "x" },
			}),
		);
		probes.sendEvent(
			sessionEvent("session.tool.success", {
				id: "call_1",
				content: [{ type: "text", text: "A".repeat(5000) }],
			}),
		);
		probes.sendEvent(
			sessionEvent("session.step.ended", {
				tokens: {
					input: 100,
					output: 20,
					reasoning: 3,
					cache: { read: 5, write: 0 },
				},
			}),
		);
		probes.sendEvent(
			sessionEvent("session.text.ended", {
				assistantMessageID: "m1",
				ordinal: 0,
				text: "done",
			}),
		);
		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		const result = await running;

		expect(turn.events).toEqual([
			{
				type: "tool_started",
				id: "call_1",
				name: "write_file",
				args: { path: "a.txt", content: "x" },
			},
			{
				type: "tool_finished",
				id: "call_1",
				name: "write_file",
				ok: true,
				status: "ok",
				summary: `${"A".repeat(200)}...`,
				output: `${"A".repeat(4000)}[truncated]`,
			},
			{
				type: "usage",
				inputTokens: 100,
				outputTokens: 20,
				cacheHitTokens: 5,
				cacheMissTokens: 0,
				reasoningTokens: 3,
			},
			{ type: "text_delta", text: "done" },
			{ type: "done", reason: "finished", steps: 0 },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheHitTokens: 5,
			cacheMissTokens: 0,
			reasoningTokens: 3,
		});
		expect(result.messages).toEqual([
			{ role: "user", content: "[from user] hello" },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		]);
		backend.dispose?.();
	});

	it("posts interrupt on abort and ends the turn as aborted", async () => {
		const { backend, probes } = createHarness();
		const controller = new AbortController();
		const turn = turnOptions({ signal: controller.signal });
		const running = backend.run(turn.options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		controller.abort();
		await waitFor(() => probes.interrupts.length === 1, "interrupt");
		expect(probes.interrupts).toEqual(["ses_1"]);
		probes.sendEvent(
			sessionEvent("session.execution.interrupted", { reason: "user" }),
		);

		const result = await running;
		expect(turn.events).toEqual([
			{ type: "done", reason: "aborted", steps: 0 },
		]);
		expect(result).toEqual({
			ok: false,
			error: "Turn aborted.",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheHitTokens: 0,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			messages: [{ role: "user", content: "[from user] hello" }],
		});
		backend.dispose?.();
	});

	it("recreates the session when a prompt returns 404", async () => {
		const { backend, probes } = createHarness();
		const running1 = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "first prompt");
		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running1;

		probes.failNextPrompt404();
		const running2 = backend.run(turnOptions().options);
		await waitFor(() => probes.prompts.length === 2, "retried prompt");
		expect(probes.sessions).toHaveLength(2);
		probes.sendEvent(
			sessionEvent("session.text.ended", {
				sessionID: "ses_2",
				assistantMessageID: "m2",
				ordinal: 0,
				text: "recovered",
			}),
		);
		probes.sendEvent(
			sessionEvent("session.execution.succeeded", { sessionID: "ses_2" }),
		);
		const result = await running2;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("recovered");
		expect(probes.prompts.at(-1)?.sessionID).toBe("ses_2");
		backend.dispose?.();
	});

	it("kills the server child on dispose, once", async () => {
		const { backend, probes } = createHarness();
		const running = backend.run(turnOptions().options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");
		probes.sendEvent(sessionEvent("session.execution.succeeded"));
		await running;

		backend.dispose?.();
		expect(probes.killed).toEqual(["SIGTERM"]);
		backend.dispose?.();
		expect(probes.killed).toEqual(["SIGTERM"]);
	});

	it("errors the turn when the server process exits unexpectedly", async () => {
		const { backend, probes } = createHarness();
		const turn = turnOptions();
		const running = backend.run(turn.options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		probes.closeChild(1);
		const result = await running;
		expect(result).toMatchObject({
			ok: false,
			error: "opencode serve exited unexpectedly (code 1).",
		});
		expect(turn.events.at(-1)).toEqual({
			type: "done",
			reason: "error",
			steps: 0,
		});
	});

	it("resolves an in-flight turn as aborted when disposed", async () => {
		const { backend, probes } = createHarness();
		const turn = turnOptions();
		const running = backend.run(turn.options);
		await probes.eventsReady;
		await waitFor(() => probes.prompts.length === 1, "prompt");

		backend.dispose?.();
		const result = await running;
		expect(result).toEqual({
			ok: false,
			error: "Turn aborted.",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheHitTokens: 0,
				cacheMissTokens: 0,
				reasoningTokens: 0,
			},
			messages: [{ role: "user", content: "[from user] hello" }],
		});
		expect(turn.events).toEqual([
			{ type: "done", reason: "aborted", steps: 0 },
		]);
		expect(probes.killed).toEqual(["SIGTERM"]);
	});
});
