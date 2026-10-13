import { describe, expect, it } from "vitest";
import { capUiOutput, UI_OUTPUT_MAX_CHARS } from "../../src/tui/output.js";

describe("capUiOutput", () => {
	it("leaves text at the cap unchanged", () => {
		const text = "x".repeat(UI_OUTPUT_MAX_CHARS);
		expect(capUiOutput(text)).toBe(text);
	});

	it("caps longer text at 4000 characters and marks it", () => {
		const text = "x".repeat(UI_OUTPUT_MAX_CHARS + 10);

		expect(capUiOutput(text)).toBe(
			`${"x".repeat(UI_OUTPUT_MAX_CHARS)}[truncated]`,
		);
	});
});
