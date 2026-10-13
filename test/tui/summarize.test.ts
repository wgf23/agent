import { describe, expect, it } from "vitest";
import { summarizeArgs } from "../../src/tui/summarize.js";

describe("summarizeArgs", () => {
	it("shows the path for file tools", () => {
		expect(summarizeArgs("read_file", { path: "src/a.ts" })).toBe("src/a.ts");
		expect(
			summarizeArgs("write_file", { path: "src/b.ts", content: "x" }),
		).toBe("src/b.ts");
		expect(summarizeArgs("edit_file", { path: "src/c.ts" })).toBe("src/c.ts");
	});

	it("shows the command for bash", () => {
		expect(summarizeArgs("bash", { command: "ls -la" })).toBe("ls -la");
	});

	it("truncates a bash command to 80 characters", () => {
		const command = "a".repeat(100);
		expect(summarizeArgs("bash", { command })).toBe("a".repeat(80));
	});

	it("shows the pattern for glob", () => {
		expect(summarizeArgs("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
	});

	it("shows the pattern and path for grep", () => {
		expect(summarizeArgs("grep", { pattern: "TODO", path: "src" })).toBe(
			"TODO in src",
		);
		expect(summarizeArgs("grep", { pattern: "TODO" })).toBe("TODO");
	});

	it("falls back to the first 60 characters of JSON", () => {
		expect(summarizeArgs("mystery", { foo: 1 })).toBe('{"foo":1}');
		expect(summarizeArgs("mystery", { value: "x".repeat(100) })).toBe(
			`{"value":"${"x".repeat(50)}`,
		);
	});
});
