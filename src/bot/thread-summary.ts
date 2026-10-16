import { splitForCompaction, summarizeMessages } from "../agent/compact.js";
import type { Message, Provider } from "../providers/types.js";
import type { ThreadSummary } from "./schema.js";

// T5: the per-thread rolling summary. Each update folds only the oldest segment
// that fell outside the keep window into the prior summary, so the summary
// improves incrementally instead of being recomputed from every message.

// A thread summary is injected as its own context layer on every turn, so it is
// capped in characters. ~4000 chars is ~1000 tokens, the L2 share of a window.
export const MAX_THREAD_SUMMARY_CHARS = 4_000;

export interface ThreadSummaryDeps {
	provider: Provider;
	model: string;
	clock: () => number;
}

export interface ThreadSummaryInput {
	// The caller keys the result by this; the fold itself does not need it.
	threadId: string;
	previous: ThreadSummary | undefined;
	// The thread's full message history. Only the segment older than keepTokens
	// is folded; the recent segment is left for the L1 window.
	messages: Message[];
	keepTokens: number;
}

export type UpdateThreadSummary = (
	input: ThreadSummaryInput,
) => Promise<ThreadSummary>;

export function updateThreadSummary(
	deps: ThreadSummaryDeps,
): UpdateThreadSummary {
	return async ({ previous, messages, keepTokens }) => {
		const current: ThreadSummary = previous ?? { summary: "", summaryAt: 0 };
		const { older } = splitForCompaction(messages, keepTokens);
		if (older.length === 0) return current;

		const result = await summarizeMessages(
			deps.provider,
			deps.model,
			withPriorSummary(older, current.summary),
		);
		if (!result.ok) return current;

		const folded = result.summary.trim();
		if (folded === "") return current;
		return {
			summary: folded.slice(0, MAX_THREAD_SUMMARY_CHARS),
			summaryAt: deps.clock(),
		};
	};
}

// The prior summary leads the older segment so the single summarization call
// produces a merged rolling summary rather than a summary of the older segment
// alone.
function withPriorSummary(
	older: readonly Message[],
	summary: string,
): Message[] {
	if (summary === "") return [...older];
	return [
		{ role: "system", content: `Existing thread summary:\n${summary}` },
		...older,
	];
}
