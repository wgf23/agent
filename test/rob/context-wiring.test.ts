import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/agent/compact.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { ChannelRegistry } from "../../src/bot/channel.js";
import { consolidate } from "../../src/bot/consolidate.js";
import { emptyDelta } from "../../src/bot/record.js";
import type { BotRecord, Turn } from "../../src/bot/schema.js";
import { type BotStore, createBotStore } from "../../src/bot/store.js";
import type { Message, Provider } from "../../src/providers/types.js";
import { Rob } from "../../src/rob/rob.js";
import type { RobName } from "../../src/rob/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, FakeTeam, waitFor } from "./helpers.js";

// T7: the turn loop feeds the model an assembled, bounded context, rolls the
// thread summary into the turn's atomic commit, and runs consolidation as a
// fire-and-forget sidecar that can neither delay nor fail the turn.

const IDENTITY = { role: "work", model: "deepseek-flash" };
const SESSION = "chs_00000000000000aa";

let workspace: string;
let botsDir: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-ctx-");
	botsDir = await mkdtemp(path.join(tmpdir(), "my-agent-rob-ctx-bots-"));
});

afterEach(async () => {
	await removeWorkspace(workspace);
	await rm(botsDir, { recursive: true, force: true });
});

function memoryStore(): BotStore {
	return createBotStore({ MY_AGENT_BOTS_DIR: botsDir });
}

async function loadBot(name = "planner"): Promise<BotRecord> {
	const loaded = await memoryStore().load(name, IDENTITY);
	if (!loaded.ok) throw new Error(loaded.error);
	return loaded.record;
}

function fixedChannels(): ChannelRegistry {
	return new ChannelRegistry({ newId: () => SESSION, clock: () => 0 });
}

async function seed(
	store: BotStore,
	sessionId: string,
	turns: readonly Message[][],
): Promise<void> {
	const loaded = await store.load("planner", IDENTITY);
	if (!loaded.ok) throw new Error(loaded.error);
	let record = loaded.record;
	for (let index = 0; index < turns.length; index += 1) {
		const seq = index + 1;
		const turn: Turn = {
			id: `trn_${seq.toString(16).padStart(32, "0")}`,
			seq,
			sessionId,
			workspaceRoot: workspace,
			at: 1_000 + seq,
			wake: "user",
			messages: turns[index],
		};
		const committed = await store.commit(record, turn, emptyDelta());
		if (!committed.ok) throw new Error(committed.error);
		record = committed.record;
	}
}

async function eventually(
	predicate: () => Promise<boolean>,
	label: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function reply(turns: number): ReturnType<typeof createMockProvider> {
	return createMockProvider(
		Array.from({ length: turns }, (_, index) => [
			{ type: "text_delta" as const, text: `reply ${index}` },
			{ type: "finish" as const, reason: "stop" as const },
		]),
	);
}

class NoticeTeam extends FakeTeam {
	readonly notices: string[] = [];
	override emitNotice(_rob: RobName, text: string): void {
		this.notices.push(text);
	}
	override emitRobEvent(_rob: RobName, _event: AgentEvent): void {}
}

describe("Rob context assembly", () => {
	it("persists the rolled thread summary with the turn that triggered it", async () => {
		const store = memoryStore();
		await seed(store, SESSION, [
			[
				{ role: "user", content: "Fact: the deploy port is 8080." },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
			],
			[{ role: "user", content: "recent question about the deploy" }],
		]);

		// The first scripted turn is the summarization call (the recent window
		// is over the L1 quota), the second is the turn itself.
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "The deploy port is 8080." },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "recent reply" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store,
			channels: fixedChannels(),
			clock: () => 4_242,
			contextBudget: {
				totalTokens: 200,
				quotas: { l1: 8, l2: 20, l3: 8 },
			},
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "what port", at: 0 });
		await eventually(
			async () => (await loadBot()).turns.some((turn) => turn.seq === 3),
			"the turn to commit",
		);
		rob.stop();
		await running;

		const record = await loadBot();
		expect(record.threads?.[SESSION]).toEqual({
			summary: "The deploy port is 8080.",
			summaryAt: 4_242,
		});
		// The turn request (the second provider call) carries the summary as L2.
		expect(provider.requests[1].messages).toContainEqual({
			role: "system",
			content: "The deploy port is 8080.",
		});
	});

	it("hands the backend the assembled bounded window, not the whole ledger", async () => {
		const store = memoryStore();
		const seeded: Message[][] = Array.from({ length: 20 }, (_, index) => [
			{
				role: "user",
				content: `old question ${index} ${"x".repeat(200)}`,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: `old answer ${index} ${"y".repeat(200)}` },
				],
			},
		]);
		await seed(store, SESSION, seeded);
		// 20 turns x 2 messages = 40 messages in the ledger.
		expect(
			(await loadBot()).turns.flatMap((turn) => turn.messages),
		).toHaveLength(40);

		const budget = {
			totalTokens: 600,
			quotas: { l1: 240, l2: 120, l3: 120 },
		};
		const bound = budget.quotas.l1 + budget.quotas.l2 + budget.quotas.l3;
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "Earlier old questions." },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "current reply" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store,
			channels: fixedChannels(),
			contextBudget: budget,
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "current ask", at: 0 });
		await eventually(
			async () => (await loadBot()).turns.some((turn) => turn.seq === 21),
			"the turn to commit",
		);
		rob.stop();
		await running;

		const request = provider.requests.at(-1);
		if (request === undefined)
			throw new Error("the turn never reached the model");
		const context = request.messages.slice(1);
		expect(estimateTokens(context)).toBeLessThanOrEqual(bound);
		expect(context.length).toBeLessThan(40);
		const serialized = JSON.stringify(context);
		expect(serialized).not.toContain("old question 0 ");
		expect(serialized).toContain("old question 19 ");
		expect(serialized).toContain("current ask");
	});
});

describe("Rob consolidation sidecar", () => {
	it("applies the reflection's memory delta to the ledger after the turn", async () => {
		const sidecar = createMockProvider([
			[
				{
					type: "text_delta",
					text: JSON.stringify({
						memory: [{ kind: "fact", text: "The deploy port is 8080." }],
						summary: "",
						skills: [],
					}),
				},
				{ type: "finish", reason: "stop" },
			],
		]);
		const provider = reply(1);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: fixedChannels(),
			consolidate: consolidate({
				provider: sidecar,
				model: "mock-model",
				clock: () => 9_999,
			}),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "note the port", at: 0 });
		await eventually(
			async () => (await loadBot()).memory.length === 1,
			"the reflected memory to persist",
		);
		rob.stop();
		await running;

		const record = await loadBot();
		const [entry] = record.memory;
		expect(entry.text).toBe("The deploy port is 8080.");
		expect(entry.kind).toBe("fact");
		expect(entry.source).toEqual({ sessionId: SESSION, turnSeq: 1 });
		expect(entry.id).toMatch(/^mem_[0-9a-f]+$/);
		// The sidecar used its own provider: the turn's provider saw one call.
		expect(provider.requests).toHaveLength(1);
	});

	it("never blocks the turn while reflection is in flight", async () => {
		let entered = false;
		let finished = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sidecar: Provider = {
			id: "gated",
			async *stream() {
				entered = true;
				await gate;
				yield { type: "text_delta", text: "{}" };
				yield { type: "finish", reason: "stop" };
				finished = true;
			},
		};
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider: reply(1),
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: fixedChannels(),
			consolidate: consolidate({
				provider: sidecar,
				model: "mock-model",
				clock: () => 1,
			}),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await eventually(
			async () =>
				(await loadBot()).turns.length === 1 &&
				rob.statusSnapshot().status === "idle",
			"the turn to settle",
		);

		expect(entered).toBe(true);
		expect(finished).toBe(false);
		release();
		await eventually(async () => finished, "the sidecar to finish");
		rob.stop();
		await running;
	});

	it("records the turn when reflection fails", async () => {
		const team = new NoticeTeam();
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider: createMockProvider([
				[
					{ type: "text_delta", text: "still works" },
					{ type: "finish", reason: "stop" },
				],
			]),
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team,
			store: memoryStore(),
			channels: fixedChannels(),
			consolidate: async () => {
				throw new Error("reflection down");
			},
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(
			() => team.notices.some((notice) => notice.includes("reflection down")),
			"the sidecar failure notice",
		);
		rob.stop();
		await running;

		const record = await loadBot();
		expect(record.turns).toHaveLength(1);
		expect(record.turns[0].messages).toEqual([
			{ role: "user", content: "[from user] go" },
			{ role: "assistant", content: [{ type: "text", text: "still works" }] },
		]);
	});

	it("persists the reflected thread summary when the model returns one", async () => {
		const sidecar = createMockProvider([
			[
				{
					type: "text_delta",
					text: JSON.stringify({
						memory: [],
						summary: "New rolling summary.",
						skills: [],
					}),
				},
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider: reply(1),
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: fixedChannels(),
			clock: () => 777,
			consolidate: consolidate({
				provider: sidecar,
				model: "mock-model",
				clock: () => 9_999,
			}),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await eventually(
			async () => (await loadBot()).threads?.[SESSION] !== undefined,
			"the reflected summary to persist",
		);
		rob.stop();
		await running;

		expect((await loadBot()).threads?.[SESSION]).toEqual({
			summary: "New rolling summary.",
			summaryAt: 777,
		});
	});
});

describe("Rob exactly-once recording", () => {
	it("records exactly one turn when the run is aborted", async () => {
		const provider: Provider = {
			id: "slow",
			async *stream(request) {
				yield { type: "text_delta", text: "working" };
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) {
						resolve();
						return;
					}
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			},
		};
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: fixedChannels(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "long task", at: 0 });
		await waitFor(
			() => rob.readEvents().some((event) => event.type === "text_delta"),
			"the provider to yield before the abort",
		);

		rob.stop();
		await running;

		const record = await loadBot();
		expect(record.turns).toHaveLength(1);
		expect(record.turns[0].sessionId).toBe(SESSION);
		expect(record.turns[0].seq).toBe(1);
	});
});
