import type { Provider } from "../providers/types.js";
import type { ThreadView } from "./context.js";
import type { MemoryDelta } from "./record.js";
import type { Turn } from "./schema.js";

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

export function consolidate(_deps: ConsolidateDeps): Consolidate {
	return async () => ({
		delta: { upsert: [], drop: [] },
		threadSummary: "",
		skillCandidates: [],
	});
}
