import { describe, expect, it } from "vitest";
import {
	createAllowAll,
	parseAllowAllArg,
} from "../../src/permissions/allow-all.js";

describe("createAllowAll", () => {
	it("reports the value and publishes each change once", () => {
		const allowAll = createAllowAll();
		const seen: boolean[] = [];
		const unsubscribe = allowAll.subscribe((on) => seen.push(on));

		allowAll.set(true);
		allowAll.set(true);
		allowAll.set(false);
		unsubscribe();
		allowAll.set(true);

		expect(seen).toEqual([true, false]);
		expect(allowAll.get()).toBe(true);
	});

	it("starts on when initialized true", () => {
		expect(createAllowAll(true).get()).toBe(true);
	});
});

describe("parseAllowAllArg", () => {
	it("maps on, off, and empty to the next value", () => {
		const allowAll = createAllowAll();

		expect(parseAllowAllArg(allowAll, "on")).toBe(true);
		expect(parseAllowAllArg(allowAll, "off")).toBe(false);
		expect(parseAllowAllArg(allowAll, "")).toBe(true);
	});

	it("rejects any other argument", () => {
		expect(parseAllowAllArg(createAllowAll(), "maybe")).toBeNull();
	});
});
