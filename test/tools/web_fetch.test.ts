import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultRules,
	resolveAction,
	toolSubject,
} from "../../src/permissions/rules.js";
import { execute, getTool } from "../../src/tools/registry.js";

const ctx = { workspaceRoot: "/tmp" };

const page =
	"<h1>Hello</h1><p>A <b>bold</b> &amp; fine day.<br>Next</p><script>drop-me</script><style>p{}</style>";
const readable = "Hello\nA bold & fine day.\nNext";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("web_fetch", () => {
	it("is a read-only tool that asks before fetching", () => {
		expect(getTool("web_fetch")?.name).toBe("web_fetch");
		expect(getTool("web_fetch")?.readOnly).toBe(true);
		expect(defaultRules().web_fetch).toBe("ask");
		expect(
			resolveAction(defaultRules(), "web_fetch", "https://example.com"),
		).toBe("ask");
		expect(toolSubject("web_fetch", { url: "https://example.com/a" })).toBe(
			"https://example.com/a",
		);
	});

	it("returns a plain text body", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
			return new Response("hello", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com", format: "text" },
			ctx,
		);

		expect(result).toEqual({ ok: true, output: "hello" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/");
	});

	it("strips HTML to readable text for markdown and text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(page, { status: 200 })),
		);

		const markdown = await execute(
			"web_fetch",
			{ url: "https://example.com/page" },
			ctx,
		);
		const text = await execute(
			"web_fetch",
			{ url: "https://example.com/page", format: "text" },
			ctx,
		);

		expect(markdown).toEqual({ ok: true, output: readable });
		expect(text).toEqual({ ok: true, output: readable });
	});

	it("returns the raw body for html", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(page, { status: 200 })),
		);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com/page", format: "html" },
			ctx,
		);

		expect(result).toEqual({ ok: true, output: page });
	});

	it("names the status code when the response is not 2xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("missing", { status: 404 })),
		);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com/missing" },
			ctx,
		);

		expect(result).toEqual({ ok: false, error: "web_fetch: HTTP 404" });
	});

	it("rejects non-http schemes before fetching", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const ftp = await execute(
			"web_fetch",
			{ url: "ftp://example.com/file" },
			ctx,
		);
		const file = await execute("web_fetch", { url: "file:///etc/passwd" }, ctx);

		expect(ftp).toEqual({
			ok: false,
			error:
				"web_fetch: only http and https URLs are allowed: ftp://example.com/file",
		});
		expect(file).toEqual({
			ok: false,
			error:
				"web_fetch: only http and https URLs are allowed: file:///etc/passwd",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an unparseable URL", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await execute("web_fetch", { url: "not a url" }, ctx);

		expect(result).toEqual({
			ok: false,
			error: "web_fetch: invalid URL: not a url",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns an error when the network fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com" },
			ctx,
		);

		expect(result).toEqual({ ok: false, error: "web_fetch: fetch failed" });
	});

	it("returns an error when the request times out", async () => {
		stubHangingFetch();

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com", timeout_ms: 20 },
			ctx,
		);

		expect(result).toEqual({
			ok: false,
			error: "web_fetch: request timed out after 20ms",
		});
	});

	it("cancels the fetch when ctx.signal aborts", async () => {
		stubHangingFetch();
		const controller = new AbortController();

		const pending = execute(
			"web_fetch",
			{ url: "https://example.com", timeout_ms: 120_000 },
			{ ...ctx, signal: controller.signal },
		);
		controller.abort();

		await expect(pending).resolves.toEqual({
			ok: false,
			error: "web_fetch: request aborted",
		});
	});

	it("returns an error when ctx.signal is already aborted", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		controller.abort();

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com" },
			{ ...ctx, signal: controller.signal },
		);

		expect(result).toEqual({ ok: false, error: "web_fetch: request aborted" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("truncates a body longer than 50 KB", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("a".repeat(60_000), { status: 200 })),
		);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com/big", format: "html" },
			ctx,
		);

		expect(result).toEqual({
			ok: true,
			output: `${"a".repeat(51_200)}\n[truncated: 8800 bytes cut]`,
		});
	});

	it("truncates a body longer than 2000 lines", async () => {
		const body = Array.from({ length: 2500 }, () => "line").join("\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const result = await execute(
			"web_fetch",
			{ url: "https://example.com/lines", format: "html" },
			ctx,
		);

		if (!result.ok) throw new Error(result.error);
		const lines = result.output.split("\n");
		expect(lines).toHaveLength(2001);
		expect(lines[0]).toBe("line");
		expect(lines[1999]).toBe("line");
		expect(lines[2000]).toBe("[truncated: 500 lines cut]");
	});
});

function stubHangingFetch(): void {
	vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
		return new Promise((_resolve, reject) => {
			const signal = init?.signal;
			if (signal == null) {
				reject(new Error("missing signal"));
				return;
			}
			const fail = () => {
				const reason = signal.reason;
				reject(
					reason instanceof Error
						? reason
						: new DOMException("The operation was aborted.", "AbortError"),
				);
			};
			if (signal.aborted) {
				fail();
				return;
			}
			signal.addEventListener("abort", fail, { once: true });
		});
	});
}
