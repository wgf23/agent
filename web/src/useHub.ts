import { useCallback, useEffect, useReducer } from "react";
import {
	closeBotSession as closeBotSessionRequest,
	deleteSession as deleteSessionRequest,
	forgetMemory as forgetMemoryRequest,
	loadBotTranscript,
	loadMemory,
	removeBot as removeBotRequest,
	renameSession as renameSessionRequest,
	searchSessions,
	setWake as setWakeRequest,
	updateBot as updateBotRequest,
} from "./api";
import type {
	AgentListResponse,
	ApprovalChoice,
	BotDraft,
	ImagePart,
	InstallAgentStartResponse,
	RoomInfo,
	SaveProviderBody,
	SaveProviderResponse,
	SendBody,
	ServerEvent,
	SettingsResponse,
	SetWakeBody,
	UpdateBotBody,
} from "./protocol";
import { type ClientState, clientReducer, initialState } from "./state";

async function post(path: string, body: unknown): Promise<void> {
	await postJson(path, body);
}

// POST a JSON body and return the parsed response. A rejection throws the
// server's human-readable error text so a dialog or composer can show it;
// the fallback only fires when the body is not JSON.
async function postJson(path: string, body: unknown): Promise<unknown> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		let message = `POST ${path} failed: ${response.status}`;
		try {
			const payload = (await response.json()) as { error?: string };
			if (typeof payload.error === "string" && payload.error !== "") {
				message = payload.error;
			}
		} catch {
			// keep the fallback message
		}
		throw new Error(message);
	}
	return response.json().catch(() => null);
}

export interface Hub {
	state: ClientState;
	// Images are optional and already validated by the composer; the route
	// validates them again and a refusal lands on the error banner.
	send: (bot: string, text: string, images?: ImagePart[]) => void;
	interrupt: (bot: string) => void;
	respondApproval: (id: string, decision: ApprovalChoice) => void;
	setAllowAll: (on: boolean) => void;
	newSession: (bot: string) => void;
	openSession: (bot: string, id: string) => void;
	// Rejects with the server's message so the row can show it inline.
	renameSession: (bot: string, id: string, title: string) => Promise<void>;
	deleteSession: (bot: string, id: string) => Promise<void>;
	// Selects a bot: loads its transcript and session list, then its memory, so
	// the sidebar and memory panel fill without a second request.
	selectBot: (bot: string) => void;
	// Rejects with the server's message so the panel can show it inline.
	forgetMemory: (bot: string, id: string) => Promise<void>;
	// Reports a refusal on the banner; the editor's button re-renders from the
	// roster event the server sends after arming the timer.
	setWake: (bot: string, body: SetWakeBody) => Promise<void>;
	closeBotSession: (bot: string, id: string) => void;
	// Rejects with the server's message so the settings panel can show it
	// inline.
	updateBot: (bot: string, draft: UpdateBotBody) => Promise<void>;
	// Resolves once the server accepts; the hub drops the bot from the roster
	// immediately so a deleted bot cannot stay selected, then rejects on failure.
	removeBot: (bot: string) => Promise<void>;
	// A read-only search over the chat's sessions and every room's transcript;
	// a blank query is not sent, and the answer lands in state.search for the
	// sidebar panel.
	search: (query: string) => void;
	clearSearch: () => void;
	createBot: (draft: BotDraft) => Promise<void>;
	createRoom: (
		name: string,
		members: string[],
		coordinator: string | null,
	) => Promise<void>;
	sendToRoom: (room: string, text: string) => Promise<void>;
	interruptRoom: (room: string) => Promise<void>;
	loadSettings: () => Promise<void>;
	openSettings: () => void;
	closeSettings: () => void;
	// Resolves with the server's optional non-blocking warning so the dialog can
	// surface it; throws the server's error message on failure.
	saveProvider: (body: SaveProviderBody) => Promise<string | undefined>;
	loadAgents: () => Promise<void>;
	installAgent: (id: string) => Promise<void>;
	cancelInstall: (id: string) => void;
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

	const send = useCallback(
		(bot: string, text: string, images?: ImagePart[]) => {
			dispatch({ type: "submit", bot, text });
			const body: SendBody = {
				bot,
				text,
				// Omitted rather than sent empty, so a text-only send is byte for
				// byte the request it was before images existed.
				...(images !== undefined && images.length > 0 ? { images } : {}),
			};
			// A refused attachment (a cap the server enforces more strictly, a
			// media type it rejects) is a real answer the user must see.
			post("/api/send", body).catch((error: unknown) => {
				dispatch({
					type: "request_error",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		},
		[],
	);

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

	// A rename and a delete are reflected by the server's next `sessions` (or
	// `session_opened`) event, which replaces the list wholesale, so no reducer
	// change is needed. The rejection carries the server's reason so the row
	// can print it.
	const renameSession = useCallback(
		async (bot: string, id: string, title: string) => {
			await renameSessionRequest(bot, id, title);
		},
		[],
	);

	const deleteSession = useCallback(async (bot: string, id: string) => {
		await deleteSessionRequest(bot, id);
	}, []);

	// A request this client made was refused: the server's reason goes to the
	// same banner as an SSE error so it is never swallowed.
	const reportRequestError = useCallback((error: unknown) => {
		dispatch({
			type: "request_error",
			error: error instanceof Error ? error.message : String(error),
		});
	}, []);

	const selectBot = useCallback(
		(bot: string) => {
			void (async () => {
				try {
					// One read answers both questions: the transcript replaces this
					// bot's transcript, its session list fills the bot-keyed maps.
					const transcript = await loadBotTranscript(bot);
					dispatch({
						type: "server",
						event: {
							type: "session_opened",
							bot,
							sessionId: transcript.sessionId,
							messages: transcript.messages,
						},
					});
					dispatch({
						type: "server",
						event: {
							type: "bot_sessions",
							bot,
							sessions: transcript.sessions,
							currentSessionId: transcript.sessionId,
						},
					});
					const memory = await loadMemory(bot);
					dispatch({ type: "memory_loaded", bot, entries: memory.entries });
				} catch (error) {
					reportRequestError(error);
				}
			})();
		},
		[reportRequestError],
	);

	const forgetMemory = useCallback(async (bot: string, id: string) => {
		await forgetMemoryRequest(bot, id);
		// Re-read so the panel reflects the ledger, not a local guess.
		const memory = await loadMemory(bot);
		dispatch({ type: "memory_loaded", bot, entries: memory.entries });
	}, []);

	const setWake = useCallback(
		async (bot: string, body: SetWakeBody) => {
			try {
				// The server re-emits the roster after arming the timer, so the
				// fresh `bots` event refreshes the wake badge with no extra read.
				await setWakeRequest(bot, body);
			} catch (error) {
				reportRequestError(error);
			}
		},
		[reportRequestError],
	);

	const closeBotSession = useCallback(
		(bot: string, id: string) => {
			closeBotSessionRequest(bot, id).catch(reportRequestError);
		},
		[reportRequestError],
	);

	const updateBot = useCallback(async (bot: string, draft: UpdateBotBody) => {
		await updateBotRequest(bot, draft);
	}, []);

	const removeBot = useCallback(
		async (bot: string) => {
			await removeBotRequest(bot);
			// The server broadcasts the fresh roster, but drop the bot here too
			// so a deleted bot cannot stay selected until that event arrives.
			dispatch({
				type: "server",
				event: {
					type: "bots",
					bots: state.bots.filter((entry) => entry.name !== bot),
					states: Object.values(state.botStates).filter(
						(entry) => entry.bot !== bot,
					),
				},
			});
		},
		[state.bots, state.botStates],
	);

	// A blank query is the server's 400; not sending it gets the same answer
	// without the round trip. The result lands in the search slice, and a
	// failure is both reported on the banner and kept for the panel.
	const search = useCallback((query: string) => {
		const trimmed = query.trim();
		if (trimmed === "") return;
		dispatch({ type: "search_started", query: trimmed });
		searchSessions(trimmed)
			.then((results) => dispatch({ type: "search_results", results }))
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				dispatch({ type: "request_error", error: message });
				dispatch({ type: "search_failed", error: message });
			});
	}, []);

	const clearSearch = useCallback(() => {
		dispatch({ type: "search_cleared" });
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

	const createRoom = useCallback(
		async (name: string, members: string[], coordinator: string | null) => {
			const body = (await postJson("/api/rooms", {
				name,
				members,
				...(coordinator === null ? {} : { coordinator }),
			})) as { room?: RoomInfo } | null;
			// Seed the room from the server's snapshot so it can be opened before
			// its members event arrives; nothing is appended to the transcript.
			if (body?.room !== undefined) {
				dispatch({ type: "room_created", room: body.room });
			}
		},
		[],
	);

	const sendToRoom = useCallback(async (room: string, text: string) => {
		await postJson("/api/rooms/send", { room, text });
	}, []);

	const interruptRoom = useCallback(async (room: string) => {
		await postJson("/api/rooms/interrupt", { room });
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

	// Installing runs a global npm command on the machine hosting the server, so
	// the request carries the explicit confirmation the route requires.
	const installAgent = useCallback(async (id: string) => {
		const result = (await postJson("/api/agents/install", {
			id,
			confirm: true,
		})) as InstallAgentStartResponse | null;
		// The server also streams an `agent_job`, but apply it now so the row
		// reacts to the click without waiting for the round trip.
		if (result !== null) {
			dispatch({
				type: "server",
				event: { type: "agent_job", job: result.job },
			});
		}
	}, []);

	const cancelInstall = useCallback((id: string) => {
		postJson("/api/agents/cancel", { id }).catch(() => undefined);
	}, []);

	return {
		state,
		send,
		interrupt,
		respondApproval,
		setAllowAll,
		newSession,
		openSession,
		renameSession,
		deleteSession,
		selectBot,
		forgetMemory,
		setWake,
		closeBotSession,
		updateBot,
		removeBot,
		search,
		clearSearch,
		createBot,
		createRoom,
		sendToRoom,
		interruptRoom,
		loadSettings,
		openSettings,
		closeSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelInstall,
	};
}
