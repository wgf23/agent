import { describe, expect, it } from "vitest";
import {
	compactSummaryMessage,
	estimateTokens,
	shouldCompact,
	splitForCompaction,
	summarizeMessages,
} from "../../src/agent/compact.js";
import type { Message } from "../../src/providers/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";

describe("estimateTokens", () => {
	it("counts text characters and rounds up at four per token", () => {
		const messages: Message[] = [
			{ role: "user", content: "abcd" },
			{ role: "system", content: "abcdefgh" },
			{ role: "tool", toolCallId: "t1", content: "1234567890" },
			{ role: "assistant", content: [{ type: "text", text: "abcdefghijkl" }] },
		];

		expect(estimateTokens(messages)).toBe(9);
	});

	it("ignores reasoning that the provider never receives", () => {
		const withReasoning: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "x".repeat(400) },
					{ type: "text", text: "abcd" },
				],
			},
		];

		expect(estimateTokens(withReasoning)).toBe(1);
	});
});

describe("shouldCompact", () => {
	const base = {
		force: false,
		auto: true,
		estimatedTokens: 0,
		thresholdTokens: 1000,
	};

	it("fires when forced even with auto off", () => {
		expect(shouldCompact({ ...base, force: true, auto: false })).toBe(true);
	});

	it("fires when the estimate is over the threshold", () => {
		expect(shouldCompact({ ...base, estimatedTokens: 2000 })).toBe(true);
	});

	it("does not fire when the estimate is under the threshold", () => {
		expect(shouldCompact({ ...base, estimatedTokens: 500 })).toBe(false);
	});

	it("does not fire with auto off and no force", () => {
		expect(shouldCompact({ ...base, auto: false, estimatedTokens: 5000 })).toBe(
			false,
		);
	});

	it("uses a larger lastInputTokens over the estimate", () => {
		expect(
			shouldCompact({ ...base, estimatedTokens: 100, lastInputTokens: 5000 }),
		).toBe(true);
		expect(
			shouldCompact({ ...base, estimatedTokens: 100, lastInputTokens: 50 }),
		).toBe(false);
	});
});

describe("splitForCompaction", () => {
	const messages: Message[] = [
		{ role: "user", content: "u1" },
		{
			role: "assistant",
			content: [{ type: "tool_call", id: "c1", name: "read_file", args: {} }],
		},
		{ role: "tool", toolCallId: "c1", content: "r1" },
		{ role: "user", content: "u2" },
		{
			role: "assistant",
			content: [{ type: "tool_call", id: "c2", name: "read_file", args: {} }],
		},
		{ role: "tool", toolCallId: "c2", content: "r2" },
	];

	it("keeps a tool result with its assistant call and leaves the last message", () => {
		const { older, recent } = splitForCompaction(messages, 1);

		expect(older.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(recent.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(older[1].content).toEqual([
			{ type: "tool_call", id: "c1", name: "read_file", args: {} },
		]);
		expect(older[2]).toEqual({
			role: "tool",
			toolCallId: "c1",
			content: "r1",
		});
		expect(recent.at(-1)).toEqual({
			role: "tool",
			toolCallId: "c2",
			content: "r2",
		});
	});

	it("keeps everything recent when the budget covers the whole history", () => {
		const { older, recent } = splitForCompaction(messages, 1_000_000);

		expect(older).toEqual([]);
		expect(recent).toEqual(messages);
	});

	it("always leaves at least the last message in recent", () => {
		const single: Message[] = [
			{ role: "assistant", content: [{ type: "text", text: "only" }] },
		];

		expect(splitForCompaction(single, 0)).toEqual({
			older: [],
			recent: single,
		});
	});

	it("returns empty halves for no messages", () => {
		expect(splitForCompaction([], 100)).toEqual({ older: [], recent: [] });
	});
});

describe("compactSummaryMessage", () => {
	it("wraps the summary in a tagged user message so persistence keeps it", () => {
		expect(compactSummaryMessage("we agreed on the plan")).toEqual({
			role: "user",
			content: "[compacted summary]\nwe agreed on the plan",
		});
	});
});

describe("summarizeMessages", () => {
	it("returns the streamed summary and sends the older text without tools", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "the summary" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await summarizeMessages(provider, "deepseek-flash", [
			{ role: "user", content: "the oldest detail" },
		]);

		expect(result).toEqual({ ok: true, summary: "the summary" });
		expect(provider.requests).toHaveLength(1);
		expect(provider.requests[0].tools).toEqual([]);
		const userMessage = provider.requests[0].messages[1];
		expect(userMessage.role).toBe("user");
		if (userMessage.role === "user") {
			expect(userMessage.content).toContain("the oldest detail");
		}
	});

	it("reports a provider error instead of a summary", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "boom", retryable: false }],
		]);

		expect(
			await summarizeMessages(provider, "deepseek-flash", [
				{ role: "user", content: "x" },
			]),
		).toEqual({ ok: false, error: "boom" });
	});
});
