import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
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
	workspaceRoot = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-composite-ws-"),
	);
});

function createHub(provider: Provider = createMockProvider([])) {
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
	const robs = new TeamHub({ ...options, robs: [], providerEnv: {} });
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
			kind: "rob",
			role: "drafts prose",
			model: "deepseek-flash",
			backend: "native",
		});

		const hello = hub.hello();
		expect(hello.bots.map((bot) => `${bot.kind}:${bot.name}`)).toEqual([
			"workspace:assistant",
			"rob:writer",
		]);
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
});
