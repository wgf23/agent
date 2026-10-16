import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../../src/bot/channel.js";

function makeRegistry() {
	let seq = 0;
	let now = 100;
	return {
		registry: new ChannelRegistry({
			clock: () => now,
			newId: () => {
				seq += 1;
				return `chs_${String(seq).padStart(4, "0")}`;
			},
		}),
		advance: (ms: number): void => {
			now += ms;
		},
	};
}

describe("ChannelRegistry", () => {
	it("opens a channel lazily and keeps it current", () => {
		const { registry } = makeRegistry();

		const first = registry.current("writer");
		expect(first).toEqual({
			id: "chs_0001",
			bot: "writer",
			openedAt: 100,
			closedAt: null,
		});
		expect(registry.current("writer").id).toBe(first.id);
	});

	it("closes the current channel when a new one opens", () => {
		const { registry, advance } = makeRegistry();

		registry.current("writer");
		advance(5);
		const second = registry.open("writer");

		expect(second.id).toBe("chs_0002");
		expect(registry.current("writer").id).toBe("chs_0002");
		expect(registry.list("writer")).toEqual([
			{
				id: "chs_0001",
				bot: "writer",
				openedAt: 100,
				closedAt: 105,
			},
			{
				id: "chs_0002",
				bot: "writer",
				openedAt: 105,
				closedAt: null,
			},
		]);
	});

	it("closes a matching id and opens a fresh current one", () => {
		const { registry } = makeRegistry();

		const first = registry.current("writer");
		const matched = registry.close("writer", first.id);

		expect(matched).toBe(true);
		expect(registry.current("writer").id).not.toBe(first.id);
		expect(registry.list("writer")[0].closedAt).not.toBeNull();
	});

	it("returns false for an unknown id but still opens a fresh current one", () => {
		const { registry } = makeRegistry();
		registry.current("writer");

		expect(registry.close("writer", "chs_ffff")).toBe(false);
		expect(registry.current("writer").id).toBe("chs_0002");
	});

	it("focuses an id replayed from the ledger", () => {
		const { registry } = makeRegistry();
		registry.current("writer");

		const focused = registry.focus("writer", "chs_past");
		expect(focused.id).toBe("chs_past");
		expect(registry.current("writer").id).toBe("chs_past");
		expect(registry.list("writer").map((session) => session.id)).toEqual([
			"chs_0001",
			"chs_past",
		]);
	});

	it("hands out copies that cannot mutate the registry", () => {
		const { registry } = makeRegistry();
		const session = registry.current("writer");
		session.closedAt = 999;

		expect(registry.current("writer").closedAt).toBeNull();
		expect(registry.list("writer")[0].closedAt).toBeNull();
	});

	it("disposes one bot or the whole registry", () => {
		const { registry } = makeRegistry();
		registry.current("writer");
		registry.current("planner");

		registry.dispose("writer");
		expect(registry.list("writer")).toEqual([]);

		registry.dispose();
		expect(registry.list("planner")).toEqual([]);
	});
});
