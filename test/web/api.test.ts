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
];

describe("fileDownloadUrl", () => {
	it("percent-encodes the path so a plain link downloads the file", () => {
		expect(createApi().fileDownloadUrl("docs/a b.txt")).toBe(
			"/api/files/download?path=docs%2Fa%20b.txt",
		);
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
