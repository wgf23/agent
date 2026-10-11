import { errorMessage } from "../util/errors.js";

export interface ProviderErrorContext {
	baseURL: string;
	apiKeyEnv: string;
	debug?: boolean;
}

const NETWORK_CODES = new Set([
	"ENOTFOUND",
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

export function friendlyProviderError(
	error: unknown,
	context: ProviderErrorContext,
): string {
	const friendly = classify(error, context);
	if (context.debug === true) {
		return `${friendly}\n[debug] ${rawMessage(error)}`;
	}
	return friendly;
}

function classify(error: unknown, context: ProviderErrorContext): string {
	const status = numberProperty(error, "status");
	const code = codeChain(error);
	const message = rawMessage(error);
	const lower = message.toLowerCase();

	if (status === 401) {
		return `The API key was rejected. Set a valid ${context.apiKeyEnv} and try again.`;
	}
	if (
		status === 402 ||
		/insufficient balance|out of credit|no credit|account balance/.test(lower)
	) {
		return "The account is out of credit. Add credit to the provider account and try again.";
	}
	if (status === 429) {
		return "Rate limit reached. The SDK already retried; try again in a moment.";
	}
	if (
		status === 404 ||
		code === "model_not_found" ||
		/model.*(?:not found|does not exist|unknown model)/.test(lower)
	) {
		return 'The model name was rejected. Run "my-agent config" to check the configured model.';
	}
	if (isNetworkError(error, code, lower)) {
		return `Could not reach the provider endpoint at ${context.baseURL}. Check the baseURL and your network connection.`;
	}
	return message;
}

function isNetworkError(
	error: unknown,
	code: string | undefined,
	lower: string,
): boolean {
	if (code !== undefined && NETWORK_CODES.has(code)) return true;
	const name = stringProperty(error, "name") ?? "";
	const constructorName =
		typeof error === "object" && error !== null
			? (error.constructor?.name ?? "")
			: "";
	if (
		name.includes("APIConnection") ||
		constructorName.includes("APIConnection")
	) {
		return true;
	}
	return /fetch failed|socket hang up|timed out|timeout|econnrefused|enotfound|getaddrinfo/.test(
		lower,
	);
}

function codeChain(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current !== null; depth += 1) {
		const code = stringProperty(current, "code");
		if (code !== undefined) return code;
		current = property(current, "cause");
	}
	return undefined;
}

function rawMessage(error: unknown): string {
	const message = stringProperty(error, "message");
	if (message !== undefined) return message;
	return errorMessage(error);
}

function numberProperty(value: unknown, key: string): number | undefined {
	const found = property(value, key);
	return typeof found === "number" ? found : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
	const found = property(value, key);
	return typeof found === "string" ? found : undefined;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}
