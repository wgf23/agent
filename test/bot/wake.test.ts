import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { type BotStore, createBotStore } from "../../src/bot/store.js";
import {
	manualClock,
	manualTimer,
	type Wake,
	wakeText,
} from "../../src/bot/wake.js";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { waitFor } from "../rob/helpers.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;
let botsDir: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-wake-");
	botsDir = await mkdtemp(path.join(tmpdir(), "my-agent-wake-bots-"));
});

afterEach(async () => {
	await removeWorkspace(workspace);
	await rm(botsDir, { recursive: true, force: true });
});

function store(): BotStore {
	return createBotStore({ MY_AGENT_BOTS_DIR: botsDir });
}

describe("wake", () => {
	it("formats the interval attribution", () => {
		const wake: Wake = {
			kind: "interval",
			bot: "writer",
			text: "check the release train",
			at: 5,
		};

		expect(wakeText(wake)).toBe("[wake:interval] check the release train");
	});

	it("advances a manual clock only when told", () => {
		const clock = manualClock(100);

		expect(clock.now()).toBe(100);
		clock.advance(50);
		expect(clock.now()).toBe(150);
	});

	it("arms nothing until scheduled and reports pending entries", () => {
		const manual = manualTimer();

		expect(manual.pending()).toEqual([]);

		const cancel = manual.timer.schedule(
			{ bot: "writer", everyMs: 60000, text: "check" },
			() => {},
		);
		expect(manual.pending()).toEqual([
			{ bot: "writer", everyMs: 60000, text: "check" },
		]);

		cancel();
		expect(manual.pending()).toEqual([]);
	});

	it("arms no timer for a rob without a wake config", async () => {
		const manual = manualTimer();
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => createMockProvider([]),
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: store(),
			clock: manualClock(0),
			timer: manual.timer,
		});

		team.start();

		expect(manual.pending()).toEqual([]);
		await team.stop();
	});

	it("wakes a configured rob and attributes the committed turn", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "woke up" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const manual = manualTimer();
		const team = new Team({
			robs: [
				{
					name: "writer",
					role: "write",
					wake: { everyMs: 60000, prompt: "check the release train" },
				},
				{ name: "planner", role: "plan" },
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: store(),
			clock: manualClock(1000),
			timer: manual.timer,
		});
		const notices: string[] = [];
		team.subscribe((event) => {
			if (event.kind === "notice") notices.push(event.text);
		});

		team.start();

		// The rob with a wake config is the only one armed.
		expect(manual.pending()).toEqual([
			{ bot: "writer", everyMs: 60000, text: "check the release train" },
		]);

		manual.fire("writer");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the wake's turn",
		);
		await team.stop();

		expect(notices).toContain("woke on interval");
		expect(provider.requests[0].messages).toContainEqual({
			role: "user",
			content: "[wake:interval] check the release train",
		});

		const loaded = await store().load("writer", {
			role: "write",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const turn = loaded.record.turns.find((entry) => entry.wake === "interval");
		expect(turn).toBeDefined();
		expect(turn?.wake).toBe("interval");
		expect(turn?.at).toBe(1000);
		expect(turn?.sessionId).toMatch(/^chs_[0-9a-f]{16}$/);
	});

	it("arms a wake for a rob added after start", async () => {
		const manual = manualTimer();
		const team = new Team({
			robs: [],
			defaultModel: "deepseek-flash",
			providerFactory: () => createMockProvider([]),
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: store(),
			clock: manualClock(0),
			timer: manual.timer,
		});
		team.start();

		team.addRob({
			name: "writer",
			role: "write",
			wake: { everyMs: 60000, prompt: "check" },
		});

		expect(manual.pending()).toEqual([
			{ bot: "writer", everyMs: 60000, text: "check" },
		]);
		await team.stop();
	});
});
