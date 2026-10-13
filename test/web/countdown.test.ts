import { describe, expect, it } from "vitest";
import {
	formatCountdown,
	isUrgent,
	remainingSeconds,
	WARN_BEFORE_MS,
} from "../../web/src/countdown";

// The modal's label is the only place the pressure of an approval is visible,
// and there is no browser here to render it, so the arithmetic it renders from
// is pinned directly.
describe("remainingSeconds", () => {
	it("counts down in whole seconds and never below zero", () => {
		const expiresAt = 1_000_000;
		expect(remainingSeconds(expiresAt, 1_000_000)).toBe(0);
		expect(remainingSeconds(expiresAt, 999_000)).toBe(1);
		expect(remainingSeconds(expiresAt, 993_000)).toBe(7);
		expect(remainingSeconds(expiresAt, 760_000)).toBe(240);
		// A past deadline reads 0, not a negative count the label would show.
		expect(remainingSeconds(expiresAt, 1_100_000)).toBe(0);
	});

	it("rounds up, so the label only reaches 0:00 at the deadline", () => {
		expect(remainingSeconds(10_000, 9_001)).toBe(1);
		expect(remainingSeconds(10_000, 9_000)).toBe(1);
		expect(remainingSeconds(10_000, 8_999)).toBe(2);
	});
});

describe("formatCountdown", () => {
	it("renders minutes and zero-padded seconds", () => {
		expect(formatCountdown(0)).toBe("0:00");
		expect(formatCountdown(9)).toBe("0:09");
		expect(formatCountdown(59)).toBe("0:59");
		expect(formatCountdown(60)).toBe("1:00");
		expect(formatCountdown(247)).toBe("4:07");
		expect(formatCountdown(300)).toBe("5:00");
	});
});

describe("isUrgent", () => {
	it("warns only inside the last half minute", () => {
		const expiresAt = 1_000_000;
		expect(isUrgent(expiresAt, expiresAt - WARN_BEFORE_MS - 1)).toBe(false);
		expect(isUrgent(expiresAt, expiresAt - WARN_BEFORE_MS)).toBe(true);
		expect(isUrgent(expiresAt, expiresAt - 5_000)).toBe(true);
		// An expired deadline stays in the warning state rather than reverting.
		expect(isUrgent(expiresAt, expiresAt + 1)).toBe(true);
	});
});
