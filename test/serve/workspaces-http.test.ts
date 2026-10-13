import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent, WorkspaceOption } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import type { Provider } from "../../src/providers/types.js";
import { ProviderRuntime } from "../../src/serve/runtime.js";
import { buildServer } from "../../src/serve/server.js";
import { openWorkspace, WorkspaceHub } from "../../src/serve/workspace.js";
import { newSession, saveSession } from "../../src/session/store.js";

const settings: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

let homeDir: string;
let tmp1: string;
let tmp2: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-workspaces-http-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-workspaces-http-bots-"),
	);
	homeDir = mkdtempSync(path.join(tmpdir(), "my-agent-workspaces-http-home-"));
	tmp1 = mkdtempSync(path.join(tmpdir(), "my-agent-workspaces-http-one-"));
	tmp2 = mkdtempSync(path.join(tmpdir(), "my-agent-workspaces-http-two-"));
});

// A provider that emits one delta and then stays open until aborted, so a turn
// is reliably mid-flight when the switch is attempted.
function slowProvider(): Provider {
	return {
		id: "slow",
		async *stream(request) {
			yield { type: "text_delta", text: "working" };
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) return resolve();
				request.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
		},
	};
}

function runtimeWith(provider: Provider): ProviderRuntime {
	return new ProviderRuntime({
		provider,
		settings,
		apiKey: "sk-test",
		apiKeySource: "env",
		providerEnv: {},
	});
}

async function seedSession(root: string, text: string): Promise<string> {
	const session = newSession(root, settings.model);
	session.messages = [{ role: "user", content: text }];
	const saved = await saveSession(session);
	if (!saved.ok) throw new Error(saved.error);
	return session.id;
}

async function startServer(runtime: ProviderRuntime) {
	const open = (root: string) =>
		openWorkspace({ root, runtime, env: {}, homeDir });
	const scope = await open(tmp1);
	const hub = new WorkspaceHub({ initial: scope, open });
	const app = await buildServer(hub, undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, hub, port };
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 4000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function listWorkspaces(port: number): Promise<WorkspaceOption[]> {
	const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { workspaces: WorkspaceOption[] };
	return body.workspaces;
}

function activeRoot(workspaces: WorkspaceOption[]): string | undefined {
	return workspaces.find((workspace) => workspace.active)?.root;
}

function postSwitch(port: number, root: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/api/workspaces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ root }),
	});
}

// Reads the SSE body, framing on blank lines, and resolves the first event that
// matches. Buffers across reads so a chunk boundary never splits an event.
function openStream(port: number) {
	const ac = new AbortController();
	const response = fetch(`http://127.0.0.1:${port}/api/events`, {
		signal: ac.signal,
	});
	const readerPromise = response.then((res) => {
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body?.getReader();
		if (reader === undefined) throw new Error("no response body");
		return reader;
	});
	const decoder = new TextDecoder();
	let buffer = "";

	const next = async (
		predicate: (event: ServerEvent) => boolean,
	): Promise<ServerEvent> => {
		const reader = await readerPromise;
		while (true) {
			const frameEnd = buffer.indexOf("\n\n");
			if (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const dataLine = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (dataLine !== undefined) {
					const event = JSON.parse(dataLine.slice(6)) as ServerEvent;
					if (predicate(event)) return event;
					continue;
				}
				continue;
			}
			if (ac.signal.aborted) throw new Error("stream aborted");
			const { value, done } = await reader.read();
			if (done) throw new Error("stream ended before the expected event");
			buffer += decoder.decode(value, { stream: true });
		}
	};

	return { next, abort: () => ac.abort() };
}

describe("workspace switching over HTTP", () => {
	it("lists the initial root active and swaps scopes on switch", async () => {
		const firstSession = await seedSession(tmp1, "one");
		const secondSession = await seedSession(tmp2, "two");
		const { app, hub, port } = await startServer(runtimeWith(slowProvider()));

		const initial = await listWorkspaces(port);
		expect(activeRoot(initial)).toBe(tmp1);

		const stream = openStream(port);
		const hello1 = await stream.next((event) => event.type === "hello");
		expect(hello1.type === "hello" ? hello1.workspaceRoot : "").toBe(tmp1);
		expect(
			hello1.type === "hello" ? hello1.sessions.map((s) => s.id) : [],
		).toContain(firstSession);
		// The chat is not a roster entry, but it keeps a state for its status dot.
		expect(
			hello1.type === "hello"
				? hello1.bots.some((bot) => bot.name === "assistant")
				: true,
		).toBe(false);
		expect(
			hello1.type === "hello"
				? hello1.states.some((state) => state.bot === "assistant")
				: false,
		).toBe(true);

		const switched = await postSwitch(port, tmp2);
		expect(switched.status).toBe(200);
		expect(await switched.json()).toEqual({ ok: true });

		const hello2 = await stream.next(
			(event) => event.type === "hello" && event.workspaceRoot === tmp2,
		);
		expect(hello2.type).toBe("hello");
		if (hello2.type !== "hello") throw new Error("expected hello");
		const sessions2 = hello2.sessions.map((s) => s.id);
		expect(sessions2).toContain(secondSession);
		expect(sessions2).not.toContain(firstSession);
		expect(activeRoot(hello2.workspaces)).toBe(tmp2);

		// Switching back restores the first workspace's sessions.
		const restored = await postSwitch(port, tmp1);
		expect(restored.status).toBe(200);
		const hello3 = await stream.next(
			(event) => event.type === "hello" && event.workspaceRoot === tmp1,
		);
		expect(hello3.type).toBe("hello");
		if (hello3.type !== "hello") throw new Error("expected hello");
		expect(hello3.sessions.map((s) => s.id)).toContain(firstSession);

		stream.abort();
		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("refuses a switch while the chat is mid-turn and leaves the root active", async () => {
		const { app, hub, port } = await startServer(runtimeWith(slowProvider()));

		const sent = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bot: "assistant", text: "go" }),
		});
		expect(sent.status).toBe(200);
		await waitFor(() => hub.busy(), "a busy turn");

		const refused = await postSwitch(port, tmp2);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ ok: false });

		// The active workspace did not move.
		expect(activeRoot(await listWorkspaces(port))).toBe(tmp1);

		hub.interrupt("assistant");
		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("answers 400 for an unknown root and leaves the root active", async () => {
		const { app, hub, port } = await startServer(runtimeWith(slowProvider()));

		const missing = path.join(tmpdir(), "my-agent-workspaces-http-missing");
		const refused = await postSwitch(port, missing);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ ok: false });
		expect(activeRoot(await listWorkspaces(port))).toBe(tmp1);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
