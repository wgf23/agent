import { describe, expect, it } from "vitest";
import { redactMcpServer } from "../../src/mcp/redact.js";

describe("redactMcpServer", () => {
	it("replaces a configured secret wherever it appears", () => {
		const text = "connect failed: token=sk-live-123 rejected";
		expect(redactMcpServer(text, { API_KEY: "sk-live-123" })).toBe(
			"connect failed: token=«redacted» rejected",
		);
	});

	it("replaces every occurrence, not just the first", () => {
		expect(redactMcpServer("a s3cret b s3cret", { K: "s3cret" })).toBe(
			"a «redacted» b «redacted»",
		);
	});

	it("redacts the longest value first so a shorter prefix leaves no fragment", () => {
		const text = "value=abcdef";
		const redacted = redactMcpServer(text, { SHORT: "abc", LONG: "abcdef" });
		expect(redacted).toBe("value=«redacted»");
		expect(redacted).not.toContain("def");
	});

	it("leaves text untouched when nothing matches", () => {
		expect(redactMcpServer("plain error", { K: "unrelated" })).toBe(
			"plain error",
		);
	});

	it("skips empty and single-character values so ordinary text survives", () => {
		const text = "server a failed";
		expect(redactMcpServer(text, { EMPTY: "", ONE: "a" })).toBe(text);
	});

	it("handles a server with no env at all", () => {
		expect(redactMcpServer("boom", {})).toBe("boom");
	});
});
