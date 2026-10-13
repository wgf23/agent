import { authHeaders, eventsUrl } from "./auth";
import type {
	AgentListResponse,
	ApprovalChoice,
	BotDraft,
	CancelAgentBody,
	InstallAgentBody,
	InstallAgentStartResponse,
	SaveProviderBody,
	SaveProviderResponse,
	SettingsResponse,
} from "./protocol";

export interface ApiClient {
	eventsUrl(): string;
	send(bot: string, text: string): Promise<void>;
	interrupt(bot: string): Promise<void>;
	respondApproval(id: string, choice: ApprovalChoice): Promise<void>;
	setAllowAll(on: boolean): Promise<void>;
	newSession(bot: string): Promise<void>;
	openSession(bot: string, id: string): Promise<void>;
	createBot(draft: BotDraft): Promise<void>;
	loadSettings(): Promise<SettingsResponse>;
	// Returns the accepted provider so the caller can apply it immediately
	// instead of waiting for the server's broadcast.
	saveProvider(body: SaveProviderBody): Promise<SavedProvider>;
	loadAgents(): Promise<AgentListResponse>;
	installAgent(id: string): Promise<InstallAgentStartResponse>;
	cancelAgent(id: string): Promise<void>;
}

export type SavedProvider = Extract<SaveProviderResponse, { ok: true }>;

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

	return {
		eventsUrl: () => eventsUrl(token),
		send: (bot, text) => post("/api/send", { bot, text }),
		interrupt: (bot) => post("/api/interrupt", { bot }),
		respondApproval: (id, choice) =>
			post("/api/approval", { id, decision: choice }),
		setAllowAll: (on) => post("/api/allow-all", { on }),
		newSession: (bot) => post("/api/sessions/new", { bot }),
		openSession: (bot, id) => post("/api/sessions/open", { bot, id }),
		createBot,
		loadSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelAgent,
	};
}
