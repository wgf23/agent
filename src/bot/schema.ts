import { z } from "zod";
import { robNameSchema } from "../rob/types.js";
import { messageSchema } from "../session/store.js";

export const BOT_RECORD_VERSION = 2;

export const DEFAULT_MEMORY_CONFIDENCE = 0.5;

export const MAX_MEMORY_ENTRIES = 128;
export const MAX_MEMORY_CHARS = 24_000;
export const MAX_RING_TURNS = 24;
export const MAX_MEMORY_TEXT = 2_000;
export const MAX_SESSION_TITLE = 120;

const memoryIdSchema = z.string().regex(/^mem_[0-9a-f]+$/);
const turnIdSchema = z.string().regex(/^trn_[0-9a-f]+$/);
const sessionTitleSchema = z.string().min(1).max(MAX_SESSION_TITLE);

export const threadSummarySchema = z
	.object({
		summary: z.string(),
		summaryAt: z.number(),
	})
	.strict();
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const memoryEntrySchema = z
	.object({
		id: memoryIdSchema,
		at: z.number(),
		kind: z.enum(["fact", "preference", "commitment", "digest"]),
		text: z.string().min(1).max(MAX_MEMORY_TEXT),
		source: z
			.object({
				sessionId: z.string().nullable(),
				turnSeq: z.number().int().min(0),
			})
			.strict(),
		supersedes: z.array(memoryIdSchema),
		// Added in v2. Defaulted so an entry written by v1 parses unchanged.
		uses: z.number().int().min(0).default(0),
		lastUsedAt: z.number().int().min(0).default(0),
		confidence: z.number().min(0).max(1).default(DEFAULT_MEMORY_CONFIDENCE),
	})
	.strict();
// The input shape, so an entry built without the v2 learning fields (memory
// tools, digestFor) is still a valid MemoryEntry and parse applies the
// defaults. A parsed or on-disk entry always carries all three.
export type MemoryEntry = z.input<typeof memoryEntrySchema>;

export const turnSchema = z
	.object({
		id: turnIdSchema,
		seq: z.number().int().positive(),
		sessionId: z.string(),
		workspaceRoot: z.string(),
		at: z.number(),
		// "room" is this branch's fourth inbound kind on top of the source's
		// three; a room turn is recorded like any other wake.
		wake: z.enum(["user", "dm", "subagent_result", "interval", "room"]),
		messages: z.array(messageSchema),
	})
	.strict();
export type Turn = z.infer<typeof turnSchema>;

export const botRecordSchema = z
	.object({
		version: z.literal(BOT_RECORD_VERSION),
		bot: robNameSchema,
		role: z.string(),
		model: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
		seq: z.number().int().min(0),
		usage: z.object({ input: z.number(), output: z.number() }).strict(),
		memory: z.array(memoryEntrySchema),
		// Optional and defaulted so a record written before titles existed still
		// parses; adding it does not bump BOT_RECORD_VERSION.
		sessionTitles: z.record(z.string(), sessionTitleSchema).default({}),
		// Added in v2: one rolling summary per thread id. Defaulted so a v1
		// record parses and migration keeps it explicit on disk.
		threads: z.record(z.string(), threadSummarySchema).default({}),
		turns: z.array(turnSchema),
	})
	.strict();
type ParsedBotRecord = z.infer<typeof botRecordSchema>;
// `threads` is optional in the type so a caller that only bootstraps a fresh
// record (the rob's own empty record) need not know about it; every parsed or
// on-disk record carries it because the schema defaults it and load migrates.
export type BotRecord = Omit<ParsedBotRecord, "threads"> & {
	threads?: ParsedBotRecord["threads"];
};

// The version this build writes and the only version migrateRecord upgrades.
export const MIGRATABLE_BOT_RECORD_VERSION = 1;

// Upgrades a v1 record in place to the v2 shape by filling the fields added in
// v2. A record of any other version is returned untouched so botRecordSchema
// rejects an unknown or malformed version rather than silently accepting it.
export function migrateRecord(raw: unknown): unknown {
	if (!isPlainObject(raw) || raw.version !== MIGRATABLE_BOT_RECORD_VERSION) {
		return raw;
	}
	return {
		...raw,
		version: BOT_RECORD_VERSION,
		memory: Array.isArray(raw.memory)
			? raw.memory.map(migrateMemoryEntry)
			: raw.memory,
		threads: isPlainObject(raw.threads) ? raw.threads : {},
	};
}

function migrateMemoryEntry(entry: unknown): unknown {
	if (!isPlainObject(entry)) return entry;
	return {
		...entry,
		uses: entry.uses ?? 0,
		lastUsedAt: entry.lastUsedAt ?? 0,
		confidence: entry.confidence ?? DEFAULT_MEMORY_CONFIDENCE,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
