import { authHeaders, eventsUrl } from "./auth";
import type {
	AgentListResponse,
	ApprovalChoice,
	BotDraft,
	BotTranscriptResponse,
	CancelAgentBody,
	FileListResponse,
	ForgetMemoryBody,
	FsDirsResponse,
	ImagePart,
	InstallAgentBody,
	InstallAgentStartResponse,
	MemoryListResponse,
	SaveProviderBody,
	SaveProviderResponse,
	SearchResponse,
	SendBody,
	SettingsResponse,
	SetWakeBody,
	UpdateBotBody,
} from "./protocol";

export interface ApiClient {
	eventsUrl(): string;
	// Images are already validated and encoded by the composer; the route
	// validates them again and answers 400 naming the reason.
	send(bot: string, text: string, images?: ImagePart[]): Promise<void>;
	interrupt(bot: string): Promise<void>;
	respondApproval(id: string, choice: ApprovalChoice): Promise<void>;
	setAllowAll(on: boolean): Promise<void>;
	newSession(bot: string): Promise<void>;
	openSession(bot: string, id: string): Promise<void>;
	// Reads a bot's current transcript and its session list in one call.
	loadBotTranscript(bot: string): Promise<BotTranscriptResponse>;
	loadMemory(bot: string): Promise<MemoryListResponse>;
	forgetMemory(bot: string, id: string): Promise<void>;
	setWake(bot: string, body: SetWakeBody): Promise<void>;
	closeBotSession(bot: string, id: string): Promise<void>;
	// Sets an owner label on a session; the server trims it and bounds it to
	// 120 characters, refusing a blank one.
	renameSession(bot: string, id: string, title: string): Promise<void>;
	// Removes a session and its transcript; irreversible.
	deleteSession(bot: string, id: string): Promise<void>;
	// A read-only search over the workspace chat and every bot's sessions; a
	// blank query is refused by the server and never sent by the hub.
	search(query: string): Promise<SearchResponse>;
	// A read-only listing of one workspace directory; "" is the root. The two
	// flags ask the server to include hidden and gitignored entries.
	listFiles(
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	): Promise<FileListResponse>;
	// A read-only filesystem browse of directories, bounded by the server to
	// the home directory and the active workspace root; an omitted path means
	// home. A path outside every root rejects with the server's reason.
	listDirs(path?: string): Promise<FsDirsResponse>;
	// The same-origin URL that streams one workspace file, with the token in
	// the query when the client holds one, so a plain <a download> works even
	// on a token-gated bind where fetch headers cannot help.
	fileDownloadUrl(path: string): string;
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
	// Creates a directory (parents allowed) inside the workspace; rejects with
	// the server's reason on a boundary, a bad name, or an existing target.
	mkdir(path: string): Promise<void>;
	// Renames one entry to a new path inside the workspace; rejects with the
	// server's reason when the destination exists or the source is missing.
	renameEntry(from: string, to: string): Promise<void>;
	// Moves one entry to a new path inside the workspace; rejects with the
	// server's reason on an existing destination or a self-nesting move.
	moveEntry(from: string, to: string): Promise<void>;
	// Deletes one entry; a directory needs `recursive: true` to remove its
	// contents. Irreversible, so the panel confirms before calling.
	deleteEntry(path: string, recursive?: boolean): Promise<void>;
	createBot(draft: BotDraft): Promise<void>;
	// Replaces a bot's role, model, and backend; the name rides in the path.
	updateBot(bot: string, draft: UpdateBotBody): Promise<void>;
	// Removes a bot's configuration and its memory; irreversible.
	removeBot(bot: string): Promise<void>;
	loadSettings(): Promise<SettingsResponse>;
	// Returns the accepted provider so the caller can apply it immediately
	// instead of waiting for the server's broadcast.
	saveProvider(body: SaveProviderBody): Promise<SavedProvider>;
	loadAgents(): Promise<AgentListResponse>;
	installAgent(id: string): Promise<InstallAgentStartResponse>;
	cancelAgent(id: string): Promise<void>;
	// Server-driven switch: the POST only names the root; the server emits a
	// fresh hello that the reducer treats as a full reset.
	switchWorkspace(root: string): Promise<SwitchWorkspaceResult>;
}

// A failed request that keeps its HTTP status so the hub can tell an auth
// refusal (401) apart from a transient failure. The response-reading calls
// below throw this; the older call sites keep their plain Error behavior.
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export type SavedProvider = Extract<SaveProviderResponse, { ok: true }>;

export type SwitchWorkspaceResult = { ok: true } | { ok: false; error: string };

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

type ApiInit = Omit<RequestInit, "headers"> & {
	headers?: Record<string, string>;
};

// The request construction lives outside the React hook so a node test can
// drive it. Every request carries the bearer token on a non-loopback bind,
// where the server gates each /api/* path.
export function createApi(options: {
	token: string | null;
	fetchImpl?: typeof fetch;
	// Injected so a node test can drive upload without a DOM; the browser uses
	// the real XMLHttpRequest, which is the only way to read upload progress.
	xhrImpl?: typeof XMLHttpRequest;
}): ApiClient {
	const { token } = options;
	const doFetch = options.fetchImpl ?? fetch;
	// Read through globalThis so a node import that never uploads cannot throw
	// on a missing XMLHttpRequest.
	const Xhr = options.xhrImpl ?? globalThis.XMLHttpRequest;

	function request(path: string, init: ApiInit = {}): Promise<Response> {
		const { headers, ...rest } = init;
		return doFetch(path, {
			...rest,
			headers: { ...authHeaders(token), ...headers },
		});
	}

	async function post(path: string, body: unknown): Promise<void> {
		const response = await request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`POST ${path} failed: ${response.status}`);
		}
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

	async function loadBotTranscript(
		bot: string,
	): Promise<BotTranscriptResponse> {
		const path = `/api/bots/${encodeURIComponent(bot)}/transcript`;
		const response = await request(path);
		if (!response.ok) {
			throw await failure(response, `GET ${path} failed: ${response.status}`);
		}
		return (await response.json()) as BotTranscriptResponse;
	}

	async function loadMemory(bot: string): Promise<MemoryListResponse> {
		const path = `/api/bots/${encodeURIComponent(bot)}/memory`;
		const response = await request(path);
		if (!response.ok) {
			throw await failure(response, `GET ${path} failed: ${response.status}`);
		}
		return (await response.json()) as MemoryListResponse;
	}

	async function forgetMemory(bot: string, id: string): Promise<void> {
		const path = `/api/bots/${encodeURIComponent(bot)}/memory/forget`;
		const body: ForgetMemoryBody = { id };
		const response = await request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw await failure(response, `POST ${path} failed: ${response.status}`);
		}
	}

	async function setWake(bot: string, body: SetWakeBody): Promise<void> {
		const path = `/api/bots/${encodeURIComponent(bot)}/wake`;
		const response = await request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw await failure(response, `POST ${path} failed: ${response.status}`);
		}
	}

	async function closeBotSession(bot: string, id: string): Promise<void> {
		// A bot's session close is a POST; a 401 must stay observable so the hub
		// can flag the token rather than a dropped connection.
		const response = await request("/api/sessions/close", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bot, id }),
		});
		if (!response.ok) {
			throw await failure(
				response,
				`POST /api/sessions/close failed: ${response.status}`,
			);
		}
	}

	async function renameSession(
		bot: string,
		id: string,
		title: string,
	): Promise<void> {
		const response = await request("/api/sessions/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bot, id, title }),
		});
		if (!response.ok) {
			throw await failure(
				response,
				`POST /api/sessions/rename failed: ${response.status}`,
			);
		}
	}

	async function deleteSession(bot: string, id: string): Promise<void> {
		const response = await request("/api/sessions/delete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bot, id }),
		});
		if (!response.ok) {
			throw await failure(
				response,
				`POST /api/sessions/delete failed: ${response.status}`,
			);
		}
	}

	// A read-only search: the query is encoded into the path and the whole
	// SearchResponse comes back; a refused response keeps its 401 observable.
	async function search(query: string): Promise<SearchResponse> {
		const path = `/api/search?q=${encodeURIComponent(query)}`;
		const response = await request(path);
		if (!response.ok) {
			throw await failure(response, `GET ${path} failed: ${response.status}`);
		}
		return (await response.json()) as SearchResponse;
	}

	// The path is always present ("" is the root) and the flags ride as "1",
	// matching the route's exact spellings; a refused listing keeps its status.
	async function listFiles(
		path: string,
		options: { showHidden?: boolean; showIgnored?: boolean } = {},
	): Promise<FileListResponse> {
		const query = new URLSearchParams({ path });
		if (options.showHidden === true) query.set("showHidden", "1");
		if (options.showIgnored === true) query.set("showIgnored", "1");
		const route = `/api/files?${query.toString()}`;
		const response = await request(route);
		if (!response.ok) {
			throw await failure(response, `GET ${route} failed: ${response.status}`);
		}
		return (await response.json()) as FileListResponse;
	}

	// The browse path is absolute and percent-encoded into the query; an
	// omitted path sends no query at all, which the server reads as home. A
	// refusal (outside the roots, unreadable) keeps the server's reason and its
	// status so the modal can show either inline.
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

	// The download URL is built as a literal string rather than through the
	// fetch path: an <a download> navigates the browser itself, so the path and
	// the token ride percent-encoded in the query. The token is appended only
	// when present, keeping the loopback URL token-free like eventsUrl.
	function fileDownloadUrl(path: string): string {
		const base = `/api/files/download?path=${encodeURIComponent(path)}`;
		return token === null ? base : `${base}&token=${encodeURIComponent(token)}`;
	}

	// One file is posted per request so the caller sees that file's own upload
	// progress. The body is multipart/form-data and the browser sets its own
	// boundary, so only the auth header is added. A non-2xx answer rejects with
	// the server's reason; a 2xx `{ ok: false }` resolves because a per-file
	// refusal is a result the caller must show, not a dropped request.
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
			for (const [key, value] of Object.entries(authHeaders(token))) {
				xhr.setRequestHeader(key, value);
			}
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

	// The structure writes share one refusal shape: the server answers
	// { ok: false, error } with a 400/404/500, so failure falls back to the
	// server's reason for the panel to show on the row.
	async function structureOp(route: string, body: unknown): Promise<void> {
		const response = await request(route, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw await failure(response, `POST ${route} failed: ${response.status}`);
		}
	}

	async function mkdir(path: string): Promise<void> {
		await structureOp("/api/files/mkdir", { path });
	}

	async function renameEntry(from: string, to: string): Promise<void> {
		await structureOp("/api/files/rename", { from, to });
	}

	async function moveEntry(from: string, to: string): Promise<void> {
		await structureOp("/api/files/move", { from, to });
	}

	async function deleteEntry(path: string, recursive?: boolean): Promise<void> {
		await structureOp(
			"/api/files/delete",
			recursive === true ? { path, recursive: true } : { path },
		);
	}

	async function createBot(draft: BotDraft): Promise<void> {
		const response = await request("/api/bots", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(draft),
		});
		if (!response.ok) {
			// Surface the server's human-readable error so the dialog can show it
			// inline; fall back to a generic message if the body is not JSON.
			let message = `创建 Bot 失败 (${response.status})`;
			try {
				const body = (await response.json()) as { error?: string };
				if (typeof body.error === "string" && body.error !== "") {
					message = body.error;
				}
			} catch {
				// keep the fallback message
			}
			throw new Error(message);
		}
	}

	async function updateBot(bot: string, draft: UpdateBotBody): Promise<void> {
		const path = `/api/bots/${encodeURIComponent(bot)}`;
		const response = await request(path, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(draft),
		});
		if (!response.ok) {
			// The server's reason (an unknown bot, a refused draft) is what the
			// settings panel shows inline; failure keeps the 401 observable.
			throw await failure(response, `PATCH ${path} failed: ${response.status}`);
		}
	}

	async function removeBot(bot: string): Promise<void> {
		const path = `/api/bots/${encodeURIComponent(bot)}`;
		const response = await request(path, { method: "DELETE" });
		if (!response.ok) {
			throw await failure(
				response,
				`DELETE ${path} failed: ${response.status}`,
			);
		}
	}

	async function loadSettings(): Promise<SettingsResponse> {
		const response = await request("/api/settings");
		if (!response.ok) {
			throw new Error(`GET /api/settings failed: ${response.status}`);
		}
		return (await response.json()) as SettingsResponse;
	}

	async function saveProvider(body: SaveProviderBody): Promise<SavedProvider> {
		const response = await request("/api/settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let payload: SaveProviderResponse | null = null;
		try {
			payload = (await response.json()) as SaveProviderResponse;
		} catch {
			payload = null;
		}
		if (!response.ok || payload === null || payload.ok !== true) {
			// Surface the server's human-readable error so the dialog can show it
			// inline (and offer "save anyway" for a verify failure); fall back to a
			// generic message if the body is missing or malformed.
			const message =
				payload !== null &&
				payload.ok === false &&
				typeof payload.error === "string" &&
				payload.error !== ""
					? payload.error
					: `保存设置失败 (${response.status})`;
			throw new Error(message);
		}
		return payload;
	}

	async function loadAgents(): Promise<AgentListResponse> {
		const response = await request("/api/agents");
		if (!response.ok) {
			throw new Error(`GET /api/agents failed: ${response.status}`);
		}
		return (await response.json()) as AgentListResponse;
	}

	async function installAgent(id: string): Promise<InstallAgentStartResponse> {
		const body: InstallAgentBody = { id, confirm: true };
		const response = await request("/api/agents/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let payload:
			| InstallAgentStartResponse
			| { ok: false; error?: string }
			| null = null;
		try {
			payload = (await response.json()) as
				| InstallAgentStartResponse
				| { ok: false; error?: string };
		} catch {
			payload = null;
		}
		if (!response.ok || payload === null || payload.ok !== true) {
			// Surface the server's reason (unknown id, not loopback, busy) and fall
			// back to a generic message when the body is missing or malformed.
			const message =
				payload !== null &&
				payload.ok === false &&
				typeof payload.error === "string" &&
				payload.error !== ""
					? payload.error
					: `安装失败 (${response.status})`;
			throw new Error(message);
		}
		return payload;
	}

	async function cancelAgent(id: string): Promise<void> {
		// A failed cancel is not fatal: the job may already have finished.
		const body: CancelAgentBody = { id };
		await request("/api/agents/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function switchWorkspace(root: string): Promise<SwitchWorkspaceResult> {
		// Switching is refused rather than merged: a rejected root (unknown path,
		// busy turn) comes back as ok:false with the server's reason, which the
		// picker shows inline. Success is silent; the server's hello resets state.
		const response = await request("/api/workspaces", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ root }),
		});
		let payload: { ok?: boolean; error?: string } | null = null;
		try {
			payload = (await response.json()) as { ok?: boolean; error?: string };
		} catch {
			payload = null;
		}
		if (!response.ok || payload?.ok !== true) {
			const message =
				typeof payload?.error === "string" && payload.error !== ""
					? payload.error
					: `切换工作区失败 (${response.status})`;
			return { ok: false, error: message };
		}
		return { ok: true };
	}

	async function send(
		bot: string,
		text: string,
		images?: ImagePart[],
	): Promise<void> {
		const path = "/api/send";
		const body: SendBody = {
			bot,
			text,
			// Omitted rather than sent empty, so a text-only send is byte for
			// byte the request it was before images existed.
			...(images !== undefined && images.length > 0 ? { images } : {}),
		};
		const response = await request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			// The server names a refused attachment (bad media type, over the
			// size cap); the composer shows that message verbatim.
			throw await failure(response, `POST ${path} failed: ${response.status}`);
		}
	}

	return {
		eventsUrl: () => eventsUrl(token),
		send,
		interrupt: (bot) => post("/api/interrupt", { bot }),
		respondApproval: (id, choice) =>
			post("/api/approval", { id, decision: choice }),
		setAllowAll: (on) => post("/api/allow-all", { on }),
		newSession: (bot) => post("/api/sessions/new", { bot }),
		openSession: (bot, id) => post("/api/sessions/open", { bot, id }),
		loadBotTranscript,
		loadMemory,
		forgetMemory,
		setWake,
		closeBotSession,
		renameSession,
		deleteSession,
		search,
		listFiles,
		listDirs,
		fileDownloadUrl,
		upload,
		mkdir,
		renameEntry,
		moveEntry,
		deleteEntry,
		createBot,
		updateBot,
		removeBot,
		loadSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelAgent,
		switchWorkspace,
	};
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
