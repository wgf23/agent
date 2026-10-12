import { useCallback, useEffect, useReducer } from "react";
import type { ApprovalChoice, ServerEvent } from "./protocol";
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

	return {
		state,
		send,
		interrupt,
		respondApproval,
		setAllowAll,
		newSession,
		openSession,
	};
}
