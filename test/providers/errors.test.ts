import { describe, expect, it } from "vitest";
import {
	friendlyProviderError,
	type ProviderErrorContext,
} from "../../src/providers/errors.js";

const context: ProviderErrorContext = {
	baseURL: "http://127.0.0.1:9",
	apiKeyEnv: "DEEPSEEK_API_KEY",
};

describe("friendlyProviderError", () => {
	it("names the key variable on a 401", () => {
		expect(friendlyProviderError({ status: 401 }, context)).toBe(
			"The API key was rejected. Set a valid DEEPSEEK_API_KEY and try again.",
		);
	});

	it("reports an out-of-credit account on a 402", () => {
		expect(friendlyProviderError({ status: 402 }, context)).toBe(
			"The account is out of credit. Add credit to the provider account and try again.",
		);
	});

	it("treats an insufficient balance message as out of credit", () => {
		expect(
			friendlyProviderError(
				{ status: 400, message: "Insufficient Balance" },
				context,
			),
		).toBe(
			"The account is out of credit. Add credit to the provider account and try again.",
		);
	});

	it("reports the rate limit on a 429", () => {
		expect(friendlyProviderError({ status: 429 }, context)).toBe(
			"Rate limit reached. The SDK already retried; try again in a moment.",
		);
	});

	it("points at my-agent config when the model is not found", () => {
		expect(friendlyProviderError({ status: 404 }, context)).toBe(
			'The model name was rejected. Run "my-agent config" to check the configured model.',
		);
	});

	it("reports an unreachable endpoint for an SDK connection error", () => {
		class APIConnectionError extends Error {}
		expect(
			friendlyProviderError(
				new APIConnectionError("Connection error."),
				context,
			),
		).toBe(
			"Could not reach the provider endpoint at http://127.0.0.1:9. Check the baseURL and your network connection.",
		);
	});

	it("reports an unreachable endpoint for an ENOTFOUND code", () => {
		expect(
			friendlyProviderError(
				{
					code: "ENOTFOUND",
					message: "getaddrinfo ENOTFOUND api.deepseek.com",
				},
				context,
			),
		).toBe(
			"Could not reach the provider endpoint at http://127.0.0.1:9. Check the baseURL and your network connection.",
		);
	});

	it("reads the network code from the cause chain", () => {
		expect(
			friendlyProviderError(
				{ name: "APIConnectionError", cause: { code: "ECONNREFUSED" } },
				context,
			),
		).toBe(
			"Could not reach the provider endpoint at http://127.0.0.1:9. Check the baseURL and your network connection.",
		);
	});

	it("reports an unreachable endpoint for a connection timeout", () => {
		expect(
			friendlyProviderError(
				{ name: "APIConnectionTimeoutError", message: "Connection timed out." },
				context,
			),
		).toBe(
			"Could not reach the provider endpoint at http://127.0.0.1:9. Check the baseURL and your network connection.",
		);
	});

	it("appends the raw error only when debug is on", () => {
		const error = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" };

		expect(friendlyProviderError(error, context)).not.toContain("[debug]");
		expect(friendlyProviderError(error, { ...context, debug: true })).toBe(
			"Could not reach the provider endpoint at http://127.0.0.1:9. Check the baseURL and your network connection.\n[debug] getaddrinfo ENOTFOUND host",
		);
	});
});
