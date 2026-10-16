import { describe, expect, it } from "vitest";
import type { AllowAllState } from "../../shared/protocol.js";
import {
	createAllowAll,
	parseAllowAllArg,
} from "../../src/permissions/allow-all.js";

describe("createAllowAll", () => {
	it("reports the scope and publishes each change once", () => {
		const allowAll = createAllowAll();
		const seen: AllowAllState[] = [];
		const unsubscribe = allowAll.subscribe((state) => seen.push(state));

		allowAll.set(true);
		allowAll.set(true);
		allowAll.set(false);
		unsubscribe();
		allowAll.set(true);

		expect(seen).toEqual([
			{ mode: "all", sessionId: null },
			{ mode: "off", sessionId: null },
		]);
		expect(allowAll.get()).toBe(true);
	});

	it("starts on when initialized true", () => {
		expect(createAllowAll(true).get()).toBe(true);
	});
});

describe("allowAll scope", () => {
	it("allows every session in all mode", () => {
		const allowAll = createAllowAll();
		allowAll.setMode("all", null);
		expect(allowAll.allows("s1")).toBe(true);
		expect(allowAll.allows(null)).toBe(true);
	});

	it("allows only the session it was set for", () => {
		const allowAll = createAllowAll();
		allowAll.setMode("session", "s1");
		expect(allowAll.allows("s1")).toBe(true);
		expect(allowAll.allows("s2")).toBe(false);
		expect(allowAll.allows(null)).toBe(false);
	});

	it("allows nothing in off mode and drops the session id", () => {
		const allowAll = createAllowAll();
		allowAll.setMode("session", "s1");
		allowAll.setMode("off", "s1");
		expect(allowAll.state()).toEqual({ mode: "off", sessionId: null });
		expect(allowAll.allows("s1")).toBe(false);
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
