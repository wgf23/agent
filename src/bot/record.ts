import type { Message } from "../providers/types.js";
import {
	type BotRecord,
	MAX_MEMORY_CHARS,
	MAX_MEMORY_ENTRIES,
	MAX_MEMORY_TEXT,
	MAX_RING_TURNS,
	type MemoryEntry,
	type Turn,
} from "./schema.js";

export interface MemoryDelta {
	upsert: MemoryEntry[];
	drop: string[];
}

export type ApplyMemoryResult =
	| { ok: true; memory: MemoryEntry[] }
	| { ok: false; error: string };

export interface RingResult {
	turns: Turn[];
	digest: MemoryEntry | null;
}

export function emptyDelta(): MemoryDelta {
	return { upsert: [], drop: [] };
}

// Upsert is a set-union keyed by id and drop is a set-difference, so applying
// the same delta twice converges on the same memory. Digest entries are the
// mechanical record of evicted turns and are the only entries that may be
// evicted; facts, preferences, and commitments are pinned.
export function applyMemoryDelta(
	memory: MemoryEntry[],
	delta: MemoryDelta,
): ApplyMemoryResult {
	const byId = new Map<string, MemoryEntry>();
	for (const entry of memory) byId.set(entry.id, entry);
	for (const entry of delta.upsert) byId.set(entry.id, entry);
	for (const id of delta.drop) byId.delete(id);

	const capped = enforceCaps([...byId.values()]);
	if (capped === null) {
		return {
			ok: false,
			error: `Memory exceeds its caps of ${MAX_MEMORY_ENTRIES} entries and ${MAX_MEMORY_CHARS} chars with no digest left to evict.`,
		};
	}
	return { ok: true, memory: capped };
}

// Appends the turn to the ring and drops the oldest turn once the ring is
// full. The evicted turn becomes one mechanical digest so nothing leaves
// without a trace. Replaying a turn already in the ring is a no-op.
export function reconcileRing(record: BotRecord, turn: Turn): RingResult {
	if (record.turns.some((existing) => existing.id === turn.id)) {
		return { turns: record.turns, digest: null };
	}

	const turns = [...record.turns, turn];
	if (turns.length <= MAX_RING_TURNS) return { turns, digest: null };

	const evicted = turns.shift();
	return { turns, digest: evicted === undefined ? null : digestFor(evicted) };
}

// Renders the visible memory as prompt text, newest first and bounded by the
// character cap. An entry that a newer entry supersedes is hidden.
export function renderMemory(memory: MemoryEntry[]): string {
	const superseded = new Set<string>();
	for (const entry of memory) {
		for (const id of entry.supersedes) superseded.add(id);
	}

	const visible = memory
		.filter((entry) => !superseded.has(entry.id))
		.sort((a, b) => b.at - a.at);

	const lines: string[] = [];
	let used = 0;
	for (const entry of visible) {
		if (used + entry.text.length > MAX_MEMORY_CHARS) break;
		lines.push(`${entry.kind}: ${entry.text}`);
		used += entry.text.length;
	}
	return lines.join("\n");
}

// The transcript a bot replays is scoped to one workspace, and optionally one
// session, so two workspaces never see each other's messages.
export function replay(
	turns: Turn[],
	workspaceRoot: string,
	sessionId?: string,
): Message[] {
	return turns
		.filter(
			(turn) =>
				turn.workspaceRoot === workspaceRoot &&
				(sessionId === undefined || turn.sessionId === sessionId),
		)
		.sort((a, b) => a.seq - b.seq)
		.flatMap((turn) => turn.messages);
}

function digestFor(turn: Turn): MemoryEntry {
	const firstUser = turn.messages.find((message) => message.role === "user");
	const parts: string[] = [];
	if (firstUser !== undefined && firstUser.content !== "") {
		parts.push(firstUser.content);
	}
	const assistant = lastAssistantText(turn.messages);
	if (assistant !== "") parts.push(assistant);
	const artifacts = artifactPaths(turn.messages);
	if (artifacts.length > 0) parts.push(`artifacts: ${artifacts.join(" ")}`);

	// Assembled first, then bounded once, so a long ask cannot silently drop the
	// decision and paths that follow it.
	const text =
		parts.length === 0
			? `${turn.messages.length} messages`
			: parts.join("\n").slice(0, MAX_MEMORY_TEXT);

	return {
		// Derived from the turn id, so the same turn always digests to the same
		// entry and a repeated fold stays idempotent.
		id: `mem_${turn.id.slice("trn_".length)}`,
		at: turn.at,
		kind: "digest",
		text,
		source: { sessionId: turn.sessionId, turnSeq: turn.seq },
		supersedes: [],
	};
}

// The last thing the assistant said, so a digest keeps the turn's decision or
// summary rather than only the prompt that started it. Walks backward so the
// final assistant message wins when a turn has several.
function lastAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const blocks: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text !== "") blocks.push(block.text);
		}
		const joined = blocks.join("\n").trim();
		if (joined !== "") return joined;
	}
	return "";
}

// Every string the turn emitted: user and tool content are plain strings, an
// assistant message contributes its text blocks (not reasoning or tool calls).
function messageTexts(messages: Message[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text !== "") texts.push(block.text);
			}
		} else if (message.content !== "") {
			texts.push(message.content);
		}
	}
	return texts;
}

// Path-like tokens: at least one directory segment and a filename extension, so
// `docs/x.md` survives while prose, versions, and bare words do not.
function artifactPaths(messages: Message[]): string[] {
	const pattern = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g;
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const text of messageTexts(messages)) {
		for (const match of text.matchAll(pattern)) {
			if (seen.has(match[0])) continue;
			seen.add(match[0]);
			paths.push(match[0]);
		}
	}
	return paths;
}

function enforceCaps(memory: MemoryEntry[]): MemoryEntry[] | null {
	let entries = memory;
	while (
		entries.length > MAX_MEMORY_ENTRIES ||
		memoryChars(entries) > MAX_MEMORY_CHARS
	) {
		const oldest = oldestDigestIndex(entries);
		if (oldest === -1) return null;
		entries = entries.filter((_, index) => index !== oldest);
	}
	return entries;
}

function oldestDigestIndex(memory: MemoryEntry[]): number {
	let oldest = -1;
	for (let index = 0; index < memory.length; index++) {
		const entry = memory[index];
		if (entry.kind !== "digest") continue;
		if (oldest === -1 || entry.at < memory[oldest].at) oldest = index;
	}
	return oldest;
}

function memoryChars(memory: MemoryEntry[]): number {
	return memory.reduce((total, entry) => total + entry.text.length, 0);
}
