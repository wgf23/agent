import type { BotRecord, MemoryEntry } from "./schema.js";

// T3: the deterministic L3 retrieval layer. Pure and dependency-free, so the
// same ledger and inbound always select the same entries and a replay is exact.

export interface RetrieveInput {
	record: BotRecord;
	// The current inbound text or texts to score memory against.
	query: readonly string[];
	// The maximum number of entries to return.
	limit: number;
}

export type Retrieve = (input: RetrieveInput) => MemoryEntry[];

// A path is kept whole instead of shredded into words, so a shared file name is
// a stronger signal than a shared ".ts" any file would match.
const PATH_LIKE = /(?:[\w.@-]+\/)+[\w.@-]+|[\w-]+\.[\w]+/g;

const WORD_WEIGHT = 1;
const FILE_WEIGHT = 2;
const FULL_PATH_WEIGHT = 3;

// Importance per kind, matching the design's ordering. Keyed by the union so a
// new kind fails compilation here instead of quietly scoring zero.
const KIND_WEIGHT: Record<MemoryEntry["kind"], number> = {
	commitment: 1,
	preference: 2 / 3,
	fact: 1 / 3,
	digest: 0,
};

// Relevance (0..1) is primary. Kind (0..0.3) is next; its smallest gap beats the
// whole recency range, so a matching commitment outranks a matching digest at
// any age. Recency (0..0.05) breaks remaining ties, then the id does the rest.
const RELEVANCE_WEIGHT = 1;
const KIND_SCORE_WEIGHT = 0.3;
const RECENCY_WEIGHT = 0.05;

export function retrieve(input: RetrieveInput): MemoryEntry[] {
	const { record, query, limit } = input;
	const candidates = visible(record.memory);
	const queryTokens = tokenize(query.join("\n"));

	const newest = candidates.reduce((max, entry) => Math.max(max, entry.at), 0);
	const oldest = candidates.reduce(
		(min, entry) => Math.min(min, entry.at),
		newest,
	);
	const span = newest - oldest;

	const ranked = candidates.map((entry) => ({
		entry,
		score:
			RELEVANCE_WEIGHT * relevance(queryTokens, tokenize(entry.text)) +
			KIND_SCORE_WEIGHT * KIND_WEIGHT[entry.kind] +
			RECENCY_WEIGHT * (span === 0 ? 1 : (entry.at - oldest) / span),
	}));

	ranked.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.entry.id === b.entry.id) return 0;
		return a.entry.id < b.entry.id ? -1 : 1;
	});

	return ranked
		.slice(0, Math.max(0, Math.floor(limit)))
		.map((hit) => hit.entry);
}

// The same visibility rule as renderMemory: an entry a newer entry supersedes
// is hidden from selection.
function visible(memory: MemoryEntry[]): MemoryEntry[] {
	const superseded = new Set<string>();
	for (const entry of memory) {
		for (const id of entry.supersedes) superseded.add(id);
	}
	return memory.filter((entry) => !superseded.has(entry.id));
}

interface TokenWeights {
	weights: Map<string, number>;
	total: number;
}

function tokenize(text: string): TokenWeights {
	const lower = text.toLowerCase();
	const weights = new Map<string, number>();
	const keep = (token: string, weight: number) => {
		const current = weights.get(token);
		if (current === undefined || weight > current) weights.set(token, weight);
	};

	for (const match of lower.matchAll(new RegExp(PATH_LIKE.source, "g"))) {
		const token = match[0];
		const separator = token.lastIndexOf("/");
		if (separator === -1) {
			keep(token, FILE_WEIGHT);
			continue;
		}
		keep(token.replace(/^(?:\.\.?\/)+/, ""), FULL_PATH_WEIGHT);
		keep(token.slice(separator + 1), FILE_WEIGHT);
	}

	const rest = lower.replace(new RegExp(PATH_LIKE.source, "g"), " ");
	for (const word of rest.split(/[^a-z0-9_]+/)) {
		if (word.length > 0) keep(word, WORD_WEIGHT);
	}

	let total = 0;
	for (const weight of weights.values()) total += weight;
	return { weights, total };
}

function relevance(query: TokenWeights, entry: TokenWeights): number {
	if (query.total === 0) return 0;
	let matched = 0;
	for (const [token, weight] of query.weights) {
		if (entry.weights.has(token)) matched += weight;
	}
	return matched / query.total;
}
