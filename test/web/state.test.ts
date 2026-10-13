import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol";
import {
	applyAgentEvent,
	clientReducer,
	initialState,
} from "../../web/src/state";

// The reducer is the whole SSE-to-UI mapping, so these tests call it the way
// useHub does and assert the transcript a user would see.
function apply(events: ServerEvent[]) {
	return events.reduce(
		(state, event) => clientReducer(state, { type: "server", event }),
		initialState(),
	);
}

const hello: ServerEvent = {
	type: "hello",
	workspaceRoot: "/tmp/ws",
	model: "deepseek-flash",
	provider: {
		configured: true,
		preset: "deepseek",
		model: "deepseek-flash",
		baseURL: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		apiKeySource: "credentials",
	},
	bots: [
		{
			name: "assistant",
			kind: "workspace",
			role: "agent",
			model: "deepseek-flash",
			backend: "native",
		},
	],
	states: [
		{
			bot: "assistant",
			status: "idle",
			messageCount: 0,
			pending: 0,
			lastMessage: null,
			usage: { input: 0, output: 0 },
		},
	],
	sessions: [],
	activeSessionId: "ses_1",
	transcript: [],
	approvals: [],
	allowAll: false,
};

describe("clientReducer", () => {
	it("loads a hello snapshot into the workspace bot transcript", () => {
		const state = apply([
			{
				...hello,
				transcript: [
					{ id: 1, role: "user", text: "hi", reasoning: "", tools: [] },
					{ id: 2, role: "assistant", text: "hello", reasoning: "", tools: [] },
				],
			},
		]);
		expect(state.connection).toBe("open");
		expect(state.botStates.assistant.status).toBe("idle");
		expect(state.transcripts.assistant).toHaveLength(2);
		expect(state.provider?.configured).toBe(true);
	});

	it("applies a bots event and keeps the workspace and robs split", () => {
		const state = apply([
			hello,
			{
				type: "bots",
				bots: [
					...hello.bots,
					{
						name: "writer",
						kind: "rob",
						role: "drafts prose",
						model: "deepseek-flash",
						backend: "native",
					},
				],
				states: [
					...hello.states,
					{
						bot: "writer",
						status: "idle",
						messageCount: 0,
						pending: 0,
						lastMessage: null,
						usage: { input: 0, output: 0 },
					},
				],
			},
		]);
		expect(state.bots.map((bot) => `${bot.kind}:${bot.name}`)).toEqual([
			"workspace:assistant",
			"rob:writer",
		]);
		expect(state.botStates.writer.status).toBe("idle");
	});

	it("accumulates streaming text and tool calls onto one assistant message", () => {
		const state = apply([
			hello,
			{
				type: "agent_event",
				bot: "assistant",
				event: { type: "text_delta", text: "Hel" },
			},
			{
				type: "agent_event",
				bot: "assistant",
				event: { type: "text_delta", text: "lo" },
			},
			{
				type: "agent_event",
				bot: "assistant",
				event: {
					type: "tool_started",
					id: "t1",
					name: "bash",
					args: { command: "ls" },
				},
			},
			{
				type: "agent_event",
				bot: "assistant",
				event: {
					type: "tool_finished",
					id: "t1",
					name: "bash",
					ok: true,
					status: "ok",
					summary: "ls",
					output: "file.txt",
				},
			},
		]);
		const transcript = state.transcripts.assistant;
		expect(transcript).toHaveLength(1);
		expect(transcript[0].text).toBe("Hello");
		expect(transcript[0].tools).toEqual([
			expect.objectContaining({
				id: "t1",
				status: "ok",
				output: "file.txt",
				summary: "ls",
			}),
		]);
	});

	it("records usage and returns the bot to idle on done", () => {
		const state = apply([
			hello,
			{
				type: "agent_event",
				bot: "assistant",
				event: {
					type: "usage",
					inputTokens: 10,
					outputTokens: 5,
					cacheHitTokens: 2,
					cacheMissTokens: 0,
				},
			},
			{
				type: "agent_event",
				bot: "assistant",
				event: { type: "done", reason: "finished", steps: 1 },
			},
		]);
		expect(state.usage).toEqual({ input: 10, output: 5 });
		expect(state.botStates.assistant.status).toBe("idle");
	});

	it("queues and clears approvals", () => {
		const request = {
			id: "approval-0",
			bot: "assistant",
			toolName: "bash",
			subject: "rm -rf /",
			dangerous: true,
			rule: null,
		};
		const queued = apply([hello, { type: "approval_requested", request }]);
		expect(queued.approvals).toEqual([request]);
		const cleared = clientReducer(queued, {
			type: "server",
			event: { type: "approval_resolved", id: "approval-0", decision: "deny" },
		});
		expect(cleared.approvals).toEqual([]);
	});

	it("appends DMs and notices to their feeds", () => {
		const state = apply([
			hello,
			{ type: "dm", entry: { from: "alpha", to: "beta", text: "ping", at: 1 } },
			{
				type: "notice",
				bot: "assistant",
				text: "allow-all: auto-approved dangerous bash rm",
			},
		]);
		expect(state.dms).toEqual([
			{ from: "alpha", to: "beta", text: "ping", at: 1 },
		]);
		expect(state.notices).toHaveLength(1);
		expect(state.transcripts.assistant.at(-1)).toMatchObject({
			role: "system",
		});
	});
});

describe("applyAgentEvent", () => {
	it("creates an assistant message for the first delta", () => {
		const transcript = applyAgentEvent([], { type: "text_delta", text: "x" });
		expect(transcript).toEqual([
			{ id: 1, role: "assistant", text: "x", reasoning: "", tools: [] },
		]);
	});

	it("folds a compacted notice into the transcript", () => {
		const transcript = applyAgentEvent([], {
			type: "compacted",
			removedMessages: 3,
			summaryChars: 10,
		});
		expect(transcript[0]).toMatchObject({
			role: "system",
			text: "compacted 3 messages",
		});
	});
});
