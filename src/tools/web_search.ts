import os from "node:os";
import { z } from "zod";
import {
	DEFAULT_SEARCH,
	resolveConfig,
	type SearchProvider,
	type SearchSettings,
} from "../config/resolve.js";
import { errorMessage } from "../util/errors.js";
import { truncateOutput } from "../util/truncate.js";
import type { Tool } from "./types.js";

const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_BASE_URL = "https://api.tavily.com/search";

const schema = z
	.object({
		query: z.string().describe("Search query to run."),
		count: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(5)
			.describe("Number of results to return, between 1 and 20."),
	})
	.strict();

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// The providers differ only in where their results live in the response and
// which field holds the snippet, so each is one row in this table rather than
// a branch per call.
const PROVIDERS: Record<
	SearchProvider,
	{ path: string[]; snippet: "description" | "content" }
> = {
	brave: { path: ["web", "results"], snippet: "description" },
	tavily: { path: ["results"], snippet: "content" },
	searxng: { path: ["results"], snippet: "content" },
};

// A ready-to-use provider: brave and tavily carry a key, searxng carries only
// its base URL. The union makes the unconfigured states unrepresentable.
type SearchConfig =
	| { provider: "brave"; apiKey: string; baseURL: string }
	| { provider: "tavily"; apiKey: string; baseURL: string }
	| { provider: "searxng"; baseURL: string };

export const webSearchTool: Tool<typeof schema> = {
	name: "web_search",
	description:
		"Search the web and return a numbered list of result titles, URLs, and snippets.",
	readOnly: true,
	schema,
	async execute(args, ctx) {
		if (ctx.signal?.aborted) {
			return { ok: false, error: "web_search: request aborted" };
		}

		const search = loadSearch(ctx.workspaceRoot);
		if (!search.ok) return { ok: false, error: search.error };

		const request = buildRequest(search.config, args.query, args.count);
		let response: Response;
		try {
			response = await fetch(request.url, {
				...request.init,
				signal: ctx.signal,
			});
		} catch (error) {
			return { ok: false, error: `web_search: ${errorMessage(error)}` };
		}
		if (!response.ok) {
			return { ok: false, error: `web_search: HTTP ${response.status}` };
		}

		let data: unknown;
		try {
			data = await response.json();
		} catch (error) {
			return { ok: false, error: `web_search: ${errorMessage(error)}` };
		}

		const results = extractResults(search.config.provider, data);
		return { ok: true, output: truncateOutput(formatResults(results)).text };
	},
};

function loadSearch(
	workspaceRoot: string,
): { ok: true; config: SearchConfig } | { ok: false; error: string } {
	const resolved = resolveConfig({
		workspaceRoot,
		env: process.env,
		homeDir: os.homedir(),
	});
	const settings: SearchSettings = resolved.ok
		? resolved.config.search
		: DEFAULT_SEARCH;

	if (settings.provider === "searxng") {
		if (settings.baseURL === undefined) {
			return {
				ok: false,
				error:
					'web_search: searxng needs a base URL. Set "search.baseURL" in the project or global config, or pick a different "search.provider".',
			};
		}
		return {
			ok: true,
			config: { provider: "searxng", baseURL: settings.baseURL },
		};
	}

	const apiKey = process.env[settings.apiKeyEnv];
	if (apiKey === undefined || apiKey === "") {
		return {
			ok: false,
			error: `web_search: no API key. Set the ${settings.apiKeyEnv} environment variable, or point "search.apiKeyEnv" at the variable that holds your key.`,
		};
	}
	const baseURL =
		settings.baseURL ??
		(settings.provider === "brave" ? BRAVE_BASE_URL : TAVILY_BASE_URL);
	return { ok: true, config: { provider: settings.provider, apiKey, baseURL } };
}

function buildRequest(
	config: SearchConfig,
	query: string,
	count: number,
): { url: string; init?: RequestInit } {
	switch (config.provider) {
		case "brave": {
			const url = new URL(config.baseURL);
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));
			return {
				url: url.toString(),
				init: { headers: { "X-Subscription-Token": config.apiKey } },
			};
		}
		case "tavily":
			return {
				url: config.baseURL,
				init: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						api_key: config.apiKey,
						query,
						max_results: count,
					}),
				},
			};
		case "searxng": {
			const url = new URL(config.baseURL);
			url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			return { url: url.toString() };
		}
	}
}

function extractResults(
	provider: SearchProvider,
	data: unknown,
): SearchResult[] {
	const { path, snippet } = PROVIDERS[provider];
	const results: SearchResult[] = [];
	for (const entry of readPath(data, path)) {
		if (!isRecord(entry)) continue;
		results.push({
			title: stringValue(entry.title),
			url: stringValue(entry.url),
			snippet: stringValue(entry[snippet]),
		});
	}
	return results;
}

function readPath(data: unknown, path: string[]): unknown[] {
	let current = data;
	for (const key of path) {
		if (!isRecord(current)) return [];
		current = current[key];
	}
	return Array.isArray(current) ? current : [];
}

function formatResults(results: SearchResult[]): string {
	return results
		.map(
			(result, index) =>
				`${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
		)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}
