import { describe, expect, it } from "vitest";
import { resolveModelSpec } from "../../src/providers/presets.js";

describe("resolveModelSpec", () => {
	it("resolves a bare DeepSeek model name to the deepseek preset", () => {
		expect(resolveModelSpec("deepseek-flash")).toEqual({
			ok: true,
			preset: "deepseek",
			model: "deepseek-flash",
		});
	});

	it("resolves a prefixed DeepSeek model", () => {
		expect(resolveModelSpec("deepseek/deepseek-flash")).toEqual({
			ok: true,
			preset: "deepseek",
			model: "deepseek-flash",
		});
	});

	it("resolves an OpenAI model", () => {
		expect(resolveModelSpec("openai/gpt-4o")).toEqual({
			ok: true,
			preset: "openai",
			model: "gpt-4o",
		});
	});

	it("rejects a bare non-DeepSeek model name", () => {
		expect(resolveModelSpec("gpt-4o")).toEqual({
			ok: false,
			error:
				'Unknown model "gpt-4o". Use "deepseek/<model>", "openai/<model>", or a model name starting with "deepseek".',
		});
	});
});
