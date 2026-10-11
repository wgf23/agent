import { describe, expect, it } from "vitest";
import {
	cacheHitRatio,
	initialTuiState,
	tuiReducer,
} from "../../src/tui/state.js";

function base() {
	return initialTuiState({ workspaceRoot: "/ws", model: "deepseek-flash" });
}

describe("tuiReducer", () => {
	it("accumulates text_delta into one assistant turn", () => {
		let state = tuiReducer(base(), { type: "submit", text: "hi", at: 1000 });
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "text_delta", text: "Hel" },
		});
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "text_delta", text: "lo" },
		});

		expect(state.messages).toEqual([
			{ id: 1, role: "user", text: "hi" },
			{ id: 2, role: "assistant", text: "Hello" },
		]);
		expect(state.status).toBe("streaming");
	});

	it("totals usage events", () => {
		let state = tuiReducer(base(), { type: "submit", text: "hi", at: 1000 });
		state = tuiReducer(state, {
			type: "agent",
			event: {
				type: "usage",
				inputTokens: 10,
				outputTokens: 2,
				cacheHitTokens: 3,
				cacheMissTokens: 7,
			},
		});
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "usage", inputTokens: 5, outputTokens: 1 },
		});

		expect(state.usage).toEqual({
			input: 15,
			output: 3,
			cacheHit: 3,
			cacheMiss: 7,
		});
		expect(cacheHitRatio(state.usage)).toBeCloseTo(0.3);
	});

	it("submit adds a user turn and starts the run", () => {
		const state = tuiReducer(base(), {
			type: "submit",
			text: "hello",
			at: 42,
		});

		expect(state).toEqual({
			...base(),
			messages: [{ id: 1, role: "user", text: "hello" }],
			status: "streaming",
			runStartedAt: 42,
			history: ["hello"],
			nextId: 2,
		});
	});

	it("ignores an empty submit", () => {
		const state = tuiReducer(base(), { type: "submit", text: "   ", at: 1 });
		expect(state).toEqual(base());
	});

	it("clear empties the messages", () => {
		let state = tuiReducer(base(), { type: "submit", text: "hi", at: 1 });
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "text_delta", text: "yo" },
		});
		state = tuiReducer(state, { type: "clear" });

		expect(state.messages).toEqual([]);
	});

	it("navigates the input history with up and down", () => {
		let state = tuiReducer(base(), { type: "submit", text: "first", at: 1 });
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "done", reason: "finished", steps: 1 },
		});
		state = tuiReducer(state, { type: "submit", text: "second", at: 2 });
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "done", reason: "finished", steps: 1 },
		});

		state = tuiReducer(state, { type: "history_prev" });
		expect(state.input).toBe("second");
		state = tuiReducer(state, { type: "history_prev" });
		expect(state.input).toBe("first");
		state = tuiReducer(state, { type: "history_prev" });
		expect(state.input).toBe("first");
		state = tuiReducer(state, { type: "history_next" });
		expect(state.input).toBe("second");
		state = tuiReducer(state, { type: "history_next" });
		expect(state.input).toBe("");
		expect(state.historyIndex).toBeNull();
	});
});
