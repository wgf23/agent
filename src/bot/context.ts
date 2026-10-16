import { estimateTokens, splitForCompaction } from "../agent/compact.js";
import type { Message } from "../providers/types.js";
import { toUserMessage } from "../rob/backend.js";
import type { Inbound } from "../rob/types.js";
import { replay } from "./record.js";
import type { BotRecord, MemoryEntry } from "./schema.js";

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

// The retrieval layer is a pure lookup over the ledger. T3 owns the real
// implementation; absent one, the caller injects nothing and L3 is empty.
export interface RetrieveInput {
	record: BotRecord;
	thread: ThreadView;
	inbound: readonly Inbound[];
	workspaceRoot: string;
}

export type Retrieve = (input: RetrieveInput) => MemoryEntry[];

export interface AssembleContextInput {
	record: BotRecord;
	thread: ThreadView;
	inbound: readonly Inbound[];
	workspaceRoot: string;
	budget: ContextBudget;
	// Wired by the backend once T3 lands. Omitted means no retrieval.
	retrieve?: Retrieve;
}

const EMPTY_RETRIEVAL: Retrieve = () => [];

export function assembleContext(input: AssembleContextInput): AssembledContext {
	const { record, thread, inbound, workspaceRoot, budget } = input;
	const retrieve = input.retrieve ?? EMPTY_RETRIEVAL;
	const { l1: l1Quota, l2: l2Quota, l3: l3Quota } = budget.quotas;

	// The caller renders L0 (system prompt, role, roster, memory). Its ceiling
	// is whatever the three renderable layer ceilings leave of the window, so
	// the messages assembled here must fit that remainder.
	const l0 = Math.max(0, budget.totalTokens - l1Quota - l2Quota - l3Quota);
	const messageBudget = Math.max(0, budget.totalTokens - l0);

	const dropped: DroppedLayer[] = [];
	const recordDrop = (layer: string, reason: string): void => {
		if (dropped.some((entry) => entry.layer === layer)) return;
		dropped.push({ layer, reason });
	};

	// L1: the thread's recent turns, cut at user-turn boundaries so a tool call
	// never leaves its result behind.
	const replayed = replay(record.turns, workspaceRoot, thread.id);
	const l1 = fitUserWindow(
		splitForCompaction(replayed, l1Quota).recent,
		l1Quota,
	);

	// L2: one message for the thread's rolling summary.
	const l2: Message[] = [];
	if (thread.summary.trim() !== "") {
		const summary: Message = { role: "system", content: thread.summary };
		if (estimateTokens([summary]) > l2Quota) {
			recordDrop("l2", `summary exceeds the l2 quota of ${l2Quota} tokens`);
		} else {
			l2.push(summary);
		}
	}

	// L3: retrieved long-ago fragments, ranked by the retriever, admitted in
	// order until the quota is spent.
	const l3: Message[] = [];
	let l3Tokens = 0;
	let l3Omitted = false;
	for (const entry of retrieve({ record, thread, inbound, workspaceRoot })) {
		const message: Message = {
			role: "system",
			content: `${entry.kind}: ${entry.text}`,
		};
		const cost = estimateTokens([message]);
		if (l3Tokens + cost > l3Quota) {
			l3Omitted = true;
			break;
		}
		l3.push(message);
		l3Tokens += cost;
	}
	if (l3Omitted) {
		recordDrop(
			"l3",
			`retrieved entries exceed the l3 quota of ${l3Quota} tokens`,
		);
	}

	// L4: the inbound is the turn's reason to exist and is never cut.
	const l4 = inbound.map(toUserMessage);

	const layers = { l1, l2, l3, l4 };
	const includedTokens = (): number =>
		estimateTokens([...layers.l1, ...layers.l2, ...layers.l3, ...layers.l4]);
	if (includedTokens() > messageBudget) {
		for (const layer of ["l3", "l2", "l1"] as const) {
			if (includedTokens() <= messageBudget) break;
			if (layers[layer].length === 0) continue;
			layers[layer] = [];
			recordDrop(
				layer,
				`over the total budget of ${budget.totalTokens} tokens`,
			);
		}
	}

	return {
		messages: [...layers.l1, ...layers.l2, ...layers.l3, ...layers.l4],
		layers: {
			l0,
			l1: estimateTokens(layers.l1),
			l2: estimateTokens(layers.l2),
			l3: estimateTokens(layers.l3),
			l4: estimateTokens(layers.l4),
		},
		dropped,
	};
}

// Trims whole leading turns until the window fits its quota. It never cuts
// inside a turn, so a call keeps its result; a single oversized trailing turn
// is kept rather than split.
function fitUserWindow(messages: Message[], quota: number): Message[] {
	if (quota <= 0) return [];
	let window = messages;
	while (window.length > 0 && estimateTokens(window) > quota) {
		const nextUser = window.findIndex(
			(message, index) => index > 0 && message.role === "user",
		);
		if (nextUser === -1) break;
		window = window.slice(nextUser);
	}
	return window;
}
