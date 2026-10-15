import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../web/src/api";
import { createApi } from "../../web/src/api";

interface Call {
	path: string;
	method: string;
	headers: Record<string, string> | undefined;
	body: unknown;
}

// Records the outgoing request so every assertion can read the literal path,
// method, and parsed body instead of trusting the caller.
function recordingFetch(calls: Call[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: String(input),
			method: init?.method ?? "GET",
			headers: init?.headers as Record<string, string> | undefined,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(
			JSON.stringify({ path: "", entries: [], ignored: [] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;
}

const invocations: Array<{
	name: string;
	run: (api: ApiClient) => Promise<unknown>;
	path: string;
	method: string;
	body: unknown;
}> = [
	{
		name: "listFiles",
		run: (api) => api.listFiles("src", { showHidden: true }),
		path: "/api/files?path=src&showHidden=1",
		method: "GET",
		body: undefined,
	},
];

describe("request construction", () => {
	it("builds every path, method, and body literally", async () => {
		for (const call of invocations) {
			const calls: Call[] = [];
			const api = createApi({ fetchImpl: recordingFetch(calls) });
			await call.run(api);
			expect(calls[0].path, call.name).toBe(call.path);
			expect(calls[0].method, call.name).toBe(call.method);
			expect(calls[0].body, call.name).toEqual(call.body);
		}
	});
});
