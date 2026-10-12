export interface SessionChoiceInput {
	continueFlag: boolean;
	sessionId?: string;
}

export interface SessionChoiceSummary {
	id: string;
}

export type SessionChoice =
	| { mode: "latest" }
	| { mode: "id"; id: string }
	| { mode: "new" }
	| { mode: "error"; error: string };

// Decides which stored session a resumed run targets. Pure so the CLI and TUI
// share one rule and the flag matrix is testable without touching disk.
export function chooseSession(
	input: SessionChoiceInput,
	sessions: readonly SessionChoiceSummary[],
): SessionChoice {
	const sessionId =
		input.sessionId === undefined || input.sessionId === ""
			? undefined
			: input.sessionId;

	if (input.continueFlag && sessionId !== undefined) {
		return {
			mode: "error",
			error: "Use either --continue or --session <id>, not both.",
		};
	}
	if (sessionId !== undefined) {
		if (sessions.some((session) => session.id === sessionId)) {
			return { mode: "id", id: sessionId };
		}
		return { mode: "error", error: `Unknown session: ${sessionId}` };
	}
	if (input.continueFlag) {
		return sessions.length > 0 ? { mode: "latest" } : { mode: "new" };
	}
	return { mode: "new" };
}
