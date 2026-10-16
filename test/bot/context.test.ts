import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/agent/compact.js";
import {
	type AssembleContextInput,
	assembleContext,
	type ContextBudget,
	type Retrieve,
} from "../../src/bot/context.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	type MemoryEntry,
	type Turn,
} from "../../src/bot/schema.js";
import type { Message } from "../../src/providers/types.js";
import type { Inbound } from "../../src/rob/types.js";

const WORKSPACE = "/ws/a";
const SESSION = "chs_0000000000000001";

function turn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: "trn_00000000000000000000000000000001",
		seq: 1,
		sessionId: SESSION,
		workspaceRoot: WORKSPACE,
		at: 1000,
		wake: "user",
		messages: [{ role: "user", content: "hello" }],
		...overrides,
	};
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_00000000000000000000000000000001",
		at: 1000,
		kind: "fact",
		text: "a fact",
		source: { sessionId: null, turnSeq: 0 },
		supersedes: [],
		...overrides,
	};
}

function record(turns: Turn[] = []): BotRecord {
	return {
		version: BOT_RECORD_VERSION,
		bot: "atlas",
		role: "helper",
		model: "deepseek-flash",
		createdAt: 0,
		updatedAt: 0,
		seq: turns.length,
		usage: { input: 0, output: 0 },
		memory: [],
		sessionTitles: {},
		turns,
	};
}

function budget(overrides: Partial<ContextBudget> = {}): ContextBudget {
	return {
		totalTokens: 10_000,
		quotas: { l1: 4_000, l2: 2_000, l3: 2_000 },
		...overrides,
	};
}

function inbound(overrides: Partial<Inbound> = {}): Inbound {
	return { kind: "user", from: "user", text: "go", at: 5000, ...overrides };
}

function growthTurns(count: number): Turn[] {
	return Array.from({ length: count }, (_, index) =>
		turn({
			id: `trn_${(index + 1).toString(16).padStart(32, "0")}`,
			seq: index + 1,
			at: 1000 + index,
			messages: [
				{ role: "user", content: `question ${index}` },
				{
					role: "assistant",
					content: [{ type: "text", text: `answer ${index}` }],
				},
			],
		}),
	);
}

// Every tool result has its call and every call has its result. A cut that
// split a pair would leave an orphan on one side.
function pairingHolds(messages: readonly Message[]): boolean {
	const callIds = new Set<string>();
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool_call") callIds.add(block.id);
			}
		}
		if (message.role === "tool") resultIds.add(message.toolCallId);
	}
	return (
		[...callIds].every((id) => resultIds.has(id)) &&
		[...resultIds].every((id) => callIds.has(id))
	);
}

describe("assembleContext", () => {
	it("keeps the assembled messages within the total budget as turns grow", () => {
		for (const count of [10, 100, 1000]) {
			const budgetHere = budget();
			const result = assembleContext({
				record: record(growthTurns(count)),
				thread: { id: SESSION, summary: "" },
				inbound: [inbound()],
				workspaceRoot: WORKSPACE,
				budget: budgetHere,
			});

			expect(estimateTokens(result.messages)).toBeLessThanOrEqual(
				budgetHere.totalTokens,
			);
			// L0 is reserved from the budget, so the messages fit the remainder.
			expect(estimateTokens(result.messages)).toBeLessThanOrEqual(
				budgetHere.totalTokens - result.layers.l0,
			);
			expect(result.layers.l1).toBeLessThanOrEqual(budgetHere.quotas.l1);
		}
	});

	it("returns the same assembly, and the same snapshot, for the same input", () => {
		const retrieve: Retrieve = () => [
			memoryEntry({
				id: "mem_000000000000000000000000000000aa",
				kind: "fact",
				text: "uses pnpm",
			}),
		];
		const input: AssembleContextInput = {
			record: record(growthTurns(3)),
			thread: { id: SESSION, summary: "prior context" },
			inbound: [inbound({ text: "continue" })],
			workspaceRoot: WORKSPACE,
			budget: budget(),
			retrieve,
		};

		const first = assembleContext(input);
		const second = assembleContext(input);

		expect(second).toEqual(first);
		expect(first).toMatchInlineSnapshot(`
			{
			  "dropped": [],
			  "layers": {
			    "l0": 2000,
			    "l1": 14,
			    "l2": 4,
			    "l3": 4,
			    "l4": 5,
			  },
			  "messages": [
			    {
			      "content": "question 0",
			      "role": "user",
			    },
			    {
			      "content": [
			        {
			          "text": "answer 0",
			          "type": "text",
			        },
			      ],
			      "role": "assistant",
			    },
			    {
			      "content": "question 1",
			      "role": "user",
			    },
			    {
			      "content": [
			        {
			          "text": "answer 1",
			          "type": "text",
			        },
			      ],
			      "role": "assistant",
			    },
			    {
			      "content": "question 2",
			      "role": "user",
			    },
			    {
			      "content": [
			        {
			          "text": "answer 2",
			          "type": "text",
			        },
			      ],
			      "role": "assistant",
			    },
			    {
			      "content": "prior context",
			      "role": "system",
			    },
			    {
			      "content": "fact: uses pnpm",
			      "role": "system",
			    },
			    {
			      "content": "[from user] continue",
			      "role": "user",
			    },
			  ],
			}
		`);
	});

	it("drops the retrieval layer before the recent window under pressure", () => {
		const retrieve: Retrieve = () => [
			memoryEntry({
				id: "mem_000000000000000000000000000000aa",
				text: "old one",
			}),
			memoryEntry({
				id: "mem_000000000000000000000000000000bb",
				text: "old two",
			}),
		];
		const base = assembleContext({
			record: record(growthTurns(3)),
			thread: { id: SESSION, summary: "prior context" },
			inbound: [inbound({ text: "x".repeat(200) })],
			workspaceRoot: WORKSPACE,
			budget: budget({ totalTokens: 100_000 }),
			retrieve,
		});
		const assembled =
			base.layers.l1 + base.layers.l2 + base.layers.l3 + base.layers.l4;

		const result = assembleContext({
			record: record(growthTurns(3)),
			thread: { id: SESSION, summary: "prior context" },
			inbound: [inbound({ text: "x".repeat(200) })],
			workspaceRoot: WORKSPACE,
			// Exactly enough room once the retrieval layer is gone.
			budget: budget({ totalTokens: assembled - base.layers.l3 }),
			retrieve,
		});

		expect(result.dropped.map((entry) => entry.layer)).toEqual(["l3"]);
		expect(result.layers.l3).toBe(0);
		expect(result.layers.l1).toBeGreaterThan(0);
	});

	it("drops l3, then l2, then l1 and never l4", () => {
		const retrieve: Retrieve = () => [
			memoryEntry({
				id: "mem_000000000000000000000000000000aa",
				text: "old one",
			}),
		];
		const base = assembleContext({
			record: record(growthTurns(3)),
			thread: { id: SESSION, summary: "prior context" },
			inbound: [inbound({ text: "x".repeat(200) })],
			workspaceRoot: WORKSPACE,
			budget: budget({ totalTokens: 100_000 }),
			retrieve,
		});

		const result = assembleContext({
			record: record(growthTurns(3)),
			thread: { id: SESSION, summary: "prior context" },
			inbound: [inbound({ text: "x".repeat(200) })],
			workspaceRoot: WORKSPACE,
			// No room for l1 + l2 + l3 beside l4.
			budget: budget({ totalTokens: base.layers.l1 + base.layers.l4 - 1 }),
			retrieve,
		});

		expect(result.dropped.map((entry) => entry.layer)).toEqual([
			"l3",
			"l2",
			"l1",
		]);
		expect(result.layers.l4).toBe(base.layers.l4);
		expect(
			result.messages.some(
				(message) =>
					message.role === "user" && message.content.includes("xxxx"),
			),
		).toBe(true);
	});

	it("reserves l0 out of the message budget", () => {
		const budgetHere: ContextBudget = {
			totalTokens: 1000,
			quotas: { l1: 300, l2: 0, l3: 0 },
		};
		const result = assembleContext({
			record: record(growthTurns(200)),
			thread: { id: SESSION, summary: "" },
			inbound: [inbound({ text: "y".repeat(400) })],
			workspaceRoot: WORKSPACE,
			budget: budgetHere,
		});

		// l0 takes 700 tokens, so the recent window cannot fill its own quota
		// once the inbound is counted.
		expect(result.layers.l0).toBe(700);
		expect(result.dropped.map((entry) => entry.layer)).toEqual(["l1"]);
		expect(result.layers.l1).toBe(0);
		expect(result.layers.l4).toBeGreaterThan(0);
		expect(estimateTokens(result.messages)).toBeLessThanOrEqual(
			budgetHere.totalTokens - result.layers.l0,
		);
	});

	it("keeps a tool call paired with its result when the window is cut", () => {
		const oldTurn = turn({
			id: "trn_00000000000000000000000000000002",
			seq: 1,
			messages: [{ role: "user", content: "o".repeat(400) }],
		});
		const toolTurn = turn({
			id: "trn_00000000000000000000000000000003",
			seq: 2,
			at: 2000,
			messages: [
				{ role: "user", content: "read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_call",
							id: "call_1",
							name: "read",
							args: { path: "x" },
						},
					],
				},
				{ role: "tool", toolCallId: "call_1", content: "file contents" },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
		});

		const wide = assembleContext({
			record: record([oldTurn, toolTurn]),
			thread: { id: SESSION, summary: "" },
			inbound: [inbound()],
			workspaceRoot: WORKSPACE,
			budget: budget(),
		});
		// The recent-window quota keeps the tool turn whole and drops the old
		// turn at its user boundary.
		const narrow = assembleContext({
			record: record([oldTurn, toolTurn]),
			thread: { id: SESSION, summary: "" },
			inbound: [inbound()],
			workspaceRoot: WORKSPACE,
			budget: budget({ quotas: { l1: 30, l2: 0, l3: 0 } }),
		});

		expect(wide.messages.some((message) => message.role === "tool")).toBe(true);
		expect(pairingHolds(wide.messages)).toBe(true);
		expect(pairingHolds(narrow.messages)).toBe(true);
		expect(narrow.messages.some((message) => message.role === "tool")).toBe(
			true,
		);
		expect(
			narrow.messages.some(
				(message) =>
					message.role === "user" && message.content === "o".repeat(400),
			),
		).toBe(false);
		expect(narrow.messages[0]).toEqual({
			role: "user",
			content: "read the file",
		});
	});

	it("carries the thread summary as a system message when set", () => {
		const result = assembleContext({
			record: record(growthTurns(1)),
			thread: { id: SESSION, summary: "decided: use the ledger" },
			inbound: [inbound()],
			workspaceRoot: WORKSPACE,
			budget: budget(),
		});

		expect(result.messages).toContainEqual({
			role: "system",
			content: "decided: use the ledger",
		});
	});

	it("renders the inbound as a trailing user message and reserves l0", () => {
		const budgetHere = budget();
		const result = assembleContext({
			record: record(growthTurns(1)),
			thread: { id: SESSION, summary: "" },
			inbound: [inbound({ text: "latest ask" })],
			workspaceRoot: WORKSPACE,
			budget: budgetHere,
		});

		expect(result.messages.at(-1)).toEqual({
			role: "user",
			content: "[from user] latest ask",
		});
		expect(result.layers.l0).toBe(
			budgetHere.totalTokens -
				budgetHere.quotas.l1 -
				budgetHere.quotas.l2 -
				budgetHere.quotas.l3,
		);
	});
});
