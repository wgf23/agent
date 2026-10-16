import { describe, expect, it } from "vitest";
import { escapeHtml, highlight } from "../../web/src/highlight";

describe("highlight", () => {
	it("falls back to escaped text past the highlight cap", () => {
		const long = `<b>${"x".repeat(200_001)}</b>`;
		const out = highlight(long, "html");
		expect(out).toBe(escapeHtml(long));
		expect(out).not.toContain("<span");
	});

	it("highlights a short code body", () => {
		expect(highlight("const x = 1;", "typescript")).toContain("<span");
	});
});
