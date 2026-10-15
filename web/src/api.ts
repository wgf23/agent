import type { FileListResponse, FsDirsResponse } from "./protocol";

export interface ApiClient {
	// A read-only listing of one workspace directory; "" is the root. The two
	// flags ask the server to include hidden and gitignored entries.
	listFiles(
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	): Promise<FileListResponse>;
	// The same-origin URL that streams one workspace file, so a plain
	// <a download> lets the browser download it itself.
	fileDownloadUrl(path: string): string;
	// A read-only filesystem browse of directories, bounded by the server to
	// the home directory and the active workspace root; an omitted path means
	// home. A path outside every root rejects with the server's reason.
	listDirs(path?: string): Promise<FsDirsResponse>;
	// Streams one file into `path` (relative, "" is the root) as
	// multipart/form-data, using XMLHttpRequest so the caller can show upload
	// progress (fetch has none). Resolves with the per-file result the server
	// reports and rejects with the server's reason on a request-level refusal
	// (an escaped target, an over-cap file, a 5xx).
	upload(
		path: string,
		file: File,
		options?: UploadOptions,
	): Promise<UploadResult>;
}

// The whole answer to one upload: the relative posix paths that landed and the
// name plus reason of every part that did not. The route answers `ok: false`
// with `failed` populated rather than rejecting, so the panel can offer an
// overwrite for an `exists` reason.
export interface UploadResult {
	ok: boolean;
	written: string[];
	failed: Array<{ name: string; reason: string }>;
}

export interface UploadOptions {
	// Replaces an existing target instead of failing that part with `exists`.
	overwrite?: boolean;
	// Called as the request body uploads. `total` is the whole multipart body,
	// so a caller that uploads one file sees that file's progress.
	onProgress?: (progress: { loaded: number; total: number }) => void;
}

// A failed request that keeps its HTTP status, so a caller can weigh the
// refusal (`exists`, a missing source) rather than only reading the message.
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

type ApiInit = Omit<RequestInit, "headers"> & {
	headers?: Record<string, string>;
};

// The request construction lives outside the React hook so a node test can
// drive it; the hook only forwards.
export function createApi(
	options: {
		fetchImpl?: typeof fetch;
		// Injected so a node test can drive upload without a DOM; the browser uses
		// the real XMLHttpRequest, which is the only way to read upload progress.
		xhrImpl?: typeof XMLHttpRequest;
	} = {},
): ApiClient {
	const doFetch = options.fetchImpl ?? fetch;
	// Read through globalThis so a node import that never uploads cannot throw
	// on a missing XMLHttpRequest.
	const Xhr = options.xhrImpl ?? globalThis.XMLHttpRequest;

	function request(path: string, init: ApiInit = {}): Promise<Response> {
		const { headers, ...rest } = init;
		return doFetch(path, { ...rest, headers });
	}

	// Builds the ApiError for a refused response, preferring the server's
	// human-readable reason when the body carries one.
	async function failure(
		response: Response,
		fallback: string,
	): Promise<ApiError> {
		let message = fallback;
		try {
			const body = (await response.json()) as { error?: string };
			if (typeof body.error === "string" && body.error !== "") {
				message = body.error;
			}
		} catch {
			// keep the fallback message
		}
		return new ApiError(response.status, message);
	}

	// The path is always present ("" is the root) and the flags ride as "1",
	// matching the route's exact spellings; a refused listing keeps its status.
	async function listFiles(
		path: string,
		listOptions: { showHidden?: boolean; showIgnored?: boolean } = {},
	): Promise<FileListResponse> {
		const query = new URLSearchParams({ path });
		if (listOptions.showHidden === true) query.set("showHidden", "1");
		if (listOptions.showIgnored === true) query.set("showIgnored", "1");
		const route = `/api/files?${query.toString()}`;
		const response = await request(route);
		if (!response.ok) {
			throw await failure(response, `GET ${route} failed: ${response.status}`);
		}
		return (await response.json()) as FileListResponse;
	}

	// The download URL is built as a literal string rather than through the
	// fetch path: an <a download> navigates the browser itself, so only the
	// percent-encoded path rides in the query.
	function fileDownloadUrl(path: string): string {
		return `/api/files/download?path=${encodeURIComponent(path)}`;
	}

	// The browse path is absolute and percent-encoded into the query; an
	// omitted path sends no query at all, which the server reads as home. A
	// refusal (outside the roots, unreadable) keeps the server's reason and its
	// status so the caller can show either inline.
	async function listDirs(path?: string): Promise<FsDirsResponse> {
		const route =
			path === undefined
				? "/api/fs/dirs"
				: `/api/fs/dirs?path=${encodeURIComponent(path)}`;
		const response = await request(route);
		if (!response.ok) {
			throw await failure(response, `GET ${route} failed: ${response.status}`);
		}
		return (await response.json()) as FsDirsResponse;
	}

	// One file is posted per request so the caller sees that file's own upload
	// progress. The body is multipart/form-data and the browser sets its own
	// boundary. A non-2xx answer rejects with the server's reason; a 2xx
	// `{ ok: false }` resolves because a per-file refusal is a result the caller
	// must show, not a dropped request.
	function upload(
		path: string,
		file: File,
		uploadOptions: UploadOptions = {},
	): Promise<UploadResult> {
		return new Promise((resolve, reject) => {
			const form = new FormData();
			form.append("path", path);
			if (uploadOptions.overwrite === true) form.append("overwrite", "1");
			// The third argument keeps the real name on the part so the server
			// can validate it.
			form.append("file", file, file.name);

			const xhr = new Xhr();
			xhr.open("POST", "/api/files/upload");
			if (uploadOptions.onProgress !== undefined) {
				const onProgress = uploadOptions.onProgress;
				xhr.upload.onprogress = (event) => {
					onProgress({ loaded: event.loaded, total: event.total });
				};
			}
			xhr.onload = () => {
				const result = parseUploadResult(xhr.responseText);
				if (xhr.status >= 200 && xhr.status < 300 && result !== null) {
					resolve(result);
					return;
				}
				reject(
					new ApiError(
						xhr.status,
						uploadErrorReason(xhr.responseText, xhr.status),
					),
				);
			};
			xhr.onerror = () => reject(new ApiError(0, "上传失败"));
			xhr.onabort = () => reject(new ApiError(0, "上传已取消"));
			xhr.send(form);
		});
	}

	return { listFiles, fileDownloadUrl, listDirs, upload };
}

// A 2xx upload body is the route's UploadResult; anything else (an error object,
// an HTML error page) is not, so the caller falls back to the status.
function parseUploadResult(text: string): UploadResult | null {
	try {
		const body = JSON.parse(text) as Partial<UploadResult>;
		if (
			typeof body.ok === "boolean" &&
			Array.isArray(body.written) &&
			Array.isArray(body.failed)
		) {
			return body as UploadResult;
		}
	} catch {
		// not JSON: the caller reports the status
	}
	return null;
}

// The server names the request-level refusal (an escaped path, an over-cap
// file); fall back to the status when the body carries no reason.
function uploadErrorReason(text: string, status: number): string {
	try {
		const body = JSON.parse(text) as { error?: unknown };
		if (typeof body.error === "string" && body.error !== "") return body.error;
	} catch {
		// not JSON: fall through to the status
	}
	return `上传失败 (${status})`;
}
