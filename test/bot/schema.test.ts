import { describe, expect, it } from "vitest";
import {
	BOT_RECORD_VERSION,
	botRecordSchema,
	DEFAULT_MEMORY_CONFIDENCE,
	memoryEntrySchema,
	migrateRecord,
} from "../../src/bot/schema.js";

// A memory entry exactly as v1 wrote it: no learning fields.
const v1Entry = {
	id: "mem_00000000000000000000000000000001",
	at: 1710000000000,
	kind: "fact",
	text: "likes mangoes",
	source: { sessionId: "ses_a", turnSeq: 1 },
	supersedes: [],
};

const v2Entry = {
	...v1Entry,
	uses: 3,
	lastUsedAt: 1710000000001,
	confidence: 0.9,
};

// A whole record exactly as v1 wrote it on disk.
const v1Record = {
	version: 1,
	bot: "atlas",
	role: "helper",
	model: "deepseek-flash",
	createdAt: 1710000000000,
	updatedAt: 1710000000000,
	seq: 1,
	usage: { input: 11, output: 22 },
	memory: [v1Entry],
	sessionTitles: { ses_a: "First chat" },
	turns: [],
};

describe("MemoryEntry v2 fields", () => {
	it("defaults uses, lastUsedAt, and confidence for a v1 entry", () => {
		const parsed = memoryEntrySchema.safeParse(v1Entry);

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toEqual({
			id: "mem_00000000000000000000000000000001",
			at: 1710000000000,
			kind: "fact",
			text: "likes mangoes",
			source: { sessionId: "ses_a", turnSeq: 1 },
			supersedes: [],
			uses: 0,
			lastUsedAt: 0,
			confidence: DEFAULT_MEMORY_CONFIDENCE,
		});
	});

	it("keeps explicitly set learning fields", () => {
		const parsed = memoryEntrySchema.safeParse(v2Entry);

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.uses).toBe(3);
		expect(parsed.data.lastUsedAt).toBe(1710000000001);
		expect(parsed.data.confidence).toBe(0.9);
	});

	it("rejects out-of-range and non-integer learning fields", () => {
		expect(
			memoryEntrySchema.safeParse({ ...v1Entry, confidence: 1.1 }).success,
		).toBe(false);
		expect(
			memoryEntrySchema.safeParse({ ...v1Entry, confidence: -0.1 }).success,
		).toBe(false);
		expect(memoryEntrySchema.safeParse({ ...v1Entry, uses: -1 }).success).toBe(
			false,
		);
		expect(memoryEntrySchema.safeParse({ ...v1Entry, uses: 1.5 }).success).toBe(
			false,
		);
		expect(
			memoryEntrySchema.safeParse({ ...v1Entry, lastUsedAt: -1 }).success,
		).toBe(false);
	});

	it("still rejects an unknown key", () => {
		const parsed = memoryEntrySchema.safeParse({ ...v1Entry, pinned: true });

		expect(parsed.success).toBe(false);
	});
});

describe("migrateRecord", () => {
	it("upgrades a v1 record to v2 with defaulted memory and empty threads", () => {
		const migrated = migrateRecord(v1Record);

		expect(migrated).toEqual({
			version: 2,
			bot: "atlas",
			role: "helper",
			model: "deepseek-flash",
			createdAt: 1710000000000,
			updatedAt: 1710000000000,
			seq: 1,
			usage: { input: 11, output: 22 },
			memory: [
				{
					...v1Entry,
					uses: 0,
					lastUsedAt: 0,
					confidence: DEFAULT_MEMORY_CONFIDENCE,
				},
			],
			sessionTitles: { ses_a: "First chat" },
			threads: {},
			turns: [],
		});
	});

	it("leaves a v2 record untouched so an invalid one is still rejected", () => {
		const invalid = {
			...v1Record,
			version: 2,
			memory: [{ ...v1Entry, confidence: 2 }],
		};

		expect(migrateRecord(invalid)).toBe(invalid);
		expect(botRecordSchema.safeParse(migrateRecord(invalid)).success).toBe(
			false,
		);
	});

	it("round-trips a valid v2 record through the schema", () => {
		const record = {
			...v1Record,
			version: BOT_RECORD_VERSION,
			memory: [v2Entry],
			threads: { ses_a: { summary: "talked about mangoes", summaryAt: 42 } },
		};

		const parsed = botRecordSchema.safeParse(migrateRecord(record));

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toEqual(record);
	});
});

describe("botRecordSchema threads", () => {
	it("defaults threads to {} when the key is absent", () => {
		const parsed = botRecordSchema.safeParse({
			...v1Record,
			version: BOT_RECORD_VERSION,
			memory: [v2Entry],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.threads).toEqual({});
	});

	it("rejects a summary with an unknown key", () => {
		const parsed = botRecordSchema.safeParse({
			...v1Record,
			version: BOT_RECORD_VERSION,
			memory: [v2Entry],
			threads: { ses_a: { summary: "x", summaryAt: 1, extra: true } },
		});

		expect(parsed.success).toBe(false);
	});
});
