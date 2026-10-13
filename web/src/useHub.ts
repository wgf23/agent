import { useCallback, useEffect, useReducer } from "react";
import type {
	AgentListResponse,
	ApprovalChoice,
	BotDraft,
	InstallAgentStartResponse,
	SaveProviderBody,
	SaveProviderResponse,
	ServerEvent,
	SettingsResponse,
} from "./protocol";
import { type ClientState, clientReducer, initialState } from "./state";

async function post(path: string, body: unknown): Promise<void> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`POST ${path} failed: ${response.status}`);
	}
}

export interface Hub {
	state: ClientState;
	send: (bot: string, text: string) => void;
	interrupt: (bot: string) => void;
	respondApproval: (id: string, decision: ApprovalChoice) => void;
	setAllowAll: (on: boolean) => void;
	newSession: (bot: string) => void;
	openSession: (bot: string, id: string) => void;
	createBot: (draft: BotDraft) => Promise<void>;
	loadSettings: () => Promise<void>;
	openSettings: () => void;
	closeSettings: () => void;
	// Resolves with the server's optional non-blocking warning so the dialog can
	// surface it; throws the server's error message on failure.
	saveProvider: (body: SaveProviderBody) => Promise<string | undefined>;
	loadAgents: () => Promise<void>;
	installAgent: (id: string) => Promise<void>;
	cancelInstall: (id: string) => Promise<void>;
}

export function useHub(): Hub {
	const [state, dispatch] = useReducer(clientReducer, undefined, initialState);

	useEffect(() => {
		const source = new EventSource("/api/events");

		source.onopen = () => dispatch({ type: "connection", status: "open" });
		// EventSource reconnects automatically; "closed" just dims the status dot
		// until the next open/hello arrives.
		source.onerror = () => dispatch({ type: "connection", status: "closed" });
		source.onmessage = (message) => {
			let event: ServerEvent;
			try {
				event = JSON.parse(message.data) as ServerEvent;
			} catch {
				return;
			}
			dispatch({ type: "server", event });
		};

		return () => source.close();
	}, []);

	const send = useCallback((bot: string, text: string) => {
		dispatch({ type: "submit", bot, text });
		post("/api/send", { bot, text }).catch(() => {});
	}, []);

	const interrupt = useCallback((bot: string) => {
		post("/api/interrupt", { bot }).catch(() => {});
	}, []);

	const respondApproval = useCallback(
		(id: string, decision: ApprovalChoice) => {
			// Drop the modal immediately; the server echoes approval_resolved, which
			// is a no-op once the id is gone.
			dispatch({ type: "approval_removed", id });
			post("/api/approval", { id, decision }).catch(() => {});
		},
		[],
	);

	const setAllowAll = useCallback((on: boolean) => {
		dispatch({ type: "server", event: { type: "allow_all", on } });
		post("/api/allow-all", { on }).catch(() => {});
	}, []);

	const newSession = useCallback((bot: string) => {
		post("/api/sessions/new", { bot }).catch(() => {});
	}, []);

	const openSession = useCallback((bot: string, id: string) => {
		post("/api/sessions/open", { bot, id }).catch(() => {});
	}, []);

	const createBot = useCallback(async (draft: BotDraft) => {
		const response = await fetch("/api/bots", {
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
	}, []);

	const loadSettings = useCallback(async () => {
		const response = await fetch("/api/settings");
		if (!response.ok) {
			throw new Error(`GET /api/settings failed: ${response.status}`);
		}
		const body = (await response.json()) as SettingsResponse;
		dispatch({ type: "settings_presets", presets: body.presets });
		dispatch({ type: "settings_provider", provider: body.provider });
	}, []);

	const openSettings = useCallback(() => {
		dispatch({ type: "settings_open" });
		// Refresh the server's provider view and preset list so the dialog opens
		// with current data; the dialog still works if this request fails.
		loadSettings().catch(() => {});
	}, [loadSettings]);

	const closeSettings = useCallback(() => {
		dispatch({ type: "settings_close" });
	}, []);

	const saveProvider = useCallback(async (body: SaveProviderBody) => {
		const response = await fetch("/api/settings", {
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
			dispatch({ type: "settings_error", error: message });
			throw new Error(message);
		}
		dispatch({ type: "settings_error", error: null });
		// Apply immediately; the server also broadcasts a `settings` event, which
		// is a no-op replacement once this lands.
		dispatch({ type: "settings_provider", provider: payload.provider });
		return payload.warning;
	}, []);

	const loadAgents = useCallback(async () => {
		const response = await fetch("/api/agents");
		if (!response.ok) {
			throw new Error(`GET /api/agents failed: ${response.status}`);
		}
		const body = (await response.json()) as AgentListResponse;
		dispatch({ type: "agents_loaded", agents: body.agents });
	}, []);

	const installAgent = useCallback(async (id: string) => {
		const response = await fetch("/api/agents/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, confirm: true }),
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
		// The server also streams an `agent_job`, but apply it now so the row
		// reacts to the click without waiting for the round trip.
		dispatch({
			type: "server",
			event: { type: "agent_job", job: payload.job },
		});
	}, []);

	const cancelInstall = useCallback((id: string) => {
		return post("/api/agents/cancel", { id }).catch(() => undefined);
	}, []);

	return {
		state,
		send,
		interrupt,
		respondApproval,
		setAllowAll,
		newSession,
		openSession,
		createBot,
		loadSettings,
		openSettings,
		closeSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelInstall,
	};
}
