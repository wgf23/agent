import type { Message } from "../providers/types.js";
import type { Inbound } from "../rob/types.js";
import type { BotRecord } from "./schema.js";

// T1 freezes these signatures. T2 implements assembleContext against them.

export interface ContextBudget {
	// The model window minus the output reserve. Every assembled turn stays at
	// or below this.
	totalTokens: number;
	// Per-layer ceilings in tokens, applied before the total is enforced.
	quotas: { l1: number; l2: number; l3: number };
}

// A thread is the unit a conversation window is cut along (a wake source). The
// rolling summary belongs to the thread; memory stays global.
export interface ThreadView {
	id: string;
	summary: string;
}

export interface ContextLayers {
	l0: number;
	l1: number;
	l2: number;
	l3: number;
	l4: number;
}

export interface DroppedLayer {
	layer: string;
	reason: string;
}

export interface AssembledContext {
	messages: Message[];
	layers: ContextLayers;
	dropped: DroppedLayer[];
}

export interface AssembleContextInput {
	record: BotRecord;
	thread: ThreadView;
	inbound: readonly Inbound[];
	workspaceRoot: string;
	budget: ContextBudget;
}

export function assembleContext(
	_input: AssembleContextInput,
): AssembledContext {
	return {
		messages: [],
		layers: { l0: 0, l1: 0, l2: 0, l3: 0, l4: 0 },
		dropped: [],
	};
}
