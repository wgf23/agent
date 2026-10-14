import { describe, expect, it } from "vitest";
import { matchText, snippet } from "../../src/serve/search.js";

describe("matchText", () => {
	it("finds a match case-insensitively", () => {
		expect(matchText("Hello World", "WORLD")).toEqual([{ start: 6, end: 11 }]);
		expect(matchText("Hello World", "hello")).toEqual([{ start: 0, end: 5 }]);
	});

	it("returns null for a non-match", () => {
		expect(matchText("Hello World", "planet")).toBeNull();
	});

	it("returns null when the query is longer than the text", () => {
		expect(matchText("short", "a much longer query")).toBeNull();
	});

	it("returns null for a blank query rather than matching everything", () => {
		expect(matchText("Hello World", "")).toBeNull();
	});
});

describe("snippet", () => {
	it("keeps the exact query intact and bounded when the match is at the start", () => {
		const text = `needle${"x".repeat(500)}`;
		const result = snippet(text, "NEEDLE", 10);
		expect(result.toLowerCase()).toContain("needle");
		// The literal length bound: query length plus a radius on each side.
		expect(result.length).toBeLessThanOrEqual("NEEDLE".length + 10 * 2);
	});

	it("keeps the exact query intact and bounded when the match is at the end", () => {
		const text = `${"x".repeat(500)}needle`;
		const result = snippet(text, "needle", 10);
		expect(result).toContain("needle");
		expect(result.length).toBeLessThanOrEqual("needle".length + 10 * 2);
	});
});
