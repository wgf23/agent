import { z } from "zod";
import type {
	ContentBlock,
	Message,
	Provider,
	ProviderRequest,
} from "../providers/types.js";
import type { ThreadView } from "./context.js";
import { emptyDelta, type MemoryDelta } from "./record.js";
import { MAX_MEMORY_TEXT, type MemoryEntry, type Turn } from "./schema.js";

// T1 freezes these signatures. T6 implements consolidate against them.

export interface ConsolidateDeps {
	provider: Provider;
	model: string;
	clock: () => number;
}

export interface ConsolidationResult {
	// Applied through the same applyMemoryDelta path as an explicit remember.
	delta: MemoryDelta;
	// The thread's rolling summary after this turn, if the thread changed.
	threadSummary: string;
	// Learned procedures, promoted to reusable by a later stage.
	skillCandidates: string[];
}

export type Consolidate = (
	turn: Turn,
	thread: ThreadView,
) => Promise<ConsolidationResult>;

// Consolidation is a side channel into pinned memory, which applyMemoryDelta
// may never evict, so every product is capped. A small model cannot flood the
// ledger through reflection.
const MAX_UPSERTS = 8;
const MAX_SKILL_CANDIDATES = 4;
const MAX_SUMMARY_CHARS = 600;
const MAX_TURN_PROMPT_CHARS = 8_000;
const MAX_THREAD_PROMPT_CHARS = 1_000;
const MAX_MESSAGE_PROMPT_CHARS = 1_200;

const SYSTEM_PROMPT = [
	"You consolidate one finished bot turn into durable memory.",
	"Reply with a single JSON object and nothing else, no tool calls.",
	'Shape: {"memory":[{"kind":"fact"|"preference"|"commitment","text":"..."}],"summary":"...","skills":["..."]}',
	"fact: a stable truth about the codebase, environment, or user.",
	"preference: how the user wants things done.",
	"commitment: something the user or assistant agreed to do.",
	"Skip transient or already-known details; an empty list is fine.",
	`summary: the thread's rolling summary, under ${MAX_SUMMARY_CHARS} characters.`,
	`At most ${MAX_UPSERTS} memory items and ${MAX_SKILL_CANDIDATES} skills.`,
].join("\n");

// The model output is untyped until parsed, and one malformed item must not
// discard the rest, so the envelope is loose and each item is validated alone.
const memoryItemSchema = z.object({
	kind: z.enum(["fact", "preference", "commitment"]),
	text: z.string().min(1),
});

const outputSchema = z.object({
	memory: z.array(z.unknown()).default([]),
	summary: z.string().default(""),
	skills: z.array(z.unknown()).default([]),
});

export function consolidate(deps: ConsolidateDeps): Consolidate {
	return async (turn, thread) => {
		try {
			const text = await reflect(deps, turn, thread);
			if (text === undefined) return emptyResult();
			const output = parseOutput(text);
			if (output === undefined) return emptyResult();
			return toResult(output, turn, thread, turn.at);
		} catch {
			// Reflection is best effort; a failed side channel never blocks the turn.
			return emptyResult();
		}
	};
}

async function reflect(
	deps: ConsolidateDeps,
	turn: Turn,
	thread: ThreadView,
): Promise<string | undefined> {
	const request: ProviderRequest = {
		model: deps.model,
		messages: buildPrompt(turn, thread),
		tools: [],
	};

	let text = "";
	let failure: string | undefined;
	try {
		for await (const event of deps.provider.stream(request)) {
			if (event.type === "text_delta") text += event.text;
			else if (event.type === "error") failure = event.message;
		}
	} catch {
		return undefined;
	}
	if (failure !== undefined) return undefined;
	return text;
}

function buildPrompt(turn: Turn, thread: ThreadView): Message[] {
	const summary =
		clip(thread.summary.trim(), MAX_THREAD_PROMPT_CHARS) || "(none)";
	const transcript = clip(
		turn.messages.map(messageToLine).join("\n"),
		MAX_TURN_PROMPT_CHARS,
	);
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: `Thread summary:\n${summary}\n\nCompleted turn ${turn.seq} (wake ${turn.wake}):\n${transcript}`,
		},
	];
}

function messageToLine(message: Message): string {
	if (message.role === "assistant") {
		const parts = message.content.map(blockText).filter((part) => part !== "");
		return `assistant: ${clip(parts.join(" "), MAX_MESSAGE_PROMPT_CHARS)}`;
	}
	return `${message.role}: ${clip(message.content, MAX_MESSAGE_PROMPT_CHARS)}`;
}

function blockText(block: ContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "tool_call":
			return `[tool_call ${block.name}]`;
		case "reasoning":
			return "";
	}
}

function parseOutput(text: string): z.infer<typeof outputSchema> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	const parsed = outputSchema.safeParse(raw);
	if (!parsed.success) return undefined;
	return parsed.data;
}

function toResult(
	output: z.infer<typeof outputSchema>,
	turn: Turn,
	thread: ThreadView,
	at: number,
): ConsolidationResult {
	const turnKey = turn.id.slice("trn_".length);
	const upserts: MemoryEntry[] = [];
	for (const item of output.memory) {
		if (upserts.length >= MAX_UPSERTS) break;
		const parsed = memoryItemSchema.safeParse(item);
		if (!parsed.success) continue;
		const text = parsed.data.text.trim().slice(0, MAX_MEMORY_TEXT);
		if (text === "") continue;
		upserts.push({
			// Derived from the turn id and the item's kept position, so the same
			// turn always consolidates to the same entries and repeats converge.
			id: `mem_${turnKey}${upserts.length.toString(16).padStart(2, "0")}`,
			at,
			kind: parsed.data.kind,
			text,
			source: { sessionId: turn.sessionId, turnSeq: turn.seq },
			supersedes: [],
		});
	}

	const skills = output.skills
		.map((skill) => (typeof skill === "string" ? skill.trim() : ""))
		.filter((skill) => skill !== "")
		.slice(0, MAX_SKILL_CANDIDATES);

	const reflected = output.summary.trim();
	const summary = reflected === "" ? thread.summary.trim() : reflected;

	return {
		delta: { upsert: upserts, drop: [] },
		threadSummary: summary.slice(0, MAX_SUMMARY_CHARS),
		skillCandidates: skills,
	};
}

function emptyResult(): ConsolidationResult {
	return { delta: emptyDelta(), threadSummary: "", skillCandidates: [] };
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}
