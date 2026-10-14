import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import { readCredentials } from "../../src/config/credentials.js";
import {
	type ProviderSettings,
	validateProviderSelection,
} from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { CompositeHub } from "../../src/serve/composite.js";
import {
	ProviderRuntime,
	type RuntimeSnapshot,
	UNCONFIGURED_MESSAGE,
	unconfiguredProvider,
} from "../../src/serve/runtime.js";
import { buildServer } from "../../src/serve/server.js";
import { SettingsService } from "../../src/serve/settings.js";
import { SoloHub } from "../../src/serve/solo.js";
import { TeamHub } from "../../src/serve/team.js";
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

let homeDir: string;
let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-settings-sessions-"),
	);
	homeDir = mkdtempSync(path.join(tmpdir(), "my-agent-settings-home-"));
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-settings-ws-"));
});

function runtimeWith(
	provider: Provider,
	overrides: Partial<RuntimeSnapshot> = {},
): ProviderRuntime {
	const snapshot: RuntimeSnapshot = {
		provider,
		settings,
		apiKey: null,
		apiKeySource: null,
		providerEnv: {},
		...overrides,
	};
	return new ProviderRuntime(snapshot);
}

function soloOptions(runtime: ProviderRuntime) {
	return {
		workspaceRoot,
		provider: runtime.current().provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		allowAll: createAllowAll(),
		runtime,
	};
}

function makeHub(runtime: ProviderRuntime): SoloHub {
	return new SoloHub(soloOptions(runtime), {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
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

async function listen(app: Awaited<ReturnType<typeof buildServer>>) {
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	return typeof address === "object" && address !== null ? address.port : 0;
}

// Reads the SSE body until the first `hello` frame arrives.
async function readHello(port: number) {
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
		if (done) throw new Error("stream ended before hello");
		buffer += decoder.decode(value, { stream: true });
		const frameEnd = buffer.indexOf("\n\n");
		if (frameEnd === -1) continue;
		const dataLine = buffer
			.slice(0, frameEnd)
			.split("\n")
			.find((line) => line.startsWith("data: "));
		if (dataLine === undefined) continue;
		ac.abort();
		return JSON.parse(dataLine.slice(6)) as Extract<
			ServerEvent,
			{ type: "hello" }
		>;
	}
}

describe("unconfigured start", () => {
	it("serves a hello with provider.configured false and blocks a dispatch", async () => {
		const runtime = runtimeWith(unconfiguredProvider());
		const hub = makeHub(runtime);

		const app = await buildServer(hub, undefined);
		const port = await listen(app);
		const hello = await readHello(port);
		expect(hello.provider).toMatchObject({
			configured: false,
			preset: "deepseek",
			model: "deepseek-flash",
			apiKeySource: null,
		});

		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));
		hub.dispatch("assistant", "do something");
		expect(events).toContainEqual({
			type: "error",
			bot: "assistant",
			message: UNCONFIGURED_MESSAGE,
		});
		// The guard returns before startRun, so nothing ever reached the provider.
		expect(events.some((event) => event.type === "agent_event")).toBe(false);
		expect(
			events.some(
				(event) =>
					event.type === "bot_status" && event.state.status === "working",
			),
		).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});

describe("SettingsService.save", () => {
	it("swaps the provider through the injected seam after a save", async () => {
		const injected = createMockProvider([]);
		const runtime = new ProviderRuntime(
			{
				provider: unconfiguredProvider(),
				settings,
				apiKey: null,
				apiKeySource: null,
				providerEnv: {},
			},
			injected,
		);
		let verified = 0;
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => {
				verified += 1;
				return { ok: true };
			},
			applyRuntime: async (next) => {
				runtime.update(next);
				return { ok: true };
			},
		});

		expect(runtime.isConfigured()).toBe(false);

		const result = await service.save({
			preset: "deepseek",
			model: "deepseek-v4-pro",
			apiKey: "sk-secret-value",
		});

		expect(result.ok).toBe(true);
		expect(verified).toBe(1);
		expect(runtime.isConfigured()).toBe(true);
		expect(runtime.view()).toMatchObject({
			configured: true,
			preset: "deepseek",
			model: "deepseek-v4-pro",
			apiKeyEnv: "DEEPSEEK_API_KEY",
			apiKeySource: "credentials",
		});
		// The injected provider is pinned: no real client replaced it.
		expect(runtime.current().provider).toBe(injected);

		const stored = readCredentials(homeDir);
		expect(stored.ok && stored.keys.DEEPSEEK_API_KEY).toBe("sk-secret-value");
	});

	it("returns a busy refusal when applyRuntime refuses", async () => {
		const runtime = runtimeWith(unconfiguredProvider());
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => ({ ok: true }),
			applyRuntime: async () => ({ ok: false, error: "A rob is mid-turn." }),
		});

		const result = await service.save({
			preset: "deepseek",
			model: "deepseek-v4-pro",
			apiKey: "sk-secret-value",
		});
		expect(result).toMatchObject({ ok: false, kind: "busy" });
	});

	it("rejects an empty key without writing anything", async () => {
		const runtime = runtimeWith(unconfiguredProvider());
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => ({ ok: true }),
			applyRuntime: async (next) => {
				runtime.update(next);
				return { ok: true };
			},
		});

		const result = await service.save({
			preset: "deepseek",
			model: "deepseek-flash",
			apiKey: "   ",
		});
		expect(result).toMatchObject({ ok: false, kind: "invalid" });
	});
});

describe("validateProviderSelection", () => {
	it("rejects a deepseek model that does not start with deepseek", () => {
		expect(
			validateProviderSelection({ preset: "deepseek", model: "gpt-4o-mini" }),
		).toEqual({
			ok: false,
			error: 'Model "gpt-4o-mini" does not belong to preset "deepseek".',
		});
	});

	it("accepts matching models and rejects cross-preset models", () => {
		expect(
			validateProviderSelection({
				preset: "deepseek",
				model: "deepseek-v4-pro",
			}),
		).toEqual({ ok: true, preset: "deepseek", model: "deepseek-v4-pro" });
		expect(
			validateProviderSelection({
				preset: "deepseek",
				model: "deepseek/deepseek-v4-pro",
			}),
		).toEqual({ ok: true, preset: "deepseek", model: "deepseek-v4-pro" });
		expect(
			validateProviderSelection({ preset: "openai", model: "deepseek-flash" })
				.ok,
		).toBe(false);
		expect(
			validateProviderSelection({ preset: "ollama", model: "llama3" }).ok,
		).toBe(false);
	});
});

describe("live provider swap", () => {
	it("uses the saved model on the next workspace turn without a restart", async () => {
		const injected = createMockProvider([[{ type: "text_delta", text: "ok" }]]);
		const runtime = new ProviderRuntime(
			{
				provider: injected,
				settings,
				apiKey: null,
				apiKeySource: null,
				providerEnv: {},
			},
			injected,
		);
		const allowAll = createAllowAll();
		const options = {
			workspaceRoot,
			get provider() {
				return runtime.current().provider;
			},
			get settings() {
				return runtime.current().settings;
			},
			permissions: {},
			extraTools: [],
			compaction: {
				auto: false,
				thresholdTokens: 100_000,
				keepRecentTokens: 20_000,
			},
			allowAll,
			runtime,
		};
		const workspace = new SoloHub(options, {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});
		const robs = new TeamHub({ ...options, robs: [], providerEnv: {} });
		const hub = new CompositeHub(workspace, robs, workspaceRoot, runtime);
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => ({ ok: true }),
			applyRuntime: (next) => hub.applyRuntime(next),
		});

		await service.save({
			preset: "deepseek",
			model: "deepseek-v4-pro",
			apiKey: "sk-secret-value",
		});
		expect(runtime.isConfigured()).toBe(true);

		workspace.dispatch("assistant", "ping");
		await waitFor(() => injected.requests.length > 0, "provider request");
		// The getter-bound SoloHub read the swapped model on the very next turn.
		expect(injected.requests[0]?.model).toBe("deepseek-v4-pro");
		await hub.dispose();
	});
});

describe("TeamHub.reconfigure", () => {
	it("refuses while a rob works and rebuilds with the new model when idle", async () => {
		const runtime = new ProviderRuntime({
			provider: createMockProvider([]),
			settings,
			apiKey: "sk-existing",
			apiKeySource: "env",
			providerEnv: {},
		});
		const allowAll = createAllowAll();
		const teamOptions = {
			workspaceRoot,
			provider: slowProvider(),
			settings,
			permissions: {},
			extraTools: [],
			compaction: {
				auto: false,
				thresholdTokens: 100_000,
				keepRecentTokens: 20_000,
			},
			allowAll,
			runtime,
			robs: [{ name: "alpha", role: "a test rob" }],
			providerEnv: {},
		};
		const team = new TeamHub(teamOptions);

		team.dispatch("alpha", "hi");
		await waitFor(
			() => team.states().some((state) => state.status === "working"),
			"working status",
		);

		const next: RuntimeSnapshot = {
			provider: createMockProvider([]),
			settings: { ...settings, model: "deepseek-v4-pro" },
			apiKey: "sk-existing",
			apiKeySource: "env",
			providerEnv: {},
		};
		const refused = await team.reconfigure(next);
		expect(refused.ok).toBe(false);

		team.interrupt("alpha");
		await waitFor(
			() => team.states().some((state) => state.status === "idle"),
			"idle status",
		);

		const applied = await team.reconfigure(next);
		expect(applied).toEqual({ ok: true });
		expect(team.bots()[0]?.model).toBe("deepseek-v4-pro");
		await team.dispose();
	});
});

describe("POST /api/settings", () => {
	it("applies a save when the caller presents the server token", async () => {
		// A wider bind issues a token and requires it on every /api/* request,
		// so a token-bearing caller is the owner. The old bind-host check
		// refused this save, which is the bug this pins.
		const runtime = runtimeWith(createMockProvider([]), {
			apiKey: "sk-existing",
			apiKeySource: "env",
		});
		const hub = makeHub(runtime);
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => ({ ok: true }),
			applyRuntime: async (next) => {
				runtime.update(next);
				return { ok: true };
			},
		});
		const token = "token-from-the-owner";
		const app = await buildServer(hub, undefined, {
			service,
			token,
		});
		const port = await listen(app);

		const refused = await fetch(`http://127.0.0.1:${port}/api/settings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				preset: "deepseek",
				model: "deepseek-v4-pro",
				apiKey: "sk-new",
				verify: false,
			}),
		});
		expect(refused.status).toBe(401);

		const response = await fetch(
			`http://127.0.0.1:${port}/api/settings?token=${token}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					preset: "deepseek",
					model: "deepseek-v4-pro",
					apiKey: "sk-new",
					verify: false,
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true });
		expect(runtime.view().model).toBe("deepseek-v4-pro");

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("serves settings and applies a save on a loopback bind", async () => {
		const injected = createMockProvider([]);
		const runtime = new ProviderRuntime(
			{
				provider: unconfiguredProvider(),
				settings,
				apiKey: null,
				apiKeySource: null,
				providerEnv: {},
			},
			injected,
		);
		const hub = makeHub(runtime);
		const service = new SettingsService({
			homeDir,
			workspaceRoot,
			env: {},
			runtime,
			verify: async () => ({ ok: true }),
			applyRuntime: async (next) => {
				runtime.update(next);
				return { ok: true };
			},
		});
		const app = await buildServer(hub, undefined, { service });
		const port = await listen(app);

		const before = await fetch(`http://127.0.0.1:${port}/api/settings`);
		expect(before.status).toBe(200);
		expect(before.headers.get("cache-control")).toBe("no-store");
		const body = (await before.json()) as {
			provider: { configured: boolean };
			presets: Array<{ name: string; defaultModel: string }>;
		};
		expect(body.provider.configured).toBe(false);
		expect(body.presets.map((preset) => preset.name)).toEqual([
			"deepseek",
			"openai",
		]);

		const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				preset: "deepseek",
				model: "deepseek-v4-pro",
				apiKey: "sk-secret-value",
			}),
		});
		expect(saved.status).toBe(200);
		const savedBody = (await saved.json()) as {
			ok: boolean;
			provider: { model: string; configured: boolean };
		};
		expect(savedBody.ok).toBe(true);
		expect(savedBody.provider).toMatchObject({
			model: "deepseek-v4-pro",
			configured: true,
		});
		// The key never crosses back to the client.
		expect(JSON.stringify(savedBody)).not.toContain("sk-secret-value");

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
