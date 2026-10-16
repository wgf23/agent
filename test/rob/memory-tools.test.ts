import { describe, expect, it } from "vitest";
import { emptyDelta, type MemoryDelta } from "../../src/bot/record.js";
import { createMemoryTools } from "../../src/rob/memory-tools.js";
import type { Tool } from "../../src/tools/types.js";

const ctx = { workspaceRoot: "/ws" };

function makeTools(clock: () => number = () => 1234): {
	delta: MemoryDelta;
	tools: Tool[];
} {
	const delta = emptyDelta();
	return {
		delta,
		tools: createMemoryTools({ name: "planner", delta, clock }),
	};
}

function find(tools: Tool[], name: string): Tool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`missing ${name} tool`);
	return tool;
}

describe("createMemoryTools", () => {
	it("exposes remember and forget as non-read-only rob tools", () => {
		const { tools } = makeTools();

		expect(tools.map((tool) => tool.name)).toEqual(["remember", "forget"]);
		expect(tools.every((tool) => tool.readOnly === false)).toBe(true);
	});

	it("remember upserts a fact with the clock time and null provenance", async () => {
		const { delta, tools } = makeTools(() => 9999);

		const result = await find(tools, "remember").execute(
			{ text: "likes mangoes" },
			ctx,
		);

		expect(result).toEqual({
			ok: true,
			output: expect.stringContaining("mem_"),
		});
		expect(delta.upsert).toHaveLength(1);
		const entry = delta.upsert[0];
		expect(entry.id).toMatch(/^mem_[0-9a-f]{16}$/);
		expect(entry).toMatchObject({
			at: 9999,
			kind: "fact",
			text: "likes mangoes",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		});
	});

	it("remember honours an explicit kind and supersedes list", async () => {
		const { delta, tools } = makeTools();
		const superseded = "mem_00000000000000000000000000000001";

		await find(tools, "remember").execute(
			{ text: "prefers teal", kind: "preference", supersedes: [superseded] },
			ctx,
		);

		expect(delta.upsert[0]).toMatchObject({
			kind: "preference",
			supersedes: [superseded],
		});
	});

	it("remember rejects a digest kind and a malformed id", () => {
		const remember = find(makeTools().tools, "remember");

		expect(
			remember.schema?.safeParse({ text: "x", kind: "digest" }).success,
		).toBe(false);
		expect(
			remember.schema?.safeParse({ text: "x", supersedes: ["not-an-id"] })
				.success,
		).toBe(false);
		expect(remember.schema?.safeParse({ text: "" }).success).toBe(false);
	});

	it("forget drops the entry by id", async () => {
		const { delta, tools } = makeTools();

		const result = await find(tools, "forget").execute(
			{ id: "mem_00000000000000000000000000000001" },
			ctx,
		);

		expect(result).toEqual({
			ok: true,
			output: expect.stringContaining("mem_00000000000000000000000000000001"),
		});
		expect(delta.drop).toEqual(["mem_00000000000000000000000000000001"]);
	});
});
