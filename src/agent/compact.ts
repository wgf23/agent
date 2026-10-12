import type {
	ContentBlock,
	Message,
	Provider,
	ProviderRequest,
} from "../providers/types.js";
import { errorMessage } from "../util/errors.js";

export interface CompactionSettings {
	auto: boolean;
	thresholdTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
	auto: true,
	thresholdTokens: 100_000,
	keepRecentTokens: 20_000,
};

// Provider context is dominated by characters, and ~4 characters per token is
// close enough to decide when to compact.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const message of messages) {
		chars += messageChars(message);
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ShouldCompactInput {
	force: boolean;
	auto: boolean;
	estimatedTokens: number;
	// A per-turn provider input count. Cumulative session usage would grow
	// without bound and trip compaction early, so callers that only have the
	// persisted session total leave this undefined and trust the estimate.
	lastInputTokens?: number;
	thresholdTokens: number;
}

export function shouldCompact(input: ShouldCompactInput): boolean {
	if (input.force) return true;
	if (!input.auto) return false;
	// A real usage count beats the estimate only when it is larger; a stale or
	// smaller one would otherwise hide an oversized context.
	const current =
		input.lastInputTokens !== undefined &&
		input.lastInputTokens > input.estimatedTokens
			? input.lastInputTokens
			: input.estimatedTokens;
	return current > input.thresholdTokens;
}

export interface CompactionSplit {
	older: Message[];
	recent: Message[];
}

export function splitForCompaction(
	messages: readonly Message[],
	keepRecentTokens: number,
): CompactionSplit {
	if (messages.length === 0) return { older: [], recent: [] };

	let accumulated = 0;
	let boundary = messages.length - 1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		accumulated += estimateTokens([messages[index]]);
		boundary = index;
		if (accumulated >= keepRecentTokens) break;
	}

	// A tool result must stay with the assistant call that produced it, so the
	// recent block starts at a user turn.
	while (boundary > 0 && messages[boundary].role !== "user") {
		boundary -= 1;
	}

	return {
		older: messages.slice(0, boundary),
		recent: messages.slice(boundary),
	};
}

// Tag for the message that replaces older turns with a model-written summary.
export const COMPACTED_SUMMARY_PREFIX = "[compacted summary]";

export function compactSummaryMessage(summary: string): Message {
	return { role: "system", content: `${COMPACTED_SUMMARY_PREFIX}\n${summary}` };
}

const SUMMARY_INSTRUCTION =
	"Summarize the conversation so far so it can replace the earlier messages. " +
	"Preserve decisions, file paths, findings, and user preferences. " +
	"Answer with plain text only, no tool calls.";

export type SummaryResult =
	| { ok: true; summary: string }
	| { ok: false; error: string };

export async function summarizeMessages(
	provider: Provider,
	model: string,
	older: readonly Message[],
	signal?: AbortSignal,
): Promise<SummaryResult> {
	const request: ProviderRequest = {
		model,
		messages: [
			{ role: "system", content: SUMMARY_INSTRUCTION },
			{ role: "user", content: serializeMessages(older) },
		],
		tools: [],
		signal,
	};

	let summary = "";
	let failure: string | undefined;
	try {
		for await (const event of provider.stream(request)) {
			if (event.type === "text_delta") {
				summary += event.text;
			} else if (event.type === "error") {
				failure = event.message;
			}
		}
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
	if (failure !== undefined) return { ok: false, error: failure };
	return { ok: true, summary };
}

function serializeMessages(messages: readonly Message[]): string {
	return messages.map(serializeMessage).join("\n\n");
}

function serializeMessage(message: Message): string {
	switch (message.role) {
		case "system":
			return `system: ${message.content}`;
		case "user":
			return `user: ${message.content}`;
		case "tool":
			return `tool: ${message.content}`;
		case "assistant": {
			const parts = message.content.map(textForBlock);
			return `assistant: ${parts.filter((part) => part !== "").join(" ")}`;
		}
	}
}

function textForBlock(block: ContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "tool_call":
			return `[tool_call ${block.name} ${JSON.stringify(block.args ?? {})}]`;
		case "reasoning":
			return "";
	}
}

function messageChars(message: Message): number {
	switch (message.role) {
		case "system":
		case "user":
		case "tool":
			return message.content.length;
		case "assistant":
			return message.content.reduce((sum, block) => sum + blockChars(block), 0);
	}
}

function blockChars(block: ContentBlock): number {
	switch (block.type) {
		case "text":
			return block.text.length;
		case "tool_call":
			return JSON.stringify(block.args ?? null).length;
		// Reasoning is dropped from outbound requests, so it never reaches the
		// provider context this estimate guards.
		case "reasoning":
			return 0;
	}
}
