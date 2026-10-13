import { describe, expect, it } from "vitest";
import type {
	ApprovalRequestInfo,
	MemoryEntryView,
	ServerEvent,
	SessionSummaryInfo,
	WorkspaceOption,
} from "../../shared/protocol";
import { WORKSPACE_BOT } from "../../shared/protocol";
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

const workspaces: WorkspaceOption[] = [
	{ root: "/tmp/ws", label: "ws", lastOpenedAt: 2, active: true },
	{ root: "/tmp/other", label: "other", lastOpenedAt: 1, active: false },
];

// The roster carries robs only; the chat is addressed by WORKSPACE_BOT and
// arrives as hello.transcript, while its bot state still rides in states.
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
			name: "writer",
			role: "drafts prose",
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
	workspaces,
	sessions: [],
	activeSessionId: "ses_1",
	transcript: [],
	approvals: [],
	allowAll: false,
};

describe("clientReducer", () => {
	it("loads a hello snapshot with the chat keyed by WORKSPACE_BOT", () => {
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
		// The chat is not a roster entry any more.
		expect(state.bots.some((bot) => bot.name === "assistant")).toBe(false);
		expect(state.workspaces).toEqual(workspaces);
		expect(state.workspaces.find((workspace) => workspace.active)?.root).toBe(
			"/tmp/ws",
		);
	});

	it("replaces the roster with robs only on a bots event", () => {
		const state = apply([
			hello,
			{
				type: "bots",
				bots: [
					...hello.bots,
					{
						name: "reader",
						role: "reads docs",
						model: "deepseek-flash",
						backend: "native",
					},
				],
				states: [
					...hello.states,
					{
						bot: "reader",
						status: "idle",
						messageCount: 0,
						pending: 0,
						lastMessage: null,
						usage: { input: 0, output: 0 },
					},
				],
			},
		]);
		expect(state.bots.map((bot) => bot.name)).toEqual(["writer", "reader"]);
		expect(state.bots.some((bot) => bot.name === "assistant")).toBe(false);
		expect(state.botStates.reader.status).toBe("idle");
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
			expiresAt: null,
		};
		const queued = apply([hello, { type: "approval_requested", request }]);
		expect(queued.approvals).toEqual([request]);
		const cleared = clientReducer(queued, {
			type: "server",
			event: { type: "approval_resolved", id: "approval-0", decision: "deny" },
		});
		expect(cleared.approvals).toEqual([]);
	});

	// The countdown is only possible if the deadline survives the event, and a
	// queued request is announced twice (no deadline, then the armed one).
	it("keeps an approval's expiresAt through the event", () => {
		const request: ApprovalRequestInfo = {
			id: "approval-0",
			bot: "planner",
			toolName: "write_file",
			subject: "a.txt",
			dangerous: false,
			rule: "a.txt",
			expiresAt: 1_800_000_000_000,
		};
		const state = apply([hello, { type: "approval_requested", request }]);
		expect(state.approvals).toEqual([request]);
		expect(state.approvals[0].expiresAt).toBe(1_800_000_000_000);
	});

	it("replaces an approval in place when its deadline is armed", () => {
		const queued: ApprovalRequestInfo = {
			id: "approval-1",
			bot: "worker",
			toolName: "write_file",
			subject: "b.txt",
			dangerous: false,
			rule: "b.txt",
			expiresAt: null,
		};
		const armed = { ...queued, expiresAt: 1_800_000_000_000 };
		const state = apply([
			hello,
			{ type: "approval_requested", request: queued },
			{ type: "approval_requested", request: armed },
		]);
		// One entry, not two: the re-emit carries the deadline for the same id.
		expect(state.approvals).toEqual([armed]);
		expect(state.approvals[0].expiresAt).toBe(1_800_000_000_000);
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

	it("keeps a bot's sessions out of the chat's list", () => {
		// The chat has sessions of its own; a bot_sessions event must fill only the
		// bot-keyed maps and leave the chat's list and active id exactly as they
		// were. This is the regression guard for the clobbering defect.
		const chatSessions: SessionSummaryInfo[] = [
			{ id: "chs_chat", updatedAt: 5, messageCount: 2, firstUserText: "hi" },
		];
		const before = apply([hello, { type: "sessions", sessions: chatSessions }]);
		const writerSessions: SessionSummaryInfo[] = [
			{ id: "chs_1", updatedAt: 2, messageCount: 1, firstUserText: "first" },
			{ id: "chs_2", updatedAt: 1, messageCount: 1, firstUserText: "second" },
		];

		const after = clientReducer(before, {
			type: "server",
			event: {
				type: "bot_sessions",
				bot: "writer",
				sessions: writerSessions,
				currentSessionId: "chs_1",
			},
		});

		expect(after.botSessions.writer).toEqual(writerSessions);
		expect(after.botActiveSession.writer).toBe("chs_1");
		expect(after.sessions).toEqual(chatSessions);
		expect(after.activeSessionId).toBe("ses_1");
	});

	it("replaces only the selected bot's transcript on session_opened", () => {
		const after = apply([
			hello,
			{
				type: "session_opened",
				bot: "writer",
				sessionId: "chs_1",
				messages: [
					{ id: 1, role: "user", text: "draft", reasoning: "", tools: [] },
				],
			},
		]);

		expect(after.transcripts.writer).toEqual([
			{ id: 1, role: "user", text: "draft", reasoning: "", tools: [] },
		]);
		// The chat's transcript is untouched by a bot's channel switch.
		expect(after.transcripts[WORKSPACE_BOT]).toEqual([]);
	});

	it("fills a bot's memory and flags a 401 as an auth error", () => {
		const entries: MemoryEntryView[] = [
			{ id: "mem_1", at: 1, kind: "fact", text: "the sky is teal" },
		];
		const loaded = clientReducer(initialState(), {
			type: "memory_loaded",
			bot: "writer",
			entries,
		});
		expect(loaded.memory.writer).toEqual(entries);
		expect(loaded.authError).toBe(false);

		const refused = clientReducer(loaded, {
			type: "auth_error",
			authError: true,
		});
		expect(refused.authError).toBe(true);
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
