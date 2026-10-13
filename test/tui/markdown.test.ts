import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/tui/markdown.js";

describe("parseMarkdown", () => {
	it("renders headings without the leading hashes", () => {
		expect(parseMarkdown("# Title")).toEqual([
			{ kind: "heading", text: "Title" },
		]);
		expect(parseMarkdown("## Sub heading")).toEqual([
			{ kind: "heading", text: "Sub heading" },
		]);
	});

	it("keeps an unclosed fence as a code block", () => {
		expect(parseMarkdown("```\nconst x = 1\nconst y = 2")).toEqual([
			{ kind: "code", text: "const x = 1\nconst y = 2" },
		]);
	});

	it("renders dash lines as bullets", () => {
		expect(parseMarkdown("- one\n- two")).toEqual([
			{ kind: "bullet", text: "one" },
			{ kind: "bullet", text: "two" },
		]);
	});

	it("falls back to plain text", () => {
		expect(parseMarkdown("hello world")).toEqual([
			{ kind: "text", text: "hello world" },
		]);
	});

	it("closes a fence and resumes plain text", () => {
		expect(parseMarkdown("```\ncode\n```\nafter")).toEqual([
			{ kind: "code", text: "code" },
			{ kind: "text", text: "after" },
		]);
	});
});
