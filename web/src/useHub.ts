import { useCallback, useEffect, useReducer } from "react";
import {
	ApiError,
	createApi,
	type SwitchWorkspaceResult,
	type UploadOptions,
	type UploadResult,
} from "./api";
import { readToken } from "./auth";
import type {
	ApprovalChoice,
	BotDraft,
	FileListResponse,
	FsDirsResponse,
	ImagePart,
	SaveProviderBody,
	ServerEvent,
	SetWakeBody,
	UpdateBotBody,
} from "./protocol";
import { WORKSPACE_BOT } from "./protocol";
import { type ClientState, clientReducer, initialState } from "./state";

// The server hands the token in the page URL on a non-loopback bind, where
// every /api/* request is gated; loopback leaves it absent, keeping no-auth.
// Read once at import; guard the missing window so a node import cannot throw.
const token =
	typeof window === "undefined" ? null : readToken(window.location.search);

// Built once; every request (and the SSE URL) goes through the token-aware
// client, which keeps the request construction testable outside React.
const api = createApi({ token });

// A 401 is an auth refusal, not a dropped connection; the hub flags it so the
// UI can say the token is bad instead of showing a retry.
function isAuthRefusal(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

// The server's own message, which the response-reading calls build from the
// error body: an unknown bot, an unknown memory entry, a refused wake. Falls
// back to the status when a refused response carried no reason at all.
function failureMessage(error: unknown): string {
	if (error instanceof ApiError) return `${error.message} (${error.status})`;
	return error instanceof Error ? error.message : String(error);
}

export interface Hub {
	state: ClientState;
	// Images are optional and already validated by the composer; a refusal
	// lands on the error banner.
	send: (bot: string, text: string, images?: ImagePart[]) => void;
	// The tree's click-to-read: asks the workspace chat to read one file, named
	// by its workspace-relative path, through the ordinary send path.
	readFile: (path: string) => void;
	interrupt: (bot: string) => void;
	respondApproval: (id: string, decision: ApprovalChoice) => void;
	setAllowAll: (on: boolean) => void;
	newSession: (bot: string) => void;
	openSession: (bot: string, id: string) => void;
	// Selects a bot: loads its transcript and session list, then its memory, so
	// the sidebar and memory panel fill without a second request.
	selectBot: (bot: string) => void;
	// Rejects with the server's message on failure: the memory panel renders
	// that next to the row whose delete failed.
	forgetMemory: (bot: string, id: string) => Promise<void>;
	setWake: (bot: string, body: SetWakeBody) => Promise<void>;
	closeBotSession: (bot: string, id: string) => void;
	// Rejects with the server's message so the row can show it inline; a 401 is
	// still reported as the auth error.
	renameSession: (bot: string, id: string, title: string) => Promise<void>;
	deleteSession: (bot: string, id: string) => Promise<void>;
	// A read-only search over the chat and every bot's sessions; a blank query
	// is not sent, and the answer lands in state.search for the sidebar panel.
	search: (query: string) => void;
	clearSearch: () => void;
	// A read-only directory listing for the file panel. It forwards to the
	// token-aware client and returns the response; the panel owns the state.
	listFiles: (
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	) => Promise<FileListResponse>;
	// A read-only filesystem browse of directories for the workspace modal,
	// bounded by the server to home and the active root; the modal owns state.
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	// The token-aware download URL for one file, so a plain <a download> in
	// the panel authenticates on a non-loopback bind.
	fileDownloadUrl: (path: string) => string;
	// The token-aware zip URL for one directory, so a directory row's 打包下载
	// anchor authenticates the same way.
	fileArchiveUrl: (path: string) => string;
	// Uploads one file into a workspace directory and reports its progress; the
	// panel owns the per-file list and the overwrite retry.
	upload: (
		path: string,
		file: File,
		options?: UploadOptions,
	) => Promise<UploadResult>;
	// Structure writes for the file panel; each rejects with the server's
	// reason so the row can show it, and the panel owns the refresh.
	mkdir: (path: string) => Promise<void>;
	renameEntry: (from: string, to: string) => Promise<void>;
	moveEntry: (from: string, to: string) => Promise<void>;
	deleteEntry: (path: string, recursive?: boolean) => Promise<void>;
	createBot: (draft: BotDraft) => Promise<void>;
	// Rejects with the server's message so the settings panel can show it
	// inline; a 401 is still reported as the auth error.
	updateBot: (bot: string, draft: UpdateBotBody) => Promise<void>;
	// Resolves once the server accepts; the hub drops the bot from the roster
	// immediately so a deleted bot cannot stay selected, then rejects on failure.
	removeBot: (bot: string) => Promise<void>;
	loadSettings: () => Promise<void>;
	openSettings: () => void;
	closeSettings: () => void;
	// Resolves with the server's optional non-blocking warning so the dialog can
	// surface it; throws the server's error message on failure.
	saveProvider: (body: SaveProviderBody) => Promise<string | undefined>;
	loadAgents: () => Promise<void>;
	installAgent: (id: string) => Promise<void>;
	cancelInstall: (id: string) => Promise<void>;
	// Resolves with the server's refusal (busy turn, unopenable root) so the
	// picker can show it; success stays silent while the fresh hello resets state.
	switchWorkspace: (root: string) => Promise<SwitchWorkspaceResult>;
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

	// Every refusal from a client request lands somewhere visible: a 401 on
	// the auth banner, anything else on the error banner with the server's
	// reason. Nothing is swallowed.
	const reportError = useCallback((error: unknown) => {
		if (isAuthRefusal(error)) {
			dispatch({ type: "auth_error", authError: true });
			return;
		}
		dispatch({ type: "request_error", error: failureMessage(error) });
	}, []);

	const send = useCallback(
		(bot: string, text: string, images?: ImagePart[]) => {
			dispatch({ type: "submit", bot, text });
			// A refused attachment (a cap the server enforces more strictly, a
			// media type it rejects) is a real answer the user must see.
			api.send(bot, text, images).catch(reportError);
		},
		[reportError],
	);

	const interrupt = useCallback((bot: string) => {
		api.interrupt(bot).catch(() => {});
	}, []);

	// The file tree's click-to-read drafts the message and sends it as if the
	// user typed it, so the read rides the normal turn machinery.
	const readFile = useCallback(
		(path: string) => {
			send(WORKSPACE_BOT, `请读取工作区文件 ${path}`);
		},
		[send],
	);

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

	const selectBot = useCallback(
		(bot: string) => {
			void (async () => {
				try {
					// One read answers both questions: the transcript replaces this
					// bot's transcript, its session list fills the bot-keyed maps.
					const transcript = await api.loadBotTranscript(bot);
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
					const memory = await api.loadMemory(bot);
					dispatch({ type: "memory_loaded", bot, entries: memory.entries });
				} catch (error) {
					reportError(error);
				}
			})();
		},
		[reportError],
	);

	const forgetMemory = useCallback(
		async (bot: string, id: string) => {
			try {
				await api.forgetMemory(bot, id);
				// Re-read so the panel reflects the ledger, not a local guess.
				const memory = await api.loadMemory(bot);
				dispatch({ type: "memory_loaded", bot, entries: memory.entries });
			} catch (error) {
				reportError(error);
				// The panel owns the message for a delete: it renders the failure
				// on the row, so the promise is handed back rather than dropped.
				throw error instanceof Error ? error : new Error(failureMessage(error));
			}
		},
		[reportError],
	);

	const setWake = useCallback(
		async (bot: string, body: SetWakeBody) => {
			try {
				// The server re-emits the roster after arming the timer, so the
				// fresh `bots` event refreshes the wake badge with no extra read.
				await api.setWake(bot, body);
			} catch (error) {
				reportError(error);
			}
		},
		[reportError],
	);

	const closeBotSession = useCallback(
		(bot: string, id: string) => {
			api.closeBotSession(bot, id).catch(reportError);
		},
		[reportError],
	);

	// A rename and a delete are reflected by the server's next `sessions` (chat)
	// or `bot_sessions` (bot) event, which already replaces the list wholesale,
	// so no reducer change is needed here.
	const renameSession = useCallback(
		async (bot: string, id: string, title: string) => {
			try {
				await api.renameSession(bot, id, title);
			} catch (error) {
				// The row owns the message for the write, so the promise is handed
				// back rather than dropped; a 401 lands on the auth banner.
				reportError(error);
				throw error instanceof Error ? error : new Error(failureMessage(error));
			}
		},
		[reportError],
	);

	const deleteSession = useCallback(
		async (bot: string, id: string) => {
			try {
				await api.deleteSession(bot, id);
			} catch (error) {
				reportError(error);
				throw error instanceof Error ? error : new Error(failureMessage(error));
			}
		},
		[reportError],
	);

	const createBot = useCallback(async (draft: BotDraft) => {
		await api.createBot(draft);
	}, []);

	// A blank query is the server's 400; not sending it gets the same answer
	// without the round trip. The result lands in the search slice, and a
	// refusal is both reported (401 -> auth banner) and kept for the panel.
	const search = useCallback(
		(query: string) => {
			const trimmed = query.trim();
			if (trimmed === "") return;
			dispatch({ type: "search_started", query: trimmed });
			api
				.search(trimmed)
				.then((results) => dispatch({ type: "search_results", results }))
				.catch((error) => {
					reportError(error);
					dispatch({ type: "search_failed", error: failureMessage(error) });
				});
		},
		[reportError],
	);

	const clearSearch = useCallback(() => {
		dispatch({ type: "search_cleared" });
	}, []);

	const listFiles = useCallback(
		(path: string, options?: { showHidden?: boolean; showIgnored?: boolean }) =>
			api.listFiles(path, options),
		[],
	);

	const listDirs = useCallback((path?: string) => api.listDirs(path), []);

	// Pure URL construction: no request, so a plain anchor can carry it.
	const fileDownloadUrl = useCallback(
		(path: string) => api.fileDownloadUrl(path),
		[],
	);

	const fileArchiveUrl = useCallback(
		(path: string) => api.fileArchiveUrl(path),
		[],
	);

	// Forwarded whole so the panel keeps the per-file progress callback and the
	// overwrite retry; a refusal rejects with the server's message.
	const upload = useCallback(
		(path: string, file: File, options?: UploadOptions) =>
			api.upload(path, file, options),
		[],
	);

	// Forwarded whole too: the panel shows the server's reason on the row and
	// re-reads the directories the entry left and landed in.
	const mkdir = useCallback((path: string) => api.mkdir(path), []);
	const renameEntry = useCallback(
		(from: string, to: string) => api.renameEntry(from, to),
		[],
	);
	const moveEntry = useCallback(
		(from: string, to: string) => api.moveEntry(from, to),
		[],
	);
	const deleteEntry = useCallback(
		(path: string, recursive?: boolean) => api.deleteEntry(path, recursive),
		[],
	);

	const updateBot = useCallback(
		async (bot: string, draft: UpdateBotBody) => {
			try {
				await api.updateBot(bot, draft);
			} catch (error) {
				// Same as setWake: a non-401 refusal lands on the error banner.
				// The panel also owns the message, so the promise is handed back
				// rather than dropped.
				reportError(error);
				throw error instanceof Error ? error : new Error(failureMessage(error));
			}
		},
		[reportError],
	);

	const removeBot = useCallback(
		async (bot: string) => {
			try {
				await api.removeBot(bot);
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
			} catch (error) {
				reportError(error);
				throw error instanceof Error ? error : new Error(failureMessage(error));
			}
		},
		[reportError, state.bots, state.botStates],
	);

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

	const switchWorkspace = useCallback(
		(root: string) => api.switchWorkspace(root),
		[],
	);

	return {
		state,
		send,
		readFile,
		interrupt,
		respondApproval,
		setAllowAll,
		newSession,
		openSession,
		selectBot,
		forgetMemory,
		setWake,
		closeBotSession,
		renameSession,
		deleteSession,
		search,
		clearSearch,
		listFiles,
		listDirs,
		fileDownloadUrl,
		fileArchiveUrl,
		upload,
		mkdir,
		renameEntry,
		moveEntry,
		deleteEntry,
		createBot,
		updateBot,
		removeBot,
		loadSettings,
		openSettings,
		closeSettings,
		saveProvider,
		loadAgents,
		installAgent,
		cancelInstall,
		switchWorkspace,
	};
}
