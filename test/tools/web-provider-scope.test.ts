// QA provider-scope coverage for the host (team) web tools.
//
// Scope: docs/design/web-tools.md §7.1 AC-W1 / AC-W3 and
//        docs/prd/web-tools-provider-scope.md AC-P1/P2/P5.
//
// These tests exercise the TEAM implementation only — `webTools()` from
// src/tools/web.ts, which all four team backends consume via the bridge. They
// deliberately do NOT go through `registry.execute()` (that is the single-agent
// path, covered by web_search.test.ts) so a change to one path cannot silently
// pass as the other.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { webTools } from "../../src/tools/web.js";

function stubFetch(route: (url: string) => Response): typeof fetch {
	return (async (input: string | URL | Request) =>
		route(String(input))) as unknown as typeof fetch;
}

// The team web_search tool with the egress probe skipped so the assertions are
// about provider routing, not host reachability.
function teamSearch(
	fetchImpl: typeof fetch,
	deps: { searxngUrl?: string } = {},
) {
	const found = webTools({
		fetchImpl,
		skipEgressProbe: true,
		...deps,
	}).find((candidate) => candidate.name === "web_search");
	if (found === undefined) throw new Error("missing team tool web_search");
	return found;
}

function ctx(workspaceRoot: string): ToolContext {
	return { workspaceRoot };
}

const SEARX_JSON = JSON.stringify({
	results: [
		{ title: "Host result", url: "https://host.example", content: "s" },
	],
});
const DDG_HTML =
	'<a class="result__a" href="https://ddg.example/hit">DDG hit</a>';

let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "web-provider-"));
	// A fresh workspace with no search config: the team path must not need it.
	for (const key of ["SEARXNG_URL", "BRAVE_API_KEY", "TAVILY_API_KEY"]) {
		savedEnv[key] = process.env[key];
		vi.stubEnv(key, undefined);
	}
});

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value !== undefined) process.env[key] = value;
	}
	await rm(workspace, { recursive: true, force: true });
});

describe("AC-W1: team web_search reads only $SEARXNG_URL / DuckDuckGo", () => {
	it("defaults to http://localhost:8080 when $SEARXNG_URL is unset", async () => {
		const calls: string[] = [];
		const fetchImpl = stubFetch((url) => {
			calls.push(url);
			return new Response(SEARX_JSON, { status: 200 });
		});

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(true);
		expect(calls[0]).toBe("http://localhost:8080/search?q=q&format=json");
	});

	it("honors the $SEARXNG_URL override", async () => {
		vi.stubEnv("SEARXNG_URL", "http://searx.internal:9999");
		const calls: string[] = [];
		const fetchImpl = stubFetch((url) => {
			calls.push(url);
			return new Response(SEARX_JSON, { status: 200 });
		});

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(true);
		expect(calls[0]).toBe("http://searx.internal:9999/search?q=q&format=json");
	});

	it("never touches brave/tavily even with search.provider=brave configured and no keys", async () => {
		// A single-agent-style config in the workspace that names brave. The team
		// path must ignore it entirely and still succeed over SearXNG.
		await writeFile(
			path.join(workspace, "my-agent.json"),
			JSON.stringify({
				search: { provider: "brave", apiKeyEnv: "BRAVE_API_KEY" },
			}),
			"utf8",
		);
		const calls: string[] = [];
		const fetchImpl = stubFetch((url) => {
			calls.push(url);
			return new Response(SEARX_JSON, { status: 200 });
		});

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(true);
		expect(calls.every((url) => !url.includes("api.search.brave.com"))).toBe(
			true,
		);
		expect(calls.every((url) => !url.includes("api.tavily.com"))).toBe(true);
		expect(calls.some((url) => url.includes("/search?q="))).toBe(true);
	});

	it("still answers over DDG when SearXNG is down, without brave/tavily keys", async () => {
		const calls: string[] = [];
		const fetchImpl = stubFetch((url) => {
			calls.push(url);
			if (url.includes("/search?q=")) {
				return new Response("down", { status: 500 });
			}
			return new Response(DDG_HTML, { status: 200 });
		});

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.output).toContain("https://ddg.example/hit");
		expect(calls.some((url) => url.includes("html.duckduckgo.com"))).toBe(true);
		expect(calls.every((url) => !url.includes("api.search.brave.com"))).toBe(
			true,
		);
		expect(calls.every((url) => !url.includes("api.tavily.com"))).toBe(true);
	});
});

describe("AC-W3: searxng + DDG both fail -> readable reason, not a key error", () => {
	it("reports a readable failure when both endpoints return HTTP errors", async () => {
		const fetchImpl = stubFetch(() => new Response("boom", { status: 503 }));

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("web_search failed");
			expect(result.error).not.toMatch(/brave|tavily|apiKey/i);
		}
	});

	it("reports a readable failure when both endpoints are unreachable", async () => {
		const fetchImpl = stubFetch(() => {
			throw new Error("ENETUNREACH");
		});

		const result = await teamSearch(fetchImpl).execute(
			{ query: "q" },
			ctx(workspace),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toMatch(/brave|tavily|apiKey/i);
		}
	});
});
