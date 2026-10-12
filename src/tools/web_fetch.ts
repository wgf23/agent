import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { truncateOutput } from "../util/truncate.js";
import type { Tool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const schema = z
	.object({
		url: z.string().describe("http or https URL to retrieve."),
		format: z
			.enum(["markdown", "text", "html"])
			.default("markdown")
			.describe(
				"markdown and text strip HTML to readable text. html returns the raw body.",
			),
		timeout_ms: z
			.number()
			.int()
			.min(1)
			.max(MAX_TIMEOUT_MS)
			.default(DEFAULT_TIMEOUT_MS)
			.describe("Abort the request after this many milliseconds."),
	})
	.strict();

type HttpUrl = { ok: true; href: string } | { ok: false; error: string };

export const webFetchTool: Tool<typeof schema> = {
	name: "web_fetch",
	description:
		"Fetch an http or https URL and return its body. markdown and text strip HTML to readable text. html returns the raw body.",
	readOnly: true,
	schema,
	async execute(args, ctx) {
		const target = parseHttpUrl(args.url);
		if (!target.ok) return target;
		if (ctx.signal?.aborted) {
			return { ok: false, error: "web_fetch: request aborted" };
		}

		let response: Response;
		try {
			response = await fetch(target.href, {
				signal: requestSignal(args.timeout_ms, ctx.signal),
				redirect: "follow",
			});
		} catch (error) {
			return {
				ok: false,
				error: fetchErrorMessage(error, ctx.signal, args.timeout_ms),
			};
		}

		if (!response.ok) {
			return { ok: false, error: `web_fetch: HTTP ${response.status}` };
		}

		let body: string;
		try {
			body = await response.text();
		} catch (error) {
			return { ok: false, error: `web_fetch: ${errorMessage(error)}` };
		}

		const text = args.format === "html" ? body : htmlToText(body);
		return { ok: true, output: truncateOutput(text).text };
	},
};

function parseHttpUrl(raw: string): HttpUrl {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: `web_fetch: invalid URL: ${raw}` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			ok: false,
			error: `web_fetch: only http and https URLs are allowed: ${raw}`,
		};
	}
	return { ok: true, href: url.href };
}

function requestSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (parent === undefined) return timeout;
	return AbortSignal.any([parent, timeout]);
}

function fetchErrorMessage(
	error: unknown,
	parent: AbortSignal | undefined,
	timeoutMs: number,
): string {
	if (parent?.aborted || namedError(error, "AbortError")) {
		return "web_fetch: request aborted";
	}
	if (namedError(error, "TimeoutError")) {
		return `web_fetch: request timed out after ${timeoutMs}ms`;
	}
	return `web_fetch: ${errorMessage(error)}`;
}

function namedError(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

function htmlToText(html: string): string {
	const withoutHidden = html
		.replace(/\r\n/g, "\n")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const withBreaks = withoutHidden
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|ul|ol|table|title)>/gi,
			"\n",
		);
	return collapseWhitespace(decodeEntities(withBreaks.replace(/<[^>]+>/g, "")));
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) =>
			fromCodePoint(Number.parseInt(hex, 16), match),
		)
		.replace(/&#(\d+);/g, (match, digits: string) =>
			fromCodePoint(Number(digits), match),
		)
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&amp;/gi, "&");
}

function fromCodePoint(code: number, fallback: string): string {
	if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
	return String.fromCodePoint(code);
}

function collapseWhitespace(text: string): string {
	return text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
