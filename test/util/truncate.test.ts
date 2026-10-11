import { describe, expect, it } from "vitest";
import { truncateOutput } from "../../src/util/truncate.js";

describe("truncateOutput", () => {
	it("leaves short text untouched", () => {
		expect(truncateOutput("a\nb")).toEqual({ text: "a\nb", truncated: false });
	});

	it("cuts whole lines and reports the count", () => {
		expect(truncateOutput("a\nb\nc\nd", { maxLines: 2 })).toEqual({
			text: "a\nb\n[truncated: 2 lines cut]",
			truncated: true,
		});
	});

	it("cuts bytes and reports the count", () => {
		expect(truncateOutput("abcdef", { maxBytes: 4 })).toEqual({
			text: "abcd\n[truncated: 2 bytes cut]",
			truncated: true,
		});
	});

	it("reports both lines and bytes when both limits are exceeded", () => {
		expect(
			truncateOutput("aaaa\nbbbb\ncccc", { maxLines: 2, maxBytes: 5 }),
		).toEqual({
			text: "aaaa\n\n[truncated: 1 lines and 4 bytes cut]",
			truncated: true,
		});
	});
});
