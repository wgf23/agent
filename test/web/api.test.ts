import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../web/src/api";
import {
	closeBotSession,
	createApi,
	deleteSession,
	forgetMemory,
	loadBotTranscript,
	loadMemory,
	removeBot,
	renameSession,
	searchSessions,
	setWake,
	updateBot,
} from "../../web/src/api";
import type { SearchResponse } from "../../web/src/protocol";

interface Call {
	path: string;
	method: string;
	body: unknown;
}

// Records the outgoing request so every assertion reads the literal path,
// method, and parsed body instead of trusting the caller.
function recordingFetch(
	calls: Call[],
	payload: unknown = { ok: true },
	status = 200,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

describe("sidebar requests", () => {
	it("searches with a percent-encoded query and returns the payload", async () => {
		const calls: Call[] = [];
		const results: SearchResponse = { query: "a b", chat: [], rooms: [] };

		const answer = await searchSessions("a b", recordingFetch(calls, results));

		expect(calls).toEqual([
			{ path: "/api/search?q=a%20b", method: "GET", body: undefined },
		]);
		expect(answer).toEqual(results);
	});

	it("renames and deletes through the literal routes and bodies", async () => {
		const renameCalls: Call[] = [];
		await renameSession(
			"assistant",
			"ses_1",
			"Greeting",
			recordingFetch(renameCalls),
		);
		expect(renameCalls).toEqual([
			{
				path: "/api/sessions/rename",
				method: "POST",
				body: { bot: "assistant", id: "ses_1", title: "Greeting" },
			},
		]);

		const deleteCalls: Call[] = [];
		await deleteSession("assistant", "ses_1", recordingFetch(deleteCalls));
		expect(deleteCalls).toEqual([
			{
				path: "/api/sessions/delete",
				method: "POST",
				body: { bot: "assistant", id: "ses_1" },
			},
		]);
	});

	it("surfaces the server's reason on search, rename, and delete", async () => {
		const failure = recordingFetch(
			[],
			{ error: "Unknown session: ses_1" },
			404,
		);
		await expect(searchSessions("zed", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
		await expect(renameSession("b", "ses_1", "x", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
		await expect(deleteSession("b", "ses_1", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
	});
});

describe("bot ledger requests", () => {
	it("reads the transcript and memory from the bot's literal routes", async () => {
		const transcript = {
			bot: "writer",
			sessionId: "chs_1",
			messages: [],
			sessions: [],
		};
		const transcriptCalls: Call[] = [];
		expect(
			await loadBotTranscript(
				"writer",
				recordingFetch(transcriptCalls, transcript),
			),
		).toEqual(transcript);
		expect(transcriptCalls).toEqual([
			{ path: "/api/bots/writer/transcript", method: "GET", body: undefined },
		]);

		const memory = { bot: "writer", entries: [] };
		const memoryCalls: Call[] = [];
		expect(
			await loadMemory("writer", recordingFetch(memoryCalls, memory)),
		).toEqual(memory);
		expect(memoryCalls).toEqual([
			{ path: "/api/bots/writer/memory", method: "GET", body: undefined },
		]);
	});

	it("writes the forget, wake, close, edit, and delete bodies literally", async () => {
		const forgetCalls: Call[] = [];
		await forgetMemory("writer", "mem_1", recordingFetch(forgetCalls));
		expect(forgetCalls).toEqual([
			{
				path: "/api/bots/writer/memory/forget",
				method: "POST",
				body: { id: "mem_1" },
			},
		]);

		const wakeCalls: Call[] = [];
		await setWake(
			"writer",
			{ everyMs: 60000, prompt: "tick" },
			recordingFetch(wakeCalls),
		);
		expect(wakeCalls).toEqual([
			{
				path: "/api/bots/writer/wake",
				method: "POST",
				body: { everyMs: 60000, prompt: "tick" },
			},
		]);

		const closeCalls: Call[] = [];
		await closeBotSession("writer", "chs_1", recordingFetch(closeCalls));
		expect(closeCalls).toEqual([
			{
				path: "/api/sessions/close",
				method: "POST",
				body: { bot: "writer", id: "chs_1" },
			},
		]);

		const updateCalls: Call[] = [];
		await updateBot(
			"writer",
			{ role: "edits", model: "deepseek-chat" },
			recordingFetch(updateCalls),
		);
		expect(updateCalls).toEqual([
			{
				path: "/api/bots/writer",
				method: "PATCH",
				body: { role: "edits", model: "deepseek-chat" },
			},
		]);

		const removeCalls: Call[] = [];
		await removeBot("writer", recordingFetch(removeCalls));
		expect(removeCalls).toEqual([
			{ path: "/api/bots/writer", method: "DELETE", body: undefined },
		]);
	});

	it("surfaces the server's reason on every bot ledger verb", async () => {
		const failure = recordingFetch([], { error: "Unknown bot: ghost" }, 404);
		await expect(loadBotTranscript("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(loadMemory("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(forgetMemory("ghost", "mem_1", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(setWake("ghost", { clear: true }, failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(closeBotSession("ghost", "chs_1", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(updateBot("ghost", { role: "x" }, failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(removeBot("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
	});
});

interface XhrCall {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: FormData;
}

// A minimal XMLHttpRequest double: it records the request and drives the
// progress/load callbacks the upload client installs, so the whole upload path
// is exercised without a DOM.
function recordingXhr(
	response: { status: number; body: string },
	calls: XhrCall[],
): typeof XMLHttpRequest {
	return class {
		method = "";
		url = "";
		headers: Record<string, string> = {};
		status = 0;
		responseText = "";
		upload = {
			onprogress: null as
				| ((event: { loaded: number; total: number }) => void)
				| null,
		};
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;

		open(method: string, url: string) {
			this.method = method;
			this.url = url;
		}

		setRequestHeader(key: string, value: string) {
			this.headers[key] = value;
		}

		send(body: FormData) {
			calls.push({
				method: this.method,
				url: this.url,
				headers: this.headers,
				body,
			});
			this.status = response.status;
			this.responseText = response.body;
			this.upload.onprogress?.({ loaded: 4, total: 4 });
			this.onload?.();
		}
	} as unknown as typeof XMLHttpRequest;
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
	{
		name: "listDirs",
		run: (api) => api.listDirs("/home/x"),
		path: "/api/fs/dirs?path=%2Fhome%2Fx",
		method: "GET",
		body: undefined,
	},
	{
		name: "filePreview",
		run: (api) => api.filePreview("docs/a b.xlsx"),
		path: "/api/files/preview?path=docs%2Fa%20b.xlsx",
		method: "GET",
		body: undefined,
	},
	{
		name: "mkdir",
		run: (api) => api.mkdir("src/new"),
		path: "/api/files/mkdir",
		method: "POST",
		body: { path: "src/new" },
	},
	{
		name: "renameEntry",
		run: (api) => api.renameEntry("src/a.txt", "src/b.txt"),
		path: "/api/files/rename",
		method: "POST",
		body: { from: "src/a.txt", to: "src/b.txt" },
	},
	{
		name: "moveEntry",
		run: (api) => api.moveEntry("a.txt", "src/a.txt"),
		path: "/api/files/move",
		method: "POST",
		body: { from: "a.txt", to: "src/a.txt" },
	},
	{
		name: "deleteEntry",
		run: (api) => api.deleteEntry("src/old", true),
		path: "/api/files/delete",
		method: "POST",
		body: { path: "src/old", recursive: true },
	},
];

describe("fileDownloadUrl", () => {
	it("percent-encodes the path so a plain link downloads the file", () => {
		expect(createApi().fileDownloadUrl("docs/a b.txt")).toBe(
			"/api/files/download?path=docs%2Fa%20b.txt",
		);
	});
});

describe("fileArchiveUrl", () => {
	it("percent-encodes the path so a plain link downloads the zip", () => {
		expect(createApi().fileArchiveUrl("docs/my dir")).toBe(
			"/api/files/archive?path=docs%2Fmy%20dir",
		);
	});
});

describe("filePreview", () => {
	it("reads the office preview from the literal route", async () => {
		const calls: Call[] = [];
		const preview = { kind: "doc" as const, blocks: [], truncated: false };
		const api = createApi({
			fetchImpl: recordingFetch(calls, { path: "a.docx", preview }),
		});
		await expect(api.filePreview("a.docx")).resolves.toEqual(preview);
		expect(calls).toEqual([
			{
				path: "/api/files/preview?path=a.docx",
				method: "GET",
				body: undefined,
			},
		]);
	});
});

describe("upload", () => {
	it("posts FormData with the path and reports progress", async () => {
		const calls: XhrCall[] = [];
		const api = createApi({
			xhrImpl: recordingXhr(
				{
					status: 200,
					body: JSON.stringify({
						ok: true,
						written: ["src/a.txt"],
						failed: [],
					}),
				},
				calls,
			),
		});
		const seen: Array<{ loaded: number; total: number }> = [];
		const result = await api.upload("src", new File(["hello"], "a.txt"), {
			onProgress: (progress) => seen.push(progress),
		});
		expect(result).toEqual({
			ok: true,
			written: ["src/a.txt"],
			failed: [],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe("/api/files/upload");
		expect(calls[0].body.get("path")).toBe("src");
		expect(calls[0].body.get("overwrite")).toBeNull();
		const part = calls[0].body.get("file");
		expect(part).toBeInstanceOf(File);
		expect((part as File).name).toBe("a.txt");
		expect(seen).toEqual([{ loaded: 4, total: 4 }]);
	});

	it("adds overwrite=1 when the caller retries over an existing name", async () => {
		const calls: XhrCall[] = [];
		const api = createApi({
			xhrImpl: recordingXhr(
				{
					status: 200,
					body: JSON.stringify({ ok: true, written: [], failed: [] }),
				},
				calls,
			),
		});
		await api.upload("", new File(["x"], "x.bin"), { overwrite: true });
		expect(calls[0].body.get("path")).toBe("");
		expect(calls[0].body.get("overwrite")).toBe("1");
	});

	// A per-file refusal is a result, not a dropped request: the panel needs the
	// `exists` reason to offer the overwrite retry.
	it("resolves ok:false with the failed reason", async () => {
		const calls: XhrCall[] = [];
		const api = createApi({
			xhrImpl: recordingXhr(
				{
					status: 200,
					body: JSON.stringify({
						ok: false,
						written: [],
						failed: [{ name: "a.txt", reason: "exists" }],
					}),
				},
				calls,
			),
		});
		await expect(api.upload("src", new File(["x"], "a.txt"))).resolves.toEqual({
			ok: false,
			written: [],
			failed: [{ name: "a.txt", reason: "exists" }],
		});
	});

	it("rejects with the server's reason on a request-level refusal", async () => {
		const calls: XhrCall[] = [];
		const api = createApi({
			xhrImpl: recordingXhr(
				{
					status: 413,
					body: JSON.stringify({ error: "file exceeds the upload size limit" }),
				},
				calls,
			),
		});
		await expect(api.upload("src", new File(["x"], "a.txt"))).rejects.toThrow(
			"file exceeds the upload size limit",
		);
	});
});

describe("structure writes", () => {
	it("surface the server's reason on the row", async () => {
		const api = createApi({
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({ ok: false, error: "Already exists: src" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				)) as typeof fetch,
		});
		await expect(api.mkdir("src")).rejects.toThrow("Already exists: src");
		await expect(api.renameEntry("a.txt", "b.txt")).rejects.toMatchObject({
			status: 400,
		});
		await expect(api.moveEntry("a.txt", "src/a.txt")).rejects.toThrow(
			"Already exists: src",
		);
		await expect(api.deleteEntry("src", true)).rejects.toMatchObject({
			status: 400,
		});
	});
});

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
