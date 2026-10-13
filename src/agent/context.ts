import type { ContentBlock, Message } from "../providers/types.js";

export const TRIMMED_TOOL_OUTPUT =
	"[trimmed: older tool output removed to fit the context budget]";

export const DEFAULT_MAX_CHARS = 2_000_000;

export function trimForBudget(
	messages: Message[],
	maxChars: number = DEFAULT_MAX_CHARS,
): Message[] {
	let total = messages.reduce((sum, message) => sum + messageChars(message), 0);
	if (total <= maxChars) {
		return messages;
	}

	const result: Message[] = messages.map((message) => ({ ...message }));

	let keepFrom = result.length;
	while (keepFrom > 0 && result[keepFrom - 1].role === "tool") {
		keepFrom -= 1;
	}

	for (let index = 0; index < keepFrom && total > maxChars; index += 1) {
		const message = result[index];
		if (message.role !== "tool") continue;
		if (message.content === TRIMMED_TOOL_OUTPUT) continue;
		total -= message.content.length;
		result[index] = { ...message, content: TRIMMED_TOOL_OUTPUT };
		total += TRIMMED_TOOL_OUTPUT.length;
	}

	return result;
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
		case "reasoning":
			return block.text.length;
		case "tool_call":
			return JSON.stringify(block.args ?? null).length;
	}
}
