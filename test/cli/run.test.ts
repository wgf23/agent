import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodeForReason, runHeadless } from "../../src/cli/run.js";

describe("exitCodeForReason", () => {
	it("maps finished to 0 and every other reason to 1", () => {
		expect(exitCodeForReason("finished")).toBe(0);
		expect(exitCodeForReason("max_steps")).toBe(1);
		expect(exitCodeForReason("aborted")).toBe(1);
		expect(exitCodeForReason("error")).toBe(1);
	});
});

describe("runHeadless", () => {
	const originalKey = process.env.DEEPSEEK_API_KEY;

	beforeEach(() => {
		delete process.env.DEEPSEEK_API_KEY;
	});

	afterEach(() => {
		if (originalKey === undefined) {
			delete process.env.DEEPSEEK_API_KEY;
		} else {
			process.env.DEEPSEEK_API_KEY = originalKey;
		}
	});

	it("returns 1 and prints the missing-key message without a key", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const code = await runHeadless({ prompt: "hi" });

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				"Missing DEEPSEEK_API_KEY. Set it in your environment and try again.",
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
