import { describe, expect, it } from "vitest";
import {
	applyMemoryDelta,
	emptyDelta,
	reconcileRing,
	renderMemory,
	replay,
} from "../../src/bot/record.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	MAX_MEMORY_ENTRIES,
	MAX_RING_TURNS,
	type MemoryEntry,
	type Turn,
} from "../../src/bot/schema.js";

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
		sessionId: "ses_a",
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
		turns: [],
		wakeRule: { kind: "manual" },
		...overrides,
	};
}

describe("applyMemoryDelta", () => {
	it("is idempotent when the same delta is applied twice", () => {
		const before = [memoryEntry({ id: "mem_0a", at: 1, text: "old" })];
		const delta = {
			upsert: [memoryEntry({ id: "mem_0b", at: 2, text: "new" })],
			drop: [],
		};

		const first = applyMemoryDelta(before, delta);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = applyMemoryDelta(first.memory, delta);

		expect(second).toEqual(first);
	});

	it("drops by id as a set difference", () => {
		const memory = [
			memoryEntry({ id: "mem_0a" }),
			memoryEntry({ id: "mem_0b" }),
		];

		const result = applyMemoryDelta(memory, { upsert: [], drop: ["mem_0a"] });

		expect(result).toEqual({ ok: true, memory: [memory[1]] });
	});

	it("evicts the oldest digest when the entries cap is exceeded", () => {
		const fact = memoryEntry({ id: "mem_0001", at: 0, kind: "fact" });
		const digests = Array.from({ length: MAX_MEMORY_ENTRIES - 1 }, (_, index) =>
			memoryEntry({
				id: `mem_${(index + 2).toString(16).padStart(4, "0")}`,
				at: index + 1,
				kind: "digest",
				text: `digest ${index}`,
			}),
		);
		const oldest = digests[0];
		const fresh = memoryEntry({
			id: "mem_ffff",
			at: 10_000,
			kind: "digest",
			text: "fresh",
		});

		const result = applyMemoryDelta([fact, ...digests], {
			upsert: [fresh],
			drop: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.memory).toHaveLength(MAX_MEMORY_ENTRIES);
		expect(result.memory.some((entry) => entry.id === fact.id)).toBe(true);
		expect(result.memory.some((entry) => entry.id === oldest.id)).toBe(false);
		expect(result.memory.some((entry) => entry.id === fresh.id)).toBe(true);
	});

	it("fails when the cap is exceeded and nothing is evictable", () => {
		const pinned = Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) =>
			memoryEntry({
				id: `mem_${(index + 1).toString(16).padStart(4, "0")}`,
				at: index,
				kind: "fact",
			}),
		);
		const fresh = memoryEntry({ id: "mem_ffff", at: 10_000, kind: "fact" });

		const result = applyMemoryDelta(pinned, { upsert: [fresh], drop: [] });

		expect(result.ok).toBe(false);
	});
});

describe("emptyDelta", () => {
	it("builds an empty upsert and drop", () => {
		expect(emptyDelta()).toEqual({ upsert: [], drop: [] });
	});
});

describe("reconcileRing", () => {
	it("appends below the cap without a digest", () => {
		const result = reconcileRing(
			record({ turns: [turn()] }),
			turn({ id: "trn_00000000000000000000000000000002", seq: 2 }),
		);

		expect(result.turns).toHaveLength(2);
		expect(result.digest).toBeNull();
	});

	it("drops the oldest turn and emits one digest at the cap", () => {
		const turns = Array.from({ length: MAX_RING_TURNS }, (_, index) =>
			turn({
				id: `trn_${(index + 1).toString(16).padStart(32, "0")}`,
				seq: index + 1,
				at: index + 1,
			}),
		);
		const added = turn({
			id: `trn_${"f".repeat(32)}`,
			seq: MAX_RING_TURNS + 1,
			at: 99,
		});

		const result = reconcileRing(record({ turns }), added);

		expect(result.turns).toHaveLength(MAX_RING_TURNS);
		expect(result.turns[0].id).toBe(turns[1].id);
		expect(result.digest).toEqual({
			id: `mem_${turns[0].id.slice("trn_".length)}`,
			at: turns[0].at,
			kind: "digest",
			text: "hello",
			source: { sessionId: turns[0].sessionId, turnSeq: turns[0].seq },
			supersedes: [],
		});
	});

	it("ignores a turn already in the ring", () => {
		const existing = turn();
		const result = reconcileRing(record({ turns: [existing] }), existing);

		expect(result).toEqual({ turns: [existing], digest: null });
	});
});

describe("renderMemory", () => {
	it("hides an entry a newer entry supersedes", () => {
		const older = memoryEntry({ id: "mem_0a", at: 1, text: "old fact" });
		const newer = memoryEntry({
			id: "mem_0b",
			at: 2,
			kind: "preference",
			text: "new fact",
			supersedes: ["mem_0a"],
		});

		expect(renderMemory([older, newer])).toBe("preference: new fact");
	});

	it("renders visible entries newest first", () => {
		const older = memoryEntry({ id: "mem_0a", at: 1, text: "older" });
		const newer = memoryEntry({ id: "mem_0b", at: 2, text: "newer" });

		expect(renderMemory([older, newer])).toBe("fact: newer\nfact: older");
	});
});

describe("replay", () => {
	it("returns only the requested workspace and session in seq order", () => {
		const turns = [
			turn({
				id: "trn_03",
				seq: 3,
				sessionId: "ses_a",
				workspaceRoot: "/ws/a",
				messages: [{ role: "user", content: "three" }],
			}),
			turn({
				id: "trn_01",
				seq: 1,
				sessionId: "ses_a",
				workspaceRoot: "/ws/a",
				messages: [{ role: "user", content: "one" }],
			}),
			turn({
				id: "trn_02",
				seq: 2,
				sessionId: "ses_b",
				workspaceRoot: "/ws/a",
				messages: [{ role: "user", content: "two-b" }],
			}),
			turn({
				id: "trn_04",
				seq: 4,
				sessionId: "ses_a",
				workspaceRoot: "/ws/other",
				messages: [{ role: "user", content: "other-ws" }],
			}),
		];

		expect(replay(turns, "/ws/a")).toEqual([
			{ role: "user", content: "one" },
			{ role: "user", content: "two-b" },
			{ role: "user", content: "three" },
		]);
		expect(replay(turns, "/ws/a", "ses_a")).toEqual([
			{ role: "user", content: "one" },
			{ role: "user", content: "three" },
		]);
	});
});
