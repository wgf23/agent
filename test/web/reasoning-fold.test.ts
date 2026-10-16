import { describe, expect, it } from "vitest";
import { reasoningOpen } from "../../web/src/state";

describe("reasoningOpen", () => {
	it("opens while streaming and collapses when the turn ends", () => {
		expect(reasoningOpen(true, null)).toBe(true);
		expect(reasoningOpen(false, null)).toBe(false);
	});

	it("lets a manual toggle override the streaming default", () => {
		expect(reasoningOpen(true, false)).toBe(false);
		expect(reasoningOpen(false, true)).toBe(true);
	});
});
