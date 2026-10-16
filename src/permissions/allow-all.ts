// One runtime allow-all scope per run. The authorizer reads it on every call,
// so a change takes effect immediately, and it never touches my-agent.json.
// A scope is either off, "all" (every session), or "session" (only the session
// id it was set with).
import type { AllowAllMode, AllowAllState } from "../../shared/protocol.js";

export interface AllowAll {
	// The TUI surface: is any allow-all active right now.
	get(): boolean;
	state(): AllowAllState;
	// The TUI toggle maps true to "all" and false to "off".
	set(on: boolean): void;
	// The web sets the scope, naming the session for "session".
	setMode(mode: AllowAllMode, sessionId: string | null): void;
	// Whether a turn for this session is auto-approved.
	allows(sessionId: string | null): boolean;
	subscribe(listener: (state: AllowAllState) => void): () => void;
}

export function createAllowAll(
	initial: boolean | AllowAllMode = false,
): AllowAll {
	let state: AllowAllState =
		typeof initial === "boolean"
			? { mode: initial ? "all" : "off", sessionId: null }
			: { mode: initial, sessionId: null };
	const listeners = new Set<(state: AllowAllState) => void>();

	const commit = (next: AllowAllState) => {
		if (next.mode === state.mode && next.sessionId === state.sessionId) return;
		state = next;
		for (const listener of listeners) listener(state);
	};

	return {
		get: () => state.mode !== "off",
		state: () => state,
		set: (on) => commit({ mode: on ? "all" : "off", sessionId: null }),
		setMode: (mode, sessionId) =>
			commit({ mode, sessionId: mode === "session" ? sessionId : null }),
		allows: (sessionId) =>
			state.mode === "all" ||
			(state.mode === "session" &&
				sessionId !== null &&
				sessionId === state.sessionId),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

// null means the argument is neither "on", "off", nor empty. Empty toggles.
export function parseAllowAllArg(
	allowAll: AllowAll,
	arg: string,
): boolean | null {
	if (arg === "on") return true;
	if (arg === "off") return false;
	if (arg === "") return !allowAll.get();
	return null;
}
