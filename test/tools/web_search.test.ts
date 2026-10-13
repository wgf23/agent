import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultRules,
	resolveAction,
	toolSubject,
} from "../../src/permissions/rules.js";
import { execute, getTool } from "../../src/tools/registry.js";

let homeDir: string;
let workspace: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-search-home-"));
	workspace = await mkdtemp(path.join(tmpdir(), "my-agent-search-ws-"));
	// The tool reads the global config from os.homedir(); point HOME at a fresh
	// directory so no real global config or credentials leak into the test.
	vi.stubEnv("HOME", homeDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(homeDir, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

async function writeSearch(config: unknown): Promise<void> {
	await writeFile(
		path.join(workspace, "my-agent.json"),
		JSON.stringify(config),
		"utf8",
	);
}

describe("web_search", () => {
	it("is a read-only tool that asks and returns the query as its subject", () => {
		expect(getTool("web_search")?.name).toBe("web_search");
		expect(getTool("web_search")?.readOnly).toBe(true);
		expect(defaultRules().web_search).toBe("ask");
		expect(resolveAction(defaultRules(), "web_search", "hello world")).toBe(
			"ask",
		);
		expect(toolSubject("web_search", { query: "hello world" })).toBe(
			"hello world",
		);
	});

	it("maps brave results to a numbered list", async () => {
		await writeSearch({ search: { provider: "brave" } });
		vi.stubEnv("BRAVE_API_KEY", "brave-key");
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						web: {
							results: [
								{
									title: "Brave One",
									url: "https://one.example",
									description: "First hit",
								},
								{
									title: "Brave Two",
									url: "https://two.example",
									description: "Second hit",
								},
							],
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output:
				"1. Brave One\n   https://one.example\n   First hit\n2. Brave Two\n   https://two.example\n   Second hit",
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.search.brave.com/res/v1/web/search?q=test&count=5",
		);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
			"X-Subscription-Token": "brave-key",
		});
	});

	it("maps tavily results to a numbered list via a JSON POST", async () => {
		await writeSearch({ search: { provider: "tavily" } });
		vi.stubEnv("TAVILY_API_KEY", "tavily-key");
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						results: [
							{
								title: "Tavily One",
								url: "https://tav.example/1",
								content: "Tav first",
							},
							{
								title: "Tavily Two",
								url: "https://tav.example/2",
								content: "Tav second",
							},
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_search",
			{ query: "test", count: 3 },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output:
				"1. Tavily One\n   https://tav.example/1\n   Tav first\n2. Tavily Two\n   https://tav.example/2\n   Tav second",
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tavily.com/search");
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
		expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
			api_key: "tavily-key",
			query: "test",
			max_results: 3,
		});
	});

	it("maps searxng results to a numbered list", async () => {
		await writeSearch({
			search: { provider: "searxng", baseURL: "https://searx.example.com" },
		});
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						results: [
							{
								title: "Searx One",
								url: "https://sx.example/1",
								content: "SX first",
							},
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output: "1. Searx One\n   https://sx.example/1\n   SX first",
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://searx.example.com/search?q=test&format=json",
		);
	});

	it("returns an error naming the config when the key is missing", async () => {
		await writeSearch({ search: { provider: "brave" } });
		vi.stubEnv("BRAVE_API_KEY", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: false,
			error:
				'web_search: no API key. Set the BRAVE_API_KEY environment variable, or point "search.apiKeyEnv" at the variable that holds your key.',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns an error naming the config when searxng has no base URL", async () => {
		await writeSearch({ search: { provider: "searxng" } });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: false,
			error:
				'web_search: searxng needs a base URL. Set "search.baseURL" in the project or global config, or pick a different "search.provider".',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns an error for a non-2xx response", async () => {
		await writeSearch({ search: { provider: "brave" } });
		vi.stubEnv("BRAVE_API_KEY", "brave-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_url: RequestInfo | URL, _init?: RequestInit) =>
					new Response("rate limited", { status: 429 }),
			),
		);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({ ok: false, error: "web_search: HTTP 429" });
	});

	it("returns an error when the network fails", async () => {
		await writeSearch({ search: { provider: "brave" } });
		vi.stubEnv("BRAVE_API_KEY", "brave-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
				throw new TypeError("fetch failed");
			}),
		);

		const result = await execute(
			"web_search",
			{ query: "test" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({ ok: false, error: "web_search: fetch failed" });
	});
});
