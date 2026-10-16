import { describe, expect, it } from "vitest";
import { applyMemoryDelta, reconcileRing } from "../../src/bot/record.js";
import { retrieve } from "../../src/bot/retrieve.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	type Turn,
} from "../../src/bot/schema.js";

type StoredMemory = BotRecord["memory"][number];

function memoryEntry(overrides: Partial<StoredMemory> = {}): StoredMemory {
	return {
		id: "mem_00000000000000000000000000000001",
		at: 1000,
		kind: "fact",
		text: "a fact",
		source: { sessionId: null, turnSeq: 0 },
		supersedes: [],
		uses: 0,
		lastUsedAt: 0,
		confidence: 0.5,
		...overrides,
	};
}

function turnId(seq: number): string {
	return `trn_${seq.toString(16).padStart(32, "0")}`;
}

function turn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: turnId(1),
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

// Writes one entry the way an explicit remember does.
function withEntry(base: BotRecord, entry: StoredMemory): BotRecord {
	const applied = applyMemoryDelta(base.memory, { upsert: [entry], drop: [] });
	if (!applied.ok) throw new Error(applied.error);
	// applyMemoryDelta returns the input entry shape; a loaded record's memory is
	// the strict parsed shape. Fixtures normalize by hand (T4 split the types).
	return { ...base, memory: applied.memory as BotRecord["memory"] };
}

// Appends one turn the way the store does: the ring keeps the newest turns and
// every evicted turn leaves one digest behind in memory.
function append(base: BotRecord, next: Turn): BotRecord {
	const ring = reconcileRing(base, next);
	if (ring.digest === null) return { ...base, turns: ring.turns };
	const applied = applyMemoryDelta(base.memory, {
		upsert: [ring.digest],
		drop: [],
	});
	if (!applied.ok) throw new Error(applied.error);
	return {
		...base,
		turns: ring.turns,
		memory: applied.memory as BotRecord["memory"],
	};
}

describe("retrieve", () => {
	it("returns a fact that left the recent window for a matching inbound", () => {
		const fact = memoryEntry({
			id: "mem_000000000000000000000000000000fa",
			at: 1000,
			kind: "fact",
			text: "the deploy target is the staging cluster",
		});
		let bot = withEntry(record(), fact);
		for (let seq = 1; seq <= 100; seq++) {
			bot = append(
				bot,
				turn({
					id: turnId(seq),
					seq,
					at: 1000 + seq,
					messages: [{ role: "user", content: `chatter number ${seq}` }],
				}),
			);
		}

		// The fact is far older than every turn still in the ring, yet it is
		// still the top hit because retrieval scores memory, not the window.
		expect(bot.turns).toHaveLength(24);
		expect(
			bot.turns.some(
				(existing) =>
					String(existing.messages[0]?.content) === "chatter number 1",
			),
		).toBe(false);

		const result = retrieve({
			record: bot,
			query: ["what is the deploy target?"],
			limit: 5,
		});

		expect(result[0]?.id).toBe(fact.id);
	});

	it("returns an evicted turn's digest for a matching inbound", () => {
		let bot = withEntry(
			record(),
			memoryEntry({
				id: "mem_0000000000000000000000000000000a",
				at: 1000,
				kind: "fact",
				text: "unrelated note about colors",
			}),
		);
		bot = append(
			bot,
			turn({
				id: turnId(1),
				seq: 1,
				at: 1001,
				messages: [{ role: "user", content: "how do we roll back the hotfix" }],
			}),
		);
		for (let seq = 2; seq <= 25; seq++) {
			bot = append(
				bot,
				turn({
					id: turnId(seq),
					seq,
					at: 1000 + seq,
					messages: [{ role: "user", content: `noise ${seq}` }],
				}),
			);
		}

		const digest = bot.memory.find((entry) => entry.kind === "digest");
		expect(digest?.text).toBe("how do we roll back the hotfix");

		const result = retrieve({
			record: bot,
			query: ["roll back the hotfix"],
			limit: 5,
		});

		// The digest wins on relevance despite its lowest kind weight, ahead of
		// the non-matching fact that outranks it on kind alone.
		expect(result[0]?.id).toBe(digest?.id);
	});

	it("ranks a matching commitment above a matching digest at the same age", () => {
		const commitment = memoryEntry({
			id: "mem_000000000000000000000000000000c1",
			at: 5000,
			kind: "commitment",
			text: "ship the release on friday",
		});
		const digest = memoryEntry({
			id: "mem_000000000000000000000000000000d1",
			at: 5000,
			kind: "digest",
			text: "ship the release on friday",
		});

		const result = retrieve({
			record: record({ memory: [digest, commitment] }),
			query: ["when do we ship the release"],
			limit: 5,
		});

		expect(result.map((entry) => entry.id)).toEqual([commitment.id, digest.id]);
	});

	it("ranks the newer entry first when relevance and kind tie", () => {
		const older = memoryEntry({
			id: "mem_00000000000000000000000000000001",
			at: 1000,
			kind: "fact",
			text: "the build runs on linux",
		});
		const newer = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			at: 9000,
			kind: "fact",
			text: "the build runs on linux",
		});

		const result = retrieve({
			record: record({ memory: [older, newer] }),
			query: ["build on linux"],
			limit: 5,
		});

		expect(result.map((entry) => entry.id)).toEqual([newer.id, older.id]);
	});

	it("excludes a superseded entry even when it matches the query", () => {
		const old = memoryEntry({
			id: "mem_00000000000000000000000000000001",
			at: 1000,
			kind: "fact",
			text: "the deploy target is staging",
		});
		const replacement = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			at: 2000,
			kind: "fact",
			text: "the deploy target is production",
			supersedes: ["mem_00000000000000000000000000000001"],
		});

		const result = retrieve({
			record: record({ memory: [old, replacement] }),
			query: ["deploy target"],
			limit: 5,
		});

		expect(result.map((entry) => entry.id)).toEqual([replacement.id]);
	});

	it("ranks a matching older entry above a newer non-matching one", () => {
		const match = memoryEntry({
			id: "mem_00000000000000000000000000000001",
			at: 1000,
			kind: "fact",
			text: "the api key lives in the vault",
		});
		const newer = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			at: 9999,
			kind: "commitment",
			text: "water the plants every monday",
		});

		const result = retrieve({
			record: record({ memory: [newer, match] }),
			query: ["where is the api key"],
			limit: 5,
		});

		expect(result[0]?.id).toBe(match.id);
	});

	it("matches a file path as a whole rather than its pieces", () => {
		const pathEntry = memoryEntry({
			id: "mem_00000000000000000000000000000001",
			at: 1000,
			kind: "fact",
			text: "the loader is src/bot/retrieve.ts",
		});
		const wordEntry = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			at: 9000,
			kind: "commitment",
			text: "the loader caches the config",
		});

		const result = retrieve({
			record: record({ memory: [wordEntry, pathEntry] }),
			query: ["src/bot/retrieve.ts"],
			limit: 5,
		});

		expect(result[0]?.id).toBe(pathEntry.id);
	});

	it("matches a bare filename against a stored path", () => {
		const pathEntry = memoryEntry({
			id: "mem_00000000000000000000000000000001",
			at: 1000,
			kind: "fact",
			text: "edited src/bot/retrieve.ts",
		});
		const distractor = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			at: 9000,
			kind: "commitment",
			text: "review the onboarding doc",
		});

		const result = retrieve({
			record: record({ memory: [distractor, pathEntry] }),
			query: ["retrieve.ts"],
			limit: 5,
		});

		expect(result[0]?.id).toBe(pathEntry.id);
	});

	it("orders by kind, then recency, then id when the query has no tokens", () => {
		const digest = memoryEntry({
			id: "mem_0000000000000000000000000000000d",
			at: 9000,
			kind: "digest",
			text: "digest",
		});
		const fact = memoryEntry({
			id: "mem_0000000000000000000000000000000f",
			at: 1000,
			kind: "fact",
			text: "fact",
		});
		const commitment = memoryEntry({
			id: "mem_0000000000000000000000000000000c",
			at: 1000,
			kind: "commitment",
			text: "commitment",
		});

		const result = retrieve({
			record: record({ memory: [digest, fact, commitment] }),
			query: [],
			limit: 5,
		});

		expect(result.map((entry) => entry.id)).toEqual([
			commitment.id,
			fact.id,
			digest.id,
		]);
	});

	it("is deterministic and breaks ties by id", () => {
		const a = memoryEntry({
			id: "mem_0000000000000000000000000000000a",
			at: 1000,
			kind: "fact",
			text: "same text here",
		});
		const b = memoryEntry({
			id: "mem_0000000000000000000000000000000b",
			at: 1000,
			kind: "fact",
			text: "same text here",
		});
		const input = {
			record: record({ memory: [b, a] }),
			query: ["same text"],
			limit: 5,
		};

		const first = retrieve(input);
		const second = retrieve(input);

		expect(first.map((entry) => entry.id)).toEqual([a.id, b.id]);
		expect(second.map((entry) => entry.id)).toEqual(
			first.map((entry) => entry.id),
		);
	});

	it("caps the result at the limit", () => {
		const memory = Array.from({ length: 4 }, (_, index) =>
			memoryEntry({
				id: `mem_${(index + 1).toString(16).padStart(4, "0")}`,
				at: index,
				text: `entry ${index}`,
			}),
		);

		const two = retrieve({
			record: record({ memory }),
			query: ["entry"],
			limit: 2,
		});
		const none = retrieve({
			record: record({ memory }),
			query: ["entry"],
			limit: 0,
		});

		expect(two.map((entry) => entry.id)).toEqual(["mem_0004", "mem_0003"]);
		expect(none).toEqual([]);
	});
});
