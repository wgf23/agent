import { describe, expect, it } from "vitest";
import { addedLines, lineDiff } from "../../src/tui/diff.js";

describe("lineDiff", () => {
	it("marks a replaced line as removed then added", () => {
		expect(lineDiff("const a = 1;\n", "const a = 2;\n")).toEqual([
			{ kind: "remove", text: "const a = 1;" },
			{ kind: "add", text: "const a = 2;" },
		]);
	});

	it("keeps unchanged lines as context", () => {
		expect(lineDiff("a\nb\n", "a\nc\n")).toEqual([
			{ kind: "context", text: "a" },
			{ kind: "remove", text: "b" },
			{ kind: "add", text: "c" },
		]);
	});
});

describe("addedLines", () => {
	it("caps write_file content at 20 lines and reports the rest", () => {
		const content = Array.from(
			{ length: 25 },
			(_, index) => `line ${index + 1}`,
		).join("\n");

		const result = addedLines(content);

		expect(result.lines).toHaveLength(20);
		expect(result.lines[0]).toBe("line 1");
		expect(result.lines[19]).toBe("line 20");
		expect(result.omitted).toBe(5);
	});

	it("does not report omissions under the cap", () => {
		expect(addedLines("a\nb")).toEqual({ lines: ["a", "b"], omitted: 0 });
	});
});
