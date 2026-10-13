import { describe, expect, it } from "vitest";
import {
	type ChatChunk,
	mapChunks,
	mapFinishReason,
	toOpenAIMessages,
} from "../../src/providers/openai-compatible.js";
import type { Message, StreamEvent } from "../../src/providers/types.js";

async function collect(chunks: ChatChunk[]): Promise<StreamEvent[]> {
	async function* source(): AsyncIterable<ChatChunk> {
		for (const chunk of chunks) {
			yield chunk;
		}
	}
	const events: StreamEvent[] = [];
	for await (const event of mapChunks(source())) {
		events.push(event);
	}
	return events;
}

describe("toOpenAIMessages", () => {
	it("drops reasoning and serializes assistant tool calls with JSON arguments", () => {
		const messages: Message[] = [
			{ role: "system", content: "be terse" },
			{ role: "user", content: "time?" },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "secret chain of thought" },
					{ type: "text", text: "Checking the clock." },
					{
						type: "tool_call",
						id: "call_1",
						name: "get_time",
						args: { timezone: "UTC" },
					},
				],
			},
			{ role: "tool", toolCallId: "call_1", content: "12:00" },
		];

		const result = toOpenAIMessages(messages);

		expect(result).toEqual([
			{ role: "system", content: "be terse" },
			{ role: "user", content: "time?" },
			{
				role: "assistant",
				content: "Checking the clock.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "get_time", arguments: '{"timezone":"UTC"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "12:00" },
		]);
		expect(JSON.stringify(result)).not.toContain("secret chain of thought");
	});
});

describe("mapChunks", () => {
	it("accumulates one tool call split across three argument fragments", async () => {
		const events = await collect([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									function: { name: "get_time", arguments: '{"ti' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: 'mezone":' } }],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		]);

		expect(events).toEqual([
			{
				type: "tool_call",
				id: "call_1",
				name: "get_time",
				args: { timezone: "UTC" },
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	it("maps reasoning_content to reasoning_delta", async () => {
		const events = await collect([
			{
				choices: [
					{
						delta: { reasoning_content: "weighing options" },
						finish_reason: null,
					},
				],
			},
		]);

		expect(events).toEqual([
			{ type: "reasoning_delta", text: "weighing options" },
		]);
	});

	it("maps usage with cache and reasoning token fields", async () => {
		const events = await collect([
			{
				choices: [],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					prompt_cache_hit_tokens: 80,
					prompt_cache_miss_tokens: 20,
					completion_tokens_details: { reasoning_tokens: 30 },
				},
			},
		]);

		expect(events).toEqual([
			{
				type: "usage",
				inputTokens: 100,
				outputTokens: 50,
				cacheHitTokens: 80,
				cacheMissTokens: 20,
				reasoningTokens: 30,
			},
		]);
	});

	it("treats insufficient_system_resource as a retryable error", async () => {
		const events = await collect([
			{
				choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }],
			},
		]);

		expect(events).toEqual([
			{
				type: "error",
				message: "DeepSeek reported insufficient system resource",
				retryable: true,
			},
			{ type: "finish", reason: "insufficient_system_resource" },
		]);
	});
});

describe("mapFinishReason", () => {
	it("maps every documented finish reason to its canonical value", () => {
		expect(mapFinishReason("stop")).toBe("stop");
		expect(mapFinishReason("length")).toBe("length");
		expect(mapFinishReason("content_filter")).toBe("content_filter");
		expect(mapFinishReason("tool_calls")).toBe("tool_calls");
		expect(mapFinishReason("insufficient_system_resource")).toBe(
			"insufficient_system_resource",
		);
		expect(mapFinishReason("aborted")).toBe("aborted");
		expect(mapFinishReason("nonsense")).toBe("unknown");
	});
});
