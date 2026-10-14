import { describe, expect, it } from "vitest";
import type { SessionSummaryInfo } from "../../shared/protocol";
import { sessionLabel } from "../../web/src/sessions";

// Both session lists route through sessionLabel, so these cases pin the label a
// row shows: the owner's title, else the first user text, else the placeholder.
function session(overrides: Partial<SessionSummaryInfo>): SessionSummaryInfo {
	return {
		id: "s1",
		updatedAt: 0,
		messageCount: 0,
		firstUserText: "",
		title: null,
		...overrides,
	};
}

describe("sessionLabel", () => {
	it("returns a titled session's title", () => {
		expect(sessionLabel(session({ title: "Greeting" }))).toBe("Greeting");
	});

	it("returns the trimmed title over the first user text", () => {
		expect(
			sessionLabel(session({ title: "  Greeting  ", firstUserText: "hi" })),
		).toBe("Greeting");
	});

	it("returns the first user text when untitled", () => {
		expect(sessionLabel(session({ firstUserText: "how are you" }))).toBe(
			"how are you",
		);
	});

	it("falls through a whitespace-only title to the first user text", () => {
		expect(sessionLabel(session({ title: "   ", firstUserText: "hi" }))).toBe(
			"hi",
		);
	});

	it("falls through a whitespace-only title with no text to the placeholder", () => {
		expect(sessionLabel(session({ title: "   ", firstUserText: "  " }))).toBe(
			"新会话",
		);
	});

	it("returns the placeholder when the session has neither", () => {
		expect(sessionLabel(session({}))).toBe("新会话");
	});
});
