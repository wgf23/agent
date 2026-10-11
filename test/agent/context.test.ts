import { describe, expect, it } from "vitest";
import { trimForBudget } from "../../src/agent/context.js";
import type { Message } from "../../src/providers/types.js";

const TRIMMED =
	"[trimmed: older tool output removed to fit the context budget]";

function bigMessage(id: string, char: string): Message {
	return {
		role: "tool",
		toolCallId: id,
		content: char.repeat(100),
	};
}

describe("trimForBudget", () => {
	it("replaces only the oldest tool bodies and keeps the newest one", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "question" },
			{ role: "assistant", content: [{ type: "text", text: "read A" }] },
			bigMessage("a", "A"),
			{ role: "assistant", content: [{ type: "text", text: "read B" }] },
			bigMessage("b", "B"),
			{ role: "assistant", content: [{ type: "text", text: "read C" }] },
			bigMessage("c", "C"),
		];

		const result = trimForBudget(messages, 150);

		expect(result[0]).toEqual({ role: "system", content: "sys" });
		expect(result[1]).toEqual({ role: "user", content: "question" });
		expect(result[3]).toEqual({
			role: "tool",
			toolCallId: "a",
			content: TRIMMED,
		});
		expect(result[5]).toEqual({
			role: "tool",
			toolCallId: "b",
			content: TRIMMED,
		});
		expect(result[7]).toEqual({
			role: "tool",
			toolCallId: "c",
			content: "C".repeat(100),
		});
	});

	it("returns the messages unchanged when under budget", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "tool", toolCallId: "a", content: "short" },
		];

		expect(trimForBudget(messages, 1000)).toBe(messages);
	});
});
