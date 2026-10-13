import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { NpmOptions, NpmResult } from "../../src/agents/install.js";
import type { ProbeResult } from "../../src/agents/probe.js";
import { AgentSupervisor } from "../../src/agents/supervisor.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { buildServer } from "../../src/serve/server.js";
import { SoloHub } from "../../src/serve/solo.js";
import { newSession } from "../../src/session/store.js";
import { createMockProvider } from "../helpers/mock-provider.js";

const settings: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-agents-http-sessions-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-agents-http-ws-"));
});

function missing(command: string): ProbeResult {
	return { ok: false, kind: "not_found", error: `missing ${command}` };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeHub(): SoloHub {
	return new SoloHub(
		{
			workspaceRoot,
			provider: createMockProvider([]),
			settings,
			permissions: {},
			extraTools: [],
			compaction: {
				auto: false,
				thresholdTokens: 100_000,
				keepRecentTokens: 20_000,
			},
			allowAll: createAllowAll(),
		},
		{ session: newSession(workspaceRoot, settings.model), sessions: [] },
	);
}

// Builds a server with an injected fake probe and installer, so nothing here
// ever spawns a real npm.
async function startServer(
	install: (pkg: string, options?: NpmOptions) => Promise<NpmResult>,
	host = "127.0.0.1",
) {
	const hub = makeHub();
	const supervisor = new AgentSupervisor({
		probe: async (command: string) => missing(command),
		install,
	});
	const app = await buildServer(hub, undefined, undefined, {
		supervisor,
		host,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return { app, hub, supervisor, port };
}

const okInstall = vi.fn(
	async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => ({
		ok: true,
	}),
);

// Reads the SSE body until the first `agents` frame arrives.
async function readAgentsEvent(port: number) {
	const ac = new AbortController();
	const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
		signal: ac.signal,
	});
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("no response body");
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) throw new Error("stream ended before an agents event");
		buffer += decoder.decode(value, { stream: true });
		let frameEnd = buffer.indexOf("\n\n");
		while (frameEnd !== -1) {
			const frame = buffer.slice(0, frameEnd);
			buffer = buffer.slice(frameEnd + 2);
			frameEnd = buffer.indexOf("\n\n");
			const dataLine = frame
				.split("\n")
				.find((line) => line.startsWith("data: "));
			if (dataLine === undefined) continue;
			const event = JSON.parse(dataLine.slice(6)) as ServerEvent;
			if (event.type === "agents") {
				ac.abort();
				return event;
			}
		}
	}
}

describe("agent routes", () => {
	it("serves the catalog folded with detection", async () => {
		const { app, hub, supervisor, port } = await startServer(okInstall);

		const response = await fetch(`http://127.0.0.1:${port}/api/agents`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			agents: Array<Record<string, unknown>>;
		};
		expect(body.agents).toHaveLength(5);
		expect(body.agents[0]).toMatchObject({
			id: "pi",
			command: "pi",
			npmPackage: "@mariozechner/pi-coding-agent",
			installed: false,
			onPath: false,
			path: null,
			version: null,
			robBackend: true,
			needsProviderAndModel: true,
			testedVersion: "0.73.0",
			job: null,
		});
		expect(body.agents[3]).toMatchObject({
			id: "codex",
			robBackend: false,
			robBlockedReason: "no rob backend yet",
		});

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});

	it("rejects an unknown id and a body without confirm", async () => {
		const { app, hub, supervisor, port } = await startServer(okInstall);
		const post = (body: unknown) =>
			fetch(`http://127.0.0.1:${port}/api/agents/install`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const unknown = await post({ id: "nope", confirm: true });
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({ ok: false });

		const noConfirm = await post({ id: "pi" });
		expect(noConfirm.status).toBe(428);
		expect(okInstall).not.toHaveBeenCalled();

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});

	it("refuses an install on a non-loopback bind", async () => {
		const { app, hub, supervisor, port } = await startServer(
			okInstall,
			"0.0.0.0",
		);

		const response = await fetch(
			`http://127.0.0.1:${port}/api/agents/install`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pi", confirm: true }),
			},
		);
		expect(response.status).toBe(403);
		expect(okInstall).not.toHaveBeenCalled();

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});

	it("accepts a valid install with 202", async () => {
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => ({
				ok: true,
			}),
		);
		const { app, hub, supervisor, port } = await startServer(install);

		const response = await fetch(
			`http://127.0.0.1:${port}/api/agents/install`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pi", confirm: true }),
			},
		);
		expect(response.status).toBe(202);
		const body = (await response.json()) as {
			ok: boolean;
			job: { agent: string; phase: string };
			alreadyRunning: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.job.agent).toBe("pi");
		expect(body.alreadyRunning).toBe(false);
		expect(install).toHaveBeenCalledWith(
			"@mariozechner/pi-coding-agent",
			expect.anything(),
		);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});

	it("answers 409 when a different id is requested while one is live", async () => {
		const pending = deferred<NpmResult>();
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> =>
				pending.promise,
		);
		const { app, hub, supervisor, port } = await startServer(install);
		const post = (id: string) =>
			fetch(`http://127.0.0.1:${port}/api/agents/install`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id, confirm: true }),
			});

		const first = await post("pi");
		expect(first.status).toBe(202);

		const second = await post("codex");
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ ok: false });

		pending.resolve({ ok: true });
		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});

	it("streams an agents snapshot over /api/events", async () => {
		const { app, hub, supervisor, port } = await startServer(okInstall);

		const event = await readAgentsEvent(port);
		expect(event.agents).toHaveLength(5);
		expect(event.agents[0]).toMatchObject({ id: "pi", installed: false });

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
		await supervisor.dispose();
	});
});
