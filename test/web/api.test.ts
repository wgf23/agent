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
		name: "loadAgents",
		run: (api) => api.loadAgents(),
		path: "/api/agents",
		method: "GET",
		body: undefined,
	},
	{
		name: "installAgent",
		run: (api) => api.installAgent("pi"),
		path: "/api/agents/install",
		method: "POST",
		body: { id: "pi", confirm: true },
	},
	{
		name: "cancelAgent",
		run: (api) => api.cancelAgent("pi"),
		path: "/api/agents/cancel",
		method: "POST",
		body: { id: "pi" },
	},
	{
		name: "send",
		run: (api) => api.send("b", "hi"),
		path: "/api/send",
		method: "POST",
		body: { bot: "b", text: "hi" },
	},
	{
		name: "sendWithImages",
		run: (api) =>
			api.send("b", "look", [
				{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
			]),
		path: "/api/send",
		method: "POST",
		body: {
			bot: "b",
			text: "look",
			images: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }],
		},
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
		name: "renameSession",
		run: (api) => api.renameSession("b", "s1", "Greeting"),
		path: "/api/sessions/rename",
		method: "POST",
		body: { bot: "b", id: "s1", title: "Greeting" },
	},
	{
		name: "deleteSession",
		run: (api) => api.deleteSession("b", "s1"),
		path: "/api/sessions/delete",
		method: "POST",
		body: { bot: "b", id: "s1" },
	},
	{
		name: "search",
		run: (api) => api.search("zed"),
		path: "/api/search?q=zed",
		method: "GET",
		body: undefined,
	},
	{
		name: "loadBotTranscript",
		run: (api) => api.loadBotTranscript("b"),
		path: "/api/bots/b/transcript",
		method: "GET",
		body: undefined,
	},
	{
		name: "loadMemory",
		run: (api) => api.loadMemory("b"),
		path: "/api/bots/b/memory",
		method: "GET",
		body: undefined,
	},
	{
		name: "forgetMemory",
		run: (api) => api.forgetMemory("b", "m1"),
		path: "/api/bots/b/memory/forget",
		method: "POST",
		body: { id: "m1" },
	},
	{
		name: "setWake",
		run: (api) => api.setWake("b", { everyMs: 60000, prompt: "tick" }),
		path: "/api/bots/b/wake",
		method: "POST",
		body: { everyMs: 60000, prompt: "tick" },
	},
	{
		name: "createBot",
		run: (api) => api.createBot({ name: "b", role: "r" }),
		path: "/api/bots",
		method: "POST",
		body: { name: "b", role: "r" },
	},
	{
		name: "updateBot",
		run: (api) => api.updateBot("atlas", { role: "editor" }),
		path: "/api/bots/atlas",
		method: "PATCH",
		body: { role: "editor" },
	},
	{
		name: "removeBot",
		run: (api) => api.removeBot("atlas"),
		path: "/api/bots/atlas",
		method: "DELETE",
		body: undefined,
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
	{
		name: "switchWorkspace",
		run: (api) => api.switchWorkspace("/tmp/ws"),
		path: "/api/workspaces",
		method: "POST",
		body: { root: "/tmp/ws" },
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

	it("surfaces the server's error on updateBot and removeBot", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "Unknown bot: atlas" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		});
		await expect(api.updateBot("atlas", { role: "r" })).rejects.toThrow(
			"Unknown bot: atlas",
		);
		await expect(api.removeBot("atlas")).rejects.toThrow("Unknown bot: atlas");
	});

	it("surfaces the server's refusal on renameSession and deleteSession", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "Unknown session: s1" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		});
		await expect(api.renameSession("b", "s1", "Greeting")).rejects.toThrow(
			"Unknown session: s1",
		);
		await expect(api.deleteSession("b", "s1")).rejects.toThrow(
			"Unknown session: s1",
		);
	});

	it("surfaces the server's refusal on search", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "query is required" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		});
		await expect(api.search("")).rejects.toThrow("query is required");
		await expect(api.search("zed")).rejects.toMatchObject({ status: 400 });
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

	// The composer blocks an over-cap or unsupported file locally; the route is
	// the second gate, and its reason is what the user is shown.
	it("surfaces the server's refusal on send", async () => {
		const api = createApi({
			token: null,
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						error: 'Unsupported image type "image/bmp": allowed types are ...',
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				)) as typeof fetch,
		});
		await expect(
			api.send("b", "hi", [
				{ type: "image", mediaType: "image/bmp", data: "QkE=" },
			]),
		).rejects.toThrow('Unsupported image type "image/bmp"');
		await expect(api.send("b", "hi")).rejects.toMatchObject({ status: 400 });
	});

	it("carries the status on a 401 so the hub can flag the token", async () => {
		const api = createApi({
			token: "abc",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		});
		await expect(api.loadBotTranscript("b")).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.loadMemory("b")).rejects.toMatchObject({ status: 401 });
		await expect(api.forgetMemory("b", "m1")).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.setWake("b", { clear: true })).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.updateBot("b", { role: "r" })).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.removeBot("b")).rejects.toMatchObject({ status: 401 });
		await expect(
			api.renameSession("b", "s1", "Greeting"),
		).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.deleteSession("b", "s1")).rejects.toMatchObject({
			status: 401,
		});
		await expect(api.search("zed")).rejects.toMatchObject({ status: 401 });
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
