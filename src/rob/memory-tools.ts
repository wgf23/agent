import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MemoryDelta } from "../bot/record.js";
import { MAX_MEMORY_TEXT, type MemoryEntry } from "../bot/schema.js";
import type { Tool } from "../tools/types.js";
import type { RobName } from "./types.js";

// Digest entries are the mechanical record of evicted turns, so a model may only
// write the three semantic kinds.
const memoryKindSchema = z.enum(["fact", "preference", "commitment"]);
const memoryIdSchema = z.string().regex(/^mem_[0-9a-f]+$/);

const rememberSchema = z
	.object({
		text: z.string().min(1).max(MAX_MEMORY_TEXT),
		kind: memoryKindSchema.optional(),
		supersedes: z.array(memoryIdSchema).optional(),
	})
	.strict();

const forgetSchema = z.object({ id: memoryIdSchema }).strict();

export interface MemoryToolInput {
	name: RobName;
	delta: MemoryDelta;
	clock: () => number;
}

// remember and forget only mutate the rob's own memory delta, never the
// filesystem, so they are the only non-read-only tools that do not need
// approval. Their allow rules live in robToolRules().
export function createMemoryTools(input: MemoryToolInput): Tool[] {
	return [
		{
			name: "remember",
			description:
				"Persist one durable fact, preference, or commitment to your long-term memory. Use supersedes to hide an older entry you are replacing.",
			schema: rememberSchema,
			readOnly: false,
			async execute(args: z.infer<typeof rememberSchema>) {
				const entry: MemoryEntry = {
					id: `mem_${randomBytes(8).toString("hex")}`,
					at: input.clock(),
					kind: args.kind ?? "fact",
					text: args.text,
					source: { sessionId: null, turnSeq: 0 },
					supersedes: args.supersedes ?? [],
				};
				input.delta.upsert.push(entry);
				return { ok: true, output: `Remembered as ${entry.id}.` };
			},
		},
		{
			name: "forget",
			description: "Drop one entry from your long-term memory by its id.",
			schema: forgetSchema,
			readOnly: false,
			async execute(args: z.infer<typeof forgetSchema>) {
				input.delta.drop.push(args.id);
				return { ok: true, output: `Forgot ${args.id}.` };
			},
		},
	];
}
