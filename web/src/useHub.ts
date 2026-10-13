import { useCallback, useEffect, useReducer } from "react";
import { createApi } from "./api";
import { readToken } from "./auth";
import type {
	ApprovalChoice,
	BotDraft,
	SaveProviderBody,
	ServerEvent,
} from "./protocol";
import { type ClientState, clientReducer, initialState } from "./state";

// The server hands the token in the page URL on a non-loopback bind, where
// every /api/* request is gated; loopback leaves it absent, keeping no-auth.
// Read once at import; guard the missing window so a node import cannot throw.
const token =
	typeof window === "undefined" ? null : readToken(window.location.search);

// Built once; every request (and the SSE URL) goes through the token-aware
// client, which keeps the request construction testable outside React.
const api = createApi({ token });

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
		const source = new EventSource(api.eventsUrl());

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
		api.send(bot, text).catch(() => {});
	}, []);

	const interrupt = useCallback((bot: string) => {
		api.interrupt(bot).catch(() => {});
	}, []);

	const respondApproval = useCallback(
		(id: string, decision: ApprovalChoice) => {
			// Drop the modal immediately; the server echoes approval_resolved, which
			// is a no-op once the id is gone.
			dispatch({ type: "approval_removed", id });
			api.respondApproval(id, decision).catch(() => {});
		},
		[],
	);

	const setAllowAll = useCallback((on: boolean) => {
		dispatch({ type: "server", event: { type: "allow_all", on } });
		api.setAllowAll(on).catch(() => {});
	}, []);

	const newSession = useCallback((bot: string) => {
		api.newSession(bot).catch(() => {});
	}, []);

	const openSession = useCallback((bot: string, id: string) => {
		api.openSession(bot, id).catch(() => {});
	}, []);

	const createBot = useCallback(async (draft: BotDraft) => {
		await api.createBot(draft);
	}, []);

	const loadSettings = useCallback(async () => {
		const body = await api.loadSettings();
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
		try {
			const saved = await api.saveProvider(body);
			dispatch({ type: "settings_error", error: null });
			// Apply immediately; the server also broadcasts a `settings` event,
			// which is a no-op replacement once this lands.
			dispatch({ type: "settings_provider", provider: saved.provider });
			return saved.warning;
		} catch (error) {
			// Surface the server's human-readable error so the dialog can show it
			// inline (and offer "save anyway" for a verify failure); fall back to a
			// generic message if the body is missing or malformed.
			const message = error instanceof Error ? error.message : String(error);
			dispatch({ type: "settings_error", error: message });
			throw error;
		}
	}, []);

	const loadAgents = useCallback(async () => {
		const body = await api.loadAgents();
		dispatch({ type: "agents_loaded", agents: body.agents });
	}, []);

	const installAgent = useCallback(async (id: string) => {
		const result = await api.installAgent(id);
		// The server also streams an `agent_job`, but apply it now so the row
		// reacts to the click without waiting for the round trip.
		dispatch({
			type: "server",
			event: { type: "agent_job", job: result.job },
		});
	}, []);

	const cancelInstall = useCallback((id: string) => {
		return api.cancelAgent(id).catch(() => undefined);
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
