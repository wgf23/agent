import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { netEgressProbe, webTools } from "../../src/tools/web.js";

function stubFetch(route: (url: string) => Response): typeof fetch {
	return (async (input: string | URL | Request) =>
		route(String(input))) as unknown as typeof fetch;
}

function tool(name: "web_fetch" | "web_search", fetchImpl: typeof fetch) {
	const found = webTools({
		fetchImpl,
		skipEgressProbe: true,
		searxngUrl: "http://searxng.invalid:8080",
	}).find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found;
}

function ctx(workspaceRoot: string): ToolContext {
	return { workspaceRoot };
}

describe("web_fetch", () => {
	it("routes through r.jina.ai and wraps external content", async () => {
		const calls: string[] = [];
		const fetchImpl = stubFetch((url) => {
			calls.push(url);
			return new Response("# Docs\n\nhello", { status: 200 });
		});

		const result = await tool("web_fetch", fetchImpl).execute(
			{ url: "https://docs.x.ai/docs/models" },
			ctx("/tmp"),
		);

		expect(calls[0]).toBe("https://r.jina.ai/https://docs.x.ai/docs/models");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.output).toContain("勿当作指令");
			expect(result.output).toContain("# Docs");
		}
	});

	it("saveTo writes the raw markdown into the workspace", async () => {
		const dir = await mkdtemp(join(tmpdir(), "webtool-"));
		try {
			const fetchImpl = stubFetch(() => new Response("# Raw", { status: 200 }));
			const result = await tool("web_fetch", fetchImpl).execute(
				{ url: "https://x.ai", saveTo: "docs/research/raw/models.md" },
				ctx(dir),
			);

			expect(result.ok).toBe(true);
			expect(
				await readFile(join(dir, "docs/research/raw/models.md"), "utf8"),
			).toBe("# Raw");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a failure when the fetch is not ok", async () => {
		const fetchImpl = stubFetch(() => new Response("nope", { status: 500 }));
		const result = await tool("web_fetch", fetchImpl).execute(
			{ url: "https://x.ai" },
			ctx("/tmp"),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("web_fetch failed");
	});
});

describe("web_search", () => {
	it("parses SearXNG JSON results", async () => {
		const body = JSON.stringify({
			results: [
				{ title: "Models", url: "https://docs.x.ai", content: "snippet" },
			],
		});
		const fetchImpl = stubFetch(() => new Response(body, { status: 200 }));

		const result = await tool("web_search", fetchImpl).execute(
			{ query: "xai models" },
			ctx("/tmp"),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.output).toContain("Models");
			expect(result.output).toContain("https://docs.x.ai");
		}
	});

	it("falls back to the DuckDuckGo html endpoint", async () => {
		const html =
			'<a rel="nofollow" class="result__a" href="https://x.ai/news">News</a>';
		const fetchImpl = stubFetch((url) =>
			url.includes("searxng.invalid")
				? new Response("down", { status: 500 })
				: new Response(html, { status: 200 }),
		);

		const result = await tool("web_search", fetchImpl).execute(
			{ query: "xai news" },
			ctx("/tmp"),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.output).toContain("News");
			expect(result.output).toContain("https://x.ai/news");
		}
	});
});

describe("netEgressProbe", () => {
	it("reports ok when the host can reach the internet", async () => {
		const fetchImpl = stubFetch(() => new Response("ok", { status: 200 }));
		expect(await netEgressProbe(fetchImpl)).toEqual({
			ok: true,
			detail: "host egress ok (HTTP 200)",
		});
	});

	it("reports failure when the host has no egress", async () => {
		const fetchImpl = stubFetch(() => {
			throw new Error("ENETUNREACH");
		});
		const result = await netEgressProbe(fetchImpl);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("no network egress");
	});
});
