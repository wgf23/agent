import { z } from "zod";
import { robNameSchema } from "../rob/types.js";
import { messageSchema } from "../session/store.js";

export const BOT_RECORD_VERSION = 1;

export const MAX_MEMORY_ENTRIES = 128;
export const MAX_MEMORY_CHARS = 24_000;
export const MAX_RING_TURNS = 24;
export const MAX_MEMORY_TEXT = 2_000;

const memoryIdSchema = z.string().regex(/^mem_[0-9a-f]+$/);
const turnIdSchema = z.string().regex(/^trn_[0-9a-f]+$/);

// The ledger is interval-driven only for now; a manual rule means no timer.
export const wakeRuleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("manual") }).strict(),
	z
		.object({
			kind: z.literal("interval"),
			everyMs: z.number().int().min(1000),
		})
		.strict(),
]);
export type WakeRule = z.infer<typeof wakeRuleSchema>;

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
	})
	.strict();
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const turnSchema = z
	.object({
		id: turnIdSchema,
		seq: z.number().int().positive(),
		sessionId: z.string(),
		workspaceRoot: z.string(),
		at: z.number(),
		wake: z.enum(["user", "dm", "subagent_result", "interval"]),
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
		turns: z.array(turnSchema),
		wakeRule: wakeRuleSchema,
	})
	.strict();
export type BotRecord = z.infer<typeof botRecordSchema>;
