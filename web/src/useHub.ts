import { useCallback, useEffect, useReducer } from "react";
import { createApi, type UploadOptions, type UploadResult } from "./api";
import type {
	ApprovalChoice,
	BotDraft,
	FileListResponse,
	RoomInfo,
	SaveProviderBody,
	SaveProviderResponse,
	ServerEvent,
	SettingsResponse,
} from "./protocol";
import { type ClientState, clientReducer, initialState } from "./state";

// Built once; every file-panel request goes through the client so the request
// construction stays testable outside React.
const api = createApi();

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
	send: (bot: string, text: string) => void;
	interrupt: (bot: string) => void;
	respondApproval: (id: string, decision: ApprovalChoice) => void;
	setAllowAll: (on: boolean) => void;
	newSession: (bot: string) => void;
	openSession: (bot: string, id: string) => void;
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
	// A read-only directory listing for the file panel. The panel owns the
	// cache and the flags; this only forwards to the client.
	listFiles: (
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	) => Promise<FileListResponse>;
	// The download URL for one file, so a plain <a download> in the panel
	// streams it without going through fetch.
	fileDownloadUrl: (path: string) => string;
	// Uploads one file into a workspace directory and reports its progress; the
	// panel owns the per-file list and the overwrite retry.
	upload: (
		path: string,
		file: File,
		options?: UploadOptions,
	) => Promise<UploadResult>;
	// Resolves with the server's optional non-blocking warning so the dialog can
	// surface it; throws the server's error message on failure.
	saveProvider: (body: SaveProviderBody) => Promise<string | undefined>;
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

	const listFiles = useCallback(
		(path: string, options?: { showHidden?: boolean; showIgnored?: boolean }) =>
			api.listFiles(path, options),
		[],
	);

	// Pure URL construction: no request, so a plain anchor can carry it.
	const fileDownloadUrl = useCallback(
		(path: string) => api.fileDownloadUrl(path),
		[],
	);

	// Forwarded whole so the panel keeps the per-file progress callback and the
	// overwrite retry; a refusal rejects with the server's message.
	const upload = useCallback(
		(path: string, file: File, options?: UploadOptions) =>
			api.upload(path, file, options),
		[],
	);

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

	return {
		state,
		send,
		interrupt,
		respondApproval,
		setAllowAll,
		newSession,
		openSession,
		createBot,
		createRoom,
		sendToRoom,
		interruptRoom,
		loadSettings,
		openSettings,
		closeSettings,
		saveProvider,
		listFiles,
		fileDownloadUrl,
		upload,
	};
}
