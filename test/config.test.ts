import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY;

describe("loadConfig", () => {
	beforeEach(() => {
		delete process.env.DEEPSEEK_API_KEY;
	});

	afterEach(() => {
		if (ORIGINAL_KEY === undefined) {
			delete process.env.DEEPSEEK_API_KEY;
		} else {
			process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY;
		}
	});

	it("returns an error when DEEPSEEK_API_KEY is missing", () => {
		expect(loadConfig()).toEqual({
			ok: false,
			error:
				"Missing DEEPSEEK_API_KEY. Set it in your environment and try again.",
		});
	});

	it("returns the deepseek defaults when DEEPSEEK_API_KEY is set", () => {
		process.env.DEEPSEEK_API_KEY = "test-key";

		expect(loadConfig()).toEqual({
			ok: true,
			config: {
				provider: {
					preset: "deepseek",
					model: "deepseek-flash",
					baseURL: "https://api.deepseek.com",
					apiKey: "test-key",
				},
			},
		});
	});
});
