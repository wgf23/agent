import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../src/bot/schema.js";
import {
	MAX_THREAD_SUMMARY_CHARS,
	updateThreadSummary,
} from "../../src/bot/thread-summary.js";
import type {
	Message,
	Provider,
	ProviderRequest,
	StreamEvent,
} from "../../src/providers/types.js";
import {
	createMockProvider,
	type MockProvider,
} from "../helpers/mock-provider.js";

// T5: the per-thread rolling summary. Each update folds only the oldest
// segment that fell outside the keep window into the prior summary with one
// summarization call, so the thread summary improves incrementally and a
// provider failure leaves the prior value untouched.

const THREAD = "chs_0000000000000001";

function deps(provider: Provider, at = 9_999) {
	return { provider, model: "mock-model", clock: () => at };
}

// A provider that yields the same summary on every call, so a determinism
// check compares two independent runs rather than two scripted turns.
function constantProvider(summary: string): MockProvider {
	const requests: ProviderRequest[] = [];
	return {
		id: "constant",
		requests,
		async *stream(request) {
			requests.push(structuredClone(request));
			yield { type: "text_delta", text: summary };
			yield { type: "finish", reason: "stop" };
		},
	};
}

// Three turns: the first two fall outside a keep window of 8 tokens, so the
// fold sees the port fact and not the recent question.
const MESSAGES: Message[] = [
	{ role: "user", content: "Fact: the deploy port is 8080." },
	{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
	{ role: "user", content: "recent question about the deploy" },
];

const KEEP_TOKENS = 8;

function serialize(request: ProviderRequest): string {
	return request.messages
		.map((message) =>
			message.role === "assistant"
				? message.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.join(" ")
				: message.content,
		)
		.join("\n");
}

describe("updateThreadSummary", () => {
	it("returns the previous summary unchanged and makes no provider call when nothing is outside the keep window", async () => {
		const provider = createMockProvider([]);
		const previous: ThreadSummary = {
			summary: "Earlier: set up the ledger.",
			summaryAt: 111,
		};

		const result = await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous,
			messages: [{ role: "user", content: "hi" }],
			keepTokens: 1_000,
		});

		expect(result).toEqual({
			summary: "Earlier: set up the ledger.",
			summaryAt: 111,
		});
		expect(provider.requests).toHaveLength(0);
	});

	it("folds the oldest segment into the prior summary and keeps only the new summary", async () => {
		const provider = createMockProvider([
			[
				{
					type: "text_delta",
					text: "The deploy port is 8080. A recent question about the deploy is open.",
				},
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await updateThreadSummary(deps(provider, 7_000))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(result).toEqual({
			summary:
				"The deploy port is 8080. A recent question about the deploy is open.",
			summaryAt: 7_000,
		});
	});

	it("sends the prior summary and only the older segment, not the recent messages", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "folded" },
				{ type: "finish", reason: "stop" },
			],
		]);

		await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(provider.requests).toHaveLength(1);
		const request = provider.requests[0];
		expect(request.model).toBe("mock-model");
		expect(request.tools).toEqual([]);
		const prompt = serialize(request);
		expect(prompt).toContain("Earlier: set up the ledger.");
		expect(prompt).toContain("Fact: the deploy port is 8080.");
		expect(prompt).toContain("Noted.");
		expect(prompt).not.toContain("recent question about the deploy");
	});

	it("caps the folded summary at MAX_THREAD_SUMMARY_CHARS", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "S".repeat(5_000) },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(MAX_THREAD_SUMMARY_CHARS).toBe(4_000);
		expect(result.summary).toBe("S".repeat(4_000));
		expect(result.summaryAt).toBe(9_999);
	});

	it("returns the previous summary unchanged when the provider emits an error event", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "boom", retryable: false }],
		]);

		const result = await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(result).toEqual({
			summary: "Earlier: set up the ledger.",
			summaryAt: 111,
		});
	});

	it("returns the previous summary unchanged when the provider stream throws", async () => {
		const provider: Provider = {
			id: "boom",
			stream(): AsyncIterable<StreamEvent> {
				throw new Error("network down");
			},
		};

		const result = await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(result).toEqual({
			summary: "Earlier: set up the ledger.",
			summaryAt: 111,
		});
	});

	it("keeps the previous summary when the folded response is empty", async () => {
		const provider = createMockProvider([[{ type: "finish", reason: "stop" }]]);

		const result = await updateThreadSummary(deps(provider))({
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		});

		expect(result).toEqual({
			summary: "Earlier: set up the ledger.",
			summaryAt: 111,
		});
	});

	it("is deterministic given the same inputs and a fixed clock", async () => {
		const input = {
			threadId: THREAD,
			previous: { summary: "Earlier: set up the ledger.", summaryAt: 111 },
			messages: MESSAGES,
			keepTokens: KEEP_TOKENS,
		};

		const first = await updateThreadSummary(
			deps(constantProvider("folded summary")),
		)(input);
		const second = await updateThreadSummary(
			deps(constantProvider("folded summary")),
		)(input);

		expect(second).toEqual(first);
		expect(first.summary).toBe("folded summary");
		expect(first.summaryAt).toBe(9_999);
	});
});
