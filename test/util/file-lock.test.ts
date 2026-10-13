import { describe, expect, it } from "vitest";
import { withFileLock } from "../../src/util/file-lock.js";

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("withFileLock", () => {
	it("runs two calls on one path strictly one after another", async () => {
		const events: string[] = [];
		const first = withFileLock("/tmp/opencode/lock-one", async () => {
			events.push("first:start");
			await tick();
			events.push("first:end");
		});
		const second = withFileLock("/tmp/opencode/lock-one", async () => {
			events.push("second:start");
			await tick();
			events.push("second:end");
		});

		await Promise.all([first, second]);

		expect(events).toEqual([
			"first:start",
			"first:end",
			"second:start",
			"second:end",
		]);
	});

	it("overlaps calls on two different paths", async () => {
		const events: string[] = [];
		await Promise.all([
			withFileLock("/tmp/opencode/lock-a", async () => {
				events.push("a:start");
				await tick();
				events.push("a:end");
			}),
			withFileLock("/tmp/opencode/lock-b", async () => {
				events.push("b:start");
				await tick();
				events.push("b:end");
			}),
		]);

		expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
		expect(events.indexOf("a:end")).toBeGreaterThan(events.indexOf("b:start"));
		expect(events.indexOf("b:end")).toBeGreaterThan(events.indexOf("a:start"));
	});

	it("releases the lock when fn rejects", async () => {
		const events: string[] = [];
		const first = withFileLock("/tmp/opencode/lock-reject", async () => {
			events.push("first:start");
			throw new Error("boom");
		});

		await expect(first).rejects.toThrow("boom");
		await withFileLock("/tmp/opencode/lock-reject", async () => {
			events.push("second:start");
		});

		expect(events).toEqual(["first:start", "second:start"]);
	});
});
