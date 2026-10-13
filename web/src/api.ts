import { authHeaders, eventsUrl } from "./auth";
import type {
	AgentListResponse,
	ApprovalChoice,
	BotDraft,
	BotTranscriptResponse,
	CancelAgentBody,
	ForgetMemoryBody,
	ImagePart,
	InstallAgentBody,
	InstallAgentStartResponse,
	MemoryListResponse,
	SaveProviderBody,
	SaveProviderResponse,
	SendBody,
	SettingsResponse,
	SetWakeBody,
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
	createBot(draft: BotDraft): Promise<void>;
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

type ApiInit = Omit<RequestInit, "headers"> & {
	headers?: Record<string, string>;
};

// The request construction lives outside the React hook so a node test can
// drive it. Every request carries the bearer token on a non-loopback bind,
// where the server gates each /api/* path.
export function createApi(options: {
	token: string | null;
	fetchImpl?: typeof fetch;
}): ApiClient {
	const { token } = options;
	const doFetch = options.fetchImpl ?? fetch;

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
		createBot,
		loadSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelAgent,
		switchWorkspace,
	};
}
