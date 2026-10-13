import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../web/src/api";
import { createApi } from "../../web/src/api";

interface Call {
	path: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

// Records the outgoing request so every assertion can read the literal path,
// method, headers, and parsed body instead of trusting the caller.
function recordingFetch(calls: Call[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			path: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(
			JSON.stringify({ ok: true, provider: {}, presets: [], warning: "w" }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
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
		name: "send",
		run: (api) => api.send("b", "hi"),
		path: "/api/send",
		method: "POST",
		body: { bot: "b", text: "hi" },
	},
	{
		name: "interrupt",
		run: (api) => api.interrupt("b"),
		path: "/api/interrupt",
		method: "POST",
		body: { bot: "b" },
	},
	{
		name: "respondApproval",
		run: (api) => api.respondApproval("a1", "allow_once"),
		path: "/api/approval",
		method: "POST",
		body: { id: "a1", decision: "allow_once" },
	},
	{
		name: "setAllowAll",
		run: (api) => api.setAllowAll(true),
		path: "/api/allow-all",
		method: "POST",
		body: { on: true },
	},
	{
		name: "newSession",
		run: (api) => api.newSession("b"),
		path: "/api/sessions/new",
		method: "POST",
		body: { bot: "b" },
	},
	{
		name: "openSession",
		run: (api) => api.openSession("b", "s1"),
		path: "/api/sessions/open",
		method: "POST",
		body: { bot: "b", id: "s1" },
	},
	{
		name: "createBot",
		run: (api) => api.createBot({ name: "b", role: "r" }),
		path: "/api/bots",
		method: "POST",
		body: { name: "b", role: "r" },
	},
	{
		name: "loadSettings",
		run: (api) => api.loadSettings(),
		path: "/api/settings",
		method: "GET",
		body: undefined,
	},
	{
		name: "saveProvider",
		run: (api) => api.saveProvider({ preset: "deepseek", model: "m" }),
		path: "/api/settings",
		method: "POST",
		body: { preset: "deepseek", model: "m" },
	},
];

describe("eventsUrl", () => {
	it("carries the token so the EventSource can authenticate", () => {
		expect(createApi({ token: "abc" }).eventsUrl()).toBe(
			"/api/events?token=abc",
		);
	});

	it("stays bare without a token", () => {
		expect(createApi({ token: null }).eventsUrl()).toBe("/api/events");
	});
});

describe("request construction", () => {
	it("attaches the bearer token to every method", async () => {
		for (const call of invocations) {
			const calls: Call[] = [];
			const api = createApi({ token: "abc", fetchImpl: recordingFetch(calls) });
			await call.run(api);
			expect(calls[0].headers.Authorization, `${call.name} Authorization`).toBe(
				"Bearer abc",
			);
		}
	});

	it("sends no Authorization header when the token is null", async () => {
		for (const call of invocations) {
			const calls: Call[] = [];
			const api = createApi({ token: null, fetchImpl: recordingFetch(calls) });
			await call.run(api);
			expect(calls[0].headers, `${call.name} Authorization`).not.toHaveProperty(
				"Authorization",
			);
		}
	});

	it("builds every path, method, and body literally", async () => {
		for (const call of invocations) {
			const calls: Call[] = [];
			const api = createApi({ token: null, fetchImpl: recordingFetch(calls) });
			await call.run(api);
			expect(calls[0].path, call.name).toBe(call.path);
			expect(calls[0].method, call.name).toBe(call.method);
			expect(calls[0].body, call.name).toEqual(call.body);
		}
	});
});

describe("response handling", () => {
	it("throws the server's error string from createBot", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "名字重复" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		});
		await expect(api.createBot({ name: "b", role: "r" })).rejects.toThrow(
			"名字重复",
		);
	});

	it("returns the accepted provider and its warning from saveProvider", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						ok: true,
						provider: { configured: true, model: "m" },
						warning: "weak key",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)) as typeof fetch,
		});
		await expect(
			api.saveProvider({ preset: "deepseek", model: "m" }),
		).resolves.toEqual({
			ok: true,
			provider: { configured: true, model: "m" },
			warning: "weak key",
		});
	});

	it("treats a 401 as failure for the response-reading calls", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response("nope", { status: 401 })) as typeof fetch,
		});
		await expect(api.loadSettings()).rejects.toThrow(
			"GET /api/settings failed: 401",
		);
		await expect(
			api.saveProvider({ preset: "deepseek", model: "m" }),
		).rejects.toThrow("保存设置失败 (401)");
	});
});

// The hook cannot run without React and a DOM, so the request construction is
// tested behaviorally in `api.ts` above. What is left to pin is the shape of
// the bug itself: the hook must not build a request on its own, because a bare
// call is exactly what dropped the token. These assertions fail on a revert.
describe("useHub wiring", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../../web/src/useHub.ts", import.meta.url)),
		"utf8",
	);

	it("builds no request of its own", () => {
		expect(source).not.toContain('new EventSource("/api/events")');
		expect(source).not.toMatch(/(?<![.\w])fetch\(/);
	});
});
