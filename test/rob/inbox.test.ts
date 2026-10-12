import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../../src/rob/inbox.js";

describe("AsyncQueue", () => {
	it("drain returns the queued items and empties the queue", () => {
		const queue = new AsyncQueue<number>();
		queue.push(1);
		queue.push(2);

		expect(queue.drain()).toEqual([1, 2]);
		expect(queue.drain()).toEqual([]);
		expect(queue.size).toBe(0);
	});

	it("next resolves immediately when items are already queued", async () => {
		const queue = new AsyncQueue<string>();
		queue.push("a");

		expect(await queue.next()).toEqual(["a"]);
	});

	it("next waits for a push and then resolves with the batch", async () => {
		const queue = new AsyncQueue<string>();
		let settled = false;
		const pending = queue.next().then((items) => {
			settled = true;
			return items;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);

		queue.push("first");
		queue.push("second");

		expect(await pending).toEqual(["first", "second"]);
	});
});
