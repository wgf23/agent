import type { FileListResponse } from "./protocol";

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
	options: { fetchImpl?: typeof fetch } = {},
): ApiClient {
	const doFetch = options.fetchImpl ?? fetch;

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

	return { listFiles, fileDownloadUrl };
}
