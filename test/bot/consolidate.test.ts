import { describe, expect, it } from "vitest";
import { consolidate } from "../../src/bot/consolidate.js";
import type { ThreadView } from "../../src/bot/context.js";
import type { Turn } from "../../src/bot/schema.js";
import type { Provider, StreamEvent } from "../../src/providers/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";

// T6: the post-turn consolidation sidecar. One cheap reflection call maps a
// landed turn to memory upserts, a thread summary, and skill candidates, and
// never lets a provider or parse failure block the turn.

const TURN: Turn = {
	id: "trn_0000000000000000000000000000000a",
	seq: 7,
	sessionId: "chs_0000000000000001",
	workspaceRoot: "/ws/a",
	at: 5_000,
	wake: "user",
	messages: [
		{ role: "user", content: "Remember: use pnpm." },
		{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
	],
};

const THREAD: ThreadView = {
	id: "chs_0000000000000001",
	summary: "Earlier: set up the bot ledger.",
};

const OUTPUT = {
	memory: [
		{ kind: "fact", text: "The repo uses pnpm." },
		{ kind: "weather", text: "not a memory kind" },
		{ kind: "preference", text: "The user prefers tabs." },
		{ kind: "commitment", text: "Will add consolidate tests." },
	],
	summary: "The user set up the bot ledger and wants tests.",
	skills: ["Run vitest before committing", "Use biome check", 42, "  "],
};

function script(output: unknown): StreamEvent[][] {
	return [
		[
			{ type: "text_delta", text: JSON.stringify(output) },
			{ type: "finish", reason: "stop" },
		],
	];
}

function deps(turns: StreamEvent[][]) {
	return {
		provider: createMockProvider(turns),
		model: "mock-model",
		clock: () => 9_999,
	};
}

describe("consolidate", () => {
	it("maps a turn to memory upserts with turn-derived ids", async () => {
		const result = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);

		expect(result.delta.upsert.map((entry) => entry.id)).toEqual([
			"mem_0000000000000000000000000000000a00",
			"mem_0000000000000000000000000000000a01",
			"mem_0000000000000000000000000000000a02",
		]);
		expect(result.delta.upsert.map((entry) => entry.text)).toEqual([
			"The repo uses pnpm.",
			"The user prefers tabs.",
			"Will add consolidate tests.",
		]);
		expect(result.delta.upsert[0]).toEqual({
			id: "mem_0000000000000000000000000000000a00",
			at: 9_999,
			kind: "fact",
			text: "The repo uses pnpm.",
			source: { sessionId: "chs_0000000000000001", turnSeq: 7 },
			supersedes: [],
		});
	});

	it("is idempotent: the same turn consolidates to byte-equal entries twice", async () => {
		const first = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);
		const second = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);

		expect(second.delta.upsert).toEqual(first.delta.upsert);
		expect(JSON.stringify(second.delta.upsert)).toBe(
			JSON.stringify(first.delta.upsert),
		);
	});

	it("stamps provenance from the turn session and seq", async () => {
		const result = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);

		expect(result.delta.upsert.map((entry) => entry.source)).toEqual([
			{ sessionId: "chs_0000000000000001", turnSeq: 7 },
			{ sessionId: "chs_0000000000000001", turnSeq: 7 },
			{ sessionId: "chs_0000000000000001", turnSeq: 7 },
		]);
	});

	it("parses skill candidates and drops non-strings and blanks", async () => {
		const result = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);

		expect(result.skillCandidates).toEqual([
			"Run vitest before committing",
			"Use biome check",
		]);
	});

	it("keeps the reflected thread summary", async () => {
		const result = await consolidate(deps(script(OUTPUT)))(TURN, THREAD);

		expect(result.threadSummary).toBe(
			"The user set up the bot ledger and wants tests.",
		);
	});

	it("caps the thread summary", async () => {
		const long = "S".repeat(1_000);
		const result = await consolidate(
			deps(script({ memory: [], summary: long, skills: [] })),
		)(TURN, THREAD);

		expect(result.threadSummary).toBe("S".repeat(600));
	});

	it("keeps the incoming summary when the model omits one", async () => {
		const result = await consolidate(deps(script({ memory: [], skills: [] })))(
			TURN,
			THREAD,
		);

		expect(result.threadSummary).toBe("Earlier: set up the bot ledger.");
	});

	it("caps the number of upserts", async () => {
		const memory = Array.from({ length: 10 }, (_, index) => ({
			kind: "fact",
			text: `fact ${index}`,
		}));
		const result = await consolidate(
			deps(script({ memory, summary: "", skills: [] })),
		)(TURN, THREAD);

		expect(result.delta.upsert).toHaveLength(8);
		expect(result.delta.upsert.map((entry) => entry.text)).toEqual([
			"fact 0",
			"fact 1",
			"fact 2",
			"fact 3",
			"fact 4",
			"fact 5",
			"fact 6",
			"fact 7",
		]);
		expect(result.delta.upsert[7].id).toBe(
			"mem_0000000000000000000000000000000a07",
		);
	});

	it("sends one tool-free reflection request with the turn and thread", async () => {
		const provider = createMockProvider(script(OUTPUT));
		await consolidate({ provider, model: "mock-model", clock: () => 1 })(
			TURN,
			THREAD,
		);

		expect(provider.requests).toHaveLength(1);
		const request = provider.requests[0];
		expect(request.model).toBe("mock-model");
		expect(request.tools).toEqual([]);
		expect(
			request.messages.some(
				(message) =>
					message.role === "user" &&
					message.content.includes("Remember: use pnpm."),
			),
		).toBe(true);
		expect(
			request.messages.some(
				(message) =>
					message.role === "user" &&
					message.content.includes("Earlier: set up the bot ledger."),
			),
		).toBe(true);
	});

	it("returns an empty result when the provider emits an error event", async () => {
		const provider = createMockProvider([
			[{ type: "error", message: "boom", retryable: false }],
		]);
		const result = await consolidate({ provider, model: "m", clock: () => 1 })(
			TURN,
			THREAD,
		);

		expect(result).toEqual({
			delta: { upsert: [], drop: [] },
			threadSummary: "",
			skillCandidates: [],
		});
	});

	it("returns an empty result when the provider stream throws", async () => {
		const provider: Provider = {
			id: "boom",
			stream() {
				throw new Error("network down");
			},
		};
		const result = await consolidate({ provider, model: "m", clock: () => 1 })(
			TURN,
			THREAD,
		);

		expect(result).toEqual({
			delta: { upsert: [], drop: [] },
			threadSummary: "",
			skillCandidates: [],
		});
	});

	it("returns an empty result when the model output is not JSON", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "sorry, I cannot help with that" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const result = await consolidate({ provider, model: "m", clock: () => 1 })(
			TURN,
			THREAD,
		);

		expect(result).toEqual({
			delta: { upsert: [], drop: [] },
			threadSummary: "",
			skillCandidates: [],
		});
	});

	it("ignores a memory item whose text is blank", async () => {
		const result = await consolidate(
			deps(
				script({
					memory: [
						{ kind: "fact", text: "   " },
						{ kind: "fact", text: "kept" },
					],
					summary: "",
					skills: [],
				}),
			),
		)(TURN, THREAD);

		expect(result.delta.upsert.map((entry) => entry.text)).toEqual(["kept"]);
	});
});
