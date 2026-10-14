import { describe, expect, it } from "vitest";
import { subagentLine } from "../../web/src/subagent";

// The web feed must read exactly like the TUI's SubagentView, so these assert
// the literal strings the two surfaces share.
describe("subagentLine", () => {
	it("maps each event to the same line the TUI renders", () => {
		expect(subagentLine({ type: "text_delta", text: "hello sub" })).toBe(
			"hello sub",
		);
		expect(
			subagentLine({
				type: "tool_started",
				id: "t1",
				name: "read_file",
				args: { path: "a.txt" },
			}),
		).toBe("tool read_file started");
		expect(
			subagentLine({
				type: "tool_finished",
				id: "t1",
				name: "read_file",
				ok: true,
				status: "ok",
				summary: "a.txt",
				output: "hi",
			}),
		).toBe("tool read_file ok");
		expect(subagentLine({ type: "error", message: "boom" })).toBe(
			"error: boom",
		);
		expect(subagentLine({ type: "done", reason: "finished", steps: 2 })).toBe(
			"done (finished)",
		);
	});

	it("maps events with no user-facing line to an empty string", () => {
		expect(
			subagentLine({ type: "usage", inputTokens: 1, outputTokens: 2 }),
		).toBe("");
		expect(
			subagentLine({ type: "compacted", removedMessages: 3, summaryChars: 10 }),
		).toBe("");
		expect(subagentLine({ type: "reasoning_delta", text: "thinking" })).toBe(
			"",
		);
	});
});
