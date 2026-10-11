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
			{ id: 2, role: "assistant", text: "Hello", reasoning: "", tools: [] },
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

	it("records tool_started then tool_finished on the assistant turn", () => {
		let state = tuiReducer(base(), { type: "submit", text: "read it", at: 1 });
		state = tuiReducer(state, {
			type: "agent",
			event: {
				type: "tool_started",
				id: "call_1",
				name: "read_file",
				args: { path: "a.txt" },
			},
		});
		state = tuiReducer(state, {
			type: "agent",
			event: {
				type: "tool_finished",
				id: "call_1",
				name: "read_file",
				ok: true,
				status: "ok",
				summary: "1\talpha",
				output: "1\talpha\n2\tbeta",
			},
		});

		expect(state.messages).toEqual([
			{ id: 1, role: "user", text: "read it" },
			{
				id: 2,
				role: "assistant",
				text: "",
				reasoning: "",
				tools: [
					{
						id: "call_1",
						name: "read_file",
						args: { path: "a.txt" },
						summary: "a.txt",
						status: "ok",
						output: "1\talpha\n2\tbeta",
					},
				],
			},
		]);
	});

	it("renders a tool-only turn as an assistant message with no text", () => {
		let state = tuiReducer(base(), { type: "submit", text: "go", at: 1 });
		state = tuiReducer(state, {
			type: "agent",
			event: {
				type: "tool_started",
				id: "call_1",
				name: "bash",
				args: { command: "ls" },
			},
		});
		state = tuiReducer(state, {
			type: "agent",
			event: {
				type: "tool_finished",
				id: "call_1",
				name: "bash",
				ok: true,
				status: "ok",
				summary: "",
				output: "a.txt",
			},
		});

		expect(state.messages[1]).toEqual({
			id: 2,
			role: "assistant",
			text: "",
			reasoning: "",
			tools: [
				{
					id: "call_1",
					name: "bash",
					args: { command: "ls" },
					summary: "ls",
					status: "ok",
					output: "a.txt",
				},
			],
		});
	});

	it("accumulates reasoning deltas on the assistant turn", () => {
		let state = tuiReducer(base(), { type: "submit", text: "go", at: 1 });
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "reasoning_delta", text: "pon" },
		});
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "reasoning_delta", text: "der" },
		});

		expect(state.messages[1]).toEqual({
			id: 2,
			role: "assistant",
			text: "",
			reasoning: "ponder",
			tools: [],
		});
	});

	it("keeps earlier turns referentially stable across 500 text deltas", () => {
		let state = tuiReducer(base(), { type: "submit", text: "hi", at: 1 });
		const user = state.messages[0];
		state = tuiReducer(state, {
			type: "agent",
			event: { type: "text_delta", text: "x" },
		});
		const firstAssistant = state.messages[1];

		for (let index = 1; index < 500; index += 1) {
			state = tuiReducer(state, {
				type: "agent",
				event: { type: "text_delta", text: "x" },
			});
		}

		expect(state.messages[0]).toBe(user);
		expect(state.messages[1]).not.toBe(firstAssistant);
	});

	it("toggles tool and reasoning expansion", () => {
		const start = base();
		expect(start.expandTools).toBe(false);
		expect(start.expandReasoning).toBe(false);

		const tools = tuiReducer(start, { type: "toggle_tools" });
		expect(tools.expandTools).toBe(true);
		expect(tools.expandReasoning).toBe(false);

		const both = tuiReducer(tools, { type: "toggle_reasoning" });
		expect(both.expandTools).toBe(true);
		expect(both.expandReasoning).toBe(true);

		expect(tuiReducer(both, { type: "toggle_tools" }).expandTools).toBe(false);
	});
});
