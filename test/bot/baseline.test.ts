import { describe, expect, it } from "vitest";
import type { MemoryDelta } from "../../src/bot/record.js";
import {
	applyMemoryDelta,
	reconcileRing,
	replay,
} from "../../src/bot/record.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	MAX_RING_TURNS,
	type MemoryEntry,
	type Turn,
} from "../../src/bot/schema.js";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { allowAllAuthorizerFactory, waitFor } from "../rob/helpers.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

// T0: status-quo snapshots of the bot ledger, taken before the context and
// learning work so a later change that alters them is caught here first.

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_00000000000000000000000000000001",
		at: 1000,
		kind: "fact",
		text: "a fact",
		source: { sessionId: null, turnSeq: 0 },
		supersedes: [],
		...overrides,
	};
}

function turn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: "trn_00000000000000000000000000000001",
		seq: 1,
		sessionId: "chs_0000000000000001",
		workspaceRoot: "/ws/a",
		at: 1000,
		wake: "user",
		messages: [{ role: "user", content: "hello" }],
		...overrides,
	};
}

function record(overrides: Partial<BotRecord> = {}): BotRecord {
	return {
		version: BOT_RECORD_VERSION,
		bot: "atlas",
		role: "helper",
		model: "deepseek-flash",
		createdAt: 0,
		updatedAt: 0,
		seq: 0,
		usage: { input: 0, output: 0 },
		memory: [],
		sessionTitles: {},
		turns: [],
		...overrides,
	};
}

describe("bot ledger baseline", () => {
	it("digests an evicted turn to its first user text and drops the rest", () => {
		const rich = turn({
			id: "trn_000000000000000000000000000000aa",
			seq: 1,
			messages: [
				{ role: "user", content: "short ask" },
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "decision: use the ledger; artifact docs/x.md",
						},
					],
				},
			],
		});
		const rest = Array.from({ length: MAX_RING_TURNS - 1 }, (_, i) =>
			turn({
				id: `trn_${(i + 1).toString(16).padStart(32, "0")}`,
				seq: i + 2,
			}),
		);
		const next = turn({
			id: "trn_000000000000000000000000000000ff",
			seq: MAX_RING_TURNS + 1,
		});

		const result = reconcileRing(record({ turns: [rich, ...rest] }), next);

		// The evicted turn keeps only its first user line; the decision and the
		// artifact path are lost. This is the coarseness T8 targets.
		expect(result.digest?.text).toBe("short ask");
	});

	it("converges byte-equal when the same delta is applied twice", () => {
		const delta: MemoryDelta = {
			upsert: [memoryEntry({ text: "learned once" })],
			drop: [],
		};
		const once = applyMemoryDelta(record().memory, delta);
		if (!once.ok) throw new Error(once.error);
		const twice = applyMemoryDelta(once.memory, delta);
		if (!twice.ok) throw new Error(twice.error);

		expect(JSON.stringify(twice.memory)).toBe(JSON.stringify(once.memory));
	});

	it("replays only the requested workspace and session, in seq order", () => {
		const turns = [
			turn({
				id: "trn_00000000000000000000000000000002",
				seq: 2,
				messages: [{ role: "user", content: "b" }],
			}),
			turn({
				id: "trn_00000000000000000000000000000001",
				seq: 1,
				messages: [{ role: "user", content: "a" }],
			}),
			turn({
				id: "trn_00000000000000000000000000000003",
				seq: 3,
				workspaceRoot: "/ws/other",
				messages: [{ role: "user", content: "c" }],
			}),
			turn({
				id: "trn_00000000000000000000000000000004",
				seq: 4,
				sessionId: "chs_0000000000000002",
				messages: [{ role: "user", content: "d" }],
			}),
		];

		const messages = replay(turns, "/ws/a", "chs_0000000000000001");

		expect(messages.map((m) => m.content)).toEqual(["a", "b"]);
	});

	it("passes the whole accumulated history each turn, with no compaction today", async () => {
		const workspace = await makeWorkspace("my-agent-baseline-");
		try {
			const provider = createMockProvider([
				[
					{ type: "text_delta", text: "one" },
					{ type: "finish", reason: "stop" },
				],
				[
					{ type: "text_delta", text: "two" },
					{ type: "finish", reason: "stop" },
				],
			]);
			const team = new Team({
				robs: [{ name: "planner", role: "coordinate" }],
				defaultModel: "deepseek-flash",
				providerFactory: () => provider,
				workspaceRoot: workspace,
				authorizerFactory: allowAllAuthorizerFactory(),
			});
			team.start();
			team.dispatch("planner", "first question");
			await waitFor(() => provider.requests.length === 1, "turn one", 10_000);
			await waitFor(
				() => team.statuses().every((s) => s.status === "idle"),
				"idle after turn one",
				10_000,
			);

			team.dispatch("planner", "second question");
			await waitFor(() => provider.requests.length === 2, "turn two", 10_000);

			const second = provider.requests[1].messages;
			expect(
				second.some(
					(m) =>
						m.role === "user" && String(m.content).includes("first question"),
				),
			).toBe(true);

			await team.stop();
		} finally {
			await removeWorkspace(workspace);
		}
	}, 20_000);
});
