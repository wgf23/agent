import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import { type BotStore, createBotStore } from "../../src/bot/store.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { CompositeHub } from "../../src/serve/composite.js";
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

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-composite-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-composite-bots-"),
	);
	workspaceRoot = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-composite-ws-"),
	);
});

function createHub(
	provider: Provider = createMockProvider([]),
	store?: BotStore,
) {
	const allowAll = createAllowAll();
	const options = {
		workspaceRoot,
		provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		allowAll,
	};
	const workspace = new SoloHub(options, {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
	const robs = new TeamHub({
		...options,
		robs: [],
		providerEnv: {},
		...(store === undefined ? {} : { store }),
	});
	return new CompositeHub(workspace, robs, workspaceRoot);
}

function readRobs(): unknown {
	return JSON.parse(readFileSync(projectFilePath(workspaceRoot), "utf8")).robs;
}

describe("CompositeHub.createBot", () => {
	it("keeps the workspace bot and adds a rob", async () => {
		const hub = createHub();
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));

		const created = await hub.createBot({
			name: "writer",
			role: "drafts prose",
		});
		expect(created).toEqual({
			name: "writer",
			role: "drafts prose",
			model: "deepseek-flash",
			backend: "native",
		});

		const hello = hub.hello();
		// The workspace chat is not a roster entry: bots are robs only, while its
		// state is still merged so the client keeps a status dot for the chat.
		expect(hello.bots.map((bot) => bot.name)).toEqual(["writer"]);
		expect(hello.states.map((state) => state.bot)).toContain("assistant");
		expect(events.some((event) => event.type === "bots")).toBe(true);
		expect(readRobs()).toEqual([{ name: "writer", role: "drafts prose" }]);
		await hub.dispose();
	});

	it("preserves existing keys in my-agent.json", async () => {
		writeFileSync(
			projectFilePath(workspaceRoot),
			`${JSON.stringify({ permissions: { bash: "allow" }, custom: 1 }, null, 2)}\n`,
		);
		const hub = createHub();
		await hub.createBot({ name: "reviewer", role: "reviews code" });

		const raw = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(raw.permissions).toEqual({ bash: "allow" });
		expect(raw.custom).toBe(1);
		expect(raw.robs).toHaveLength(1);
		await hub.dispose();
	});

	it("rejects a duplicate name", async () => {
		const hub = createHub();
		await hub.createBot({ name: "writer", role: "drafts" });
		await expect(
			hub.createBot({ name: "writer", role: "again" }),
		).rejects.toThrow(/already exists/);
		await hub.dispose();
	});

	it("rejects the reserved workspace name", async () => {
		const hub = createHub();
		await expect(
			hub.createBot({ name: "assistant", role: "x" }),
		).rejects.toThrow(/reserved/);
		await hub.dispose();
	});

	it("rejects an invalid name and an incomplete cli backend", async () => {
		const hub = createHub();
		await expect(
			hub.createBot({ name: "Bad Name", role: "x" }),
		).rejects.toThrow();
		await expect(
			hub.createBot({
				name: "pibot",
				role: "x",
				backend: { kind: "cli", command: "pi" },
			}),
		).rejects.toThrow();
		await hub.dispose();
	});

	it("rejects a cli backend whose command is not on PATH", async () => {
		const hub = createHub();
		const emptyDir = mkdtempSync(path.join(tmpdir(), "my-agent-empty-path-"));
		const previous = process.env.PATH;
		process.env.PATH = emptyDir;
		try {
			await expect(
				hub.createBot({
					name: "pibot",
					role: "x",
					backend: {
						kind: "cli",
						command: "pi",
						provider: "deepseek",
						model: "deepseek-chat",
					},
				}),
			).rejects.toThrow(/PATH/);
		} finally {
			process.env.PATH = previous;
		}
		await hub.dispose();
	});
});

describe("CompositeHub.updateBot", () => {
	it("replaces role and model in place and keeps the wake and other keys", async () => {
		writeFileSync(
			projectFilePath(workspaceRoot),
			`${JSON.stringify({ permissions: { bash: "allow" }, custom: 1 }, null, 2)}\n`,
		);
		const hub = createHub();
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));
		await hub.createBot({ name: "writer", role: "drafts prose" });
		await hub.setWake("writer", { everyMs: 5000, prompt: "tick" });

		const updated = await hub.updateBot("writer", {
			role: "edits prose",
			model: "deepseek-chat",
		});

		expect(updated).toEqual({
			name: "writer",
			role: "edits prose",
			model: "deepseek-chat",
			backend: "native",
			wake: { everyMs: 5000, prompt: "tick" },
		});
		expect(hub.hello().bots[0]).toMatchObject({
			name: "writer",
			role: "edits prose",
			model: "deepseek-chat",
		});
		expect(events.some((event) => event.type === "bots")).toBe(true);

		const raw = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(raw.permissions).toEqual({ bash: "allow" });
		expect(raw.custom).toBe(1);
		expect(raw.robs).toEqual([
			{
				name: "writer",
				role: "edits prose",
				model: "deepseek-chat",
				wake: { everyMs: 5000, prompt: "tick" },
			},
		]);
		await hub.dispose();
	});

	it("rejects an unknown bot and a cli backend not on PATH", async () => {
		const hub = createHub();
		await expect(hub.updateBot("ghost", { role: "x" })).rejects.toThrow(
			"Unknown rob: ghost",
		);

		const emptyDir = mkdtempSync(path.join(tmpdir(), "my-agent-empty-path-"));
		const previous = process.env.PATH;
		process.env.PATH = emptyDir;
		try {
			await expect(
				hub.updateBot("ghost", {
					role: "x",
					backend: {
						kind: "cli",
						command: "pi",
						provider: "deepseek",
						model: "deepseek-chat",
					},
				}),
			).rejects.toThrow(/PATH/);
		} finally {
			process.env.PATH = previous;
		}
		await hub.dispose();
	});
});

describe("CompositeHub.removeBot", () => {
	it("drops the config entry and the roster, and reports an unknown name", async () => {
		const hub = createHub();
		await hub.createBot({ name: "writer", role: "drafts" });
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));

		expect(await hub.removeBot("ghost")).toBe(false);
		expect(await hub.removeBot("writer")).toBe(true);
		expect(hub.hello().bots).toEqual([]);
		expect(events.some((event) => event.type === "bots")).toBe(true);
		expect(
			JSON.parse(readFileSync(projectFilePath(workspaceRoot), "utf8")).robs,
		).toEqual([]);
		await hub.dispose();
	});

	it("surfaces a ledger failure without deleting the config or claiming the bot is gone", async () => {
		const real = createBotStore();
		const failing: BotStore = {
			...real,
			remove: () => Promise.reject(new Error("ledger remove failed")),
		};
		const hub = createHub(createMockProvider([]), failing);
		await hub.createBot({ name: "writer", role: "drafts" });
		const events: ServerEvent[] = [];
		hub.subscribe((event) => events.push(event));

		await expect(hub.removeBot("writer")).rejects.toThrow(
			"ledger remove failed",
		);

		// The runtime/ledger removal runs before the config write, so the
		// failure left both the roster and my-agent.json intact and no `bots`
		// event claimed the bot is gone.
		expect(hub.hello().bots.map((bot) => bot.name)).toEqual(["writer"]);
		expect(readRobs()).toEqual([{ name: "writer", role: "drafts" }]);
		expect(events.some((event) => event.type === "bots")).toBe(false);
		await hub.dispose();
	});
});
