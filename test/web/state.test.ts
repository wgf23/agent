import { describe, expect, it } from "vitest";
import type {
	AgentEvent,
	ApprovalRequestInfo,
	MemoryEntryView,
	SearchResponse,
	ServerEvent,
	SessionSummaryInfo,
	WorkspaceOption,
} from "../../shared/protocol";
import { WORKSPACE_BOT } from "../../shared/protocol";
import {
	applyAgentEvent,
	clientReducer,
	initialState,
	robBots,
	SUBAGENT_FEED_MAX,
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

	// Deleting a bot makes the server re-emit the roster without it; the reducer
	// must drop it so the App can no longer resolve the selected name.
	it("drops a deleted bot on the next bots event so it cannot stay selected", () => {
		const selected = "reader";
		const added = apply([
			hello,
			{
				type: "bots",
				bots: [
					...hello.bots,
					{
						name: selected,
						role: "reads docs",
						model: "deepseek-flash",
						backend: "native",
					},
				],
				states: hello.states,
			},
		]);
		expect(robBots(added.bots).some((bot) => bot.name === selected)).toBe(true);

		const afterDelete = clientReducer(added, {
			type: "server",
			event: { type: "bots", bots: hello.bots, states: hello.states },
		});
		expect(afterDelete.bots.some((bot) => bot.name === selected)).toBe(false);
		expect(robBots(afterDelete.bots).some((bot) => bot.name === selected)).toBe(
			false,
		);
		// The App looks the selected name up in the roster; it is gone now.
		expect(
			robBots(afterDelete.bots).find((bot) => bot.name === selected),
		).toBeUndefined();
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

	it("advances filesVersion on a files_changed event and nothing else", () => {
		const before = apply([hello]);
		expect(before.filesVersion).toBe(0);
		expect(before.filesChanged).toEqual([]);

		const written = apply([
			hello,
			{ type: "files_changed", paths: ["src/a.ts"] },
		]);
		expect(written.filesVersion).toBe(1);
		expect(written.filesChanged).toEqual(["src/a.ts"]);

		// An empty list still advances the counter: the tree refetches blindly.
		const again = clientReducer(written, {
			type: "server",
			event: { type: "files_changed", paths: [] },
		});
		expect(again.filesVersion).toBe(2);
		expect(again.filesChanged).toEqual([]);

		// Any other event leaves the counter where it was.
		const other = clientReducer(again, {
			type: "server",
			event: { type: "notice", bot: "assistant", text: "hi" },
		});
		expect(other.filesVersion).toBe(2);
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

	it("appends a bot's sub-agent entries in order under its parent", () => {
		const entry = (at: number, inner: AgentEvent): ServerEvent => ({
			type: "subagent",
			bot: "writer",
			entry: { parent: "writer", id: "writer-sub-0", at, event: inner },
		});
		const state = apply([
			hello,
			entry(1, {
				type: "tool_started",
				id: "t1",
				name: "read_file",
				args: {},
			}),
			entry(2, { type: "done", reason: "finished", steps: 1 }),
		]);

		// The order the events arrived in is the order the feed renders.
		expect(state.subagents.writer).toHaveLength(2);
		expect(state.subagents.writer[0].event.type).toBe("tool_started");
		expect(state.subagents.writer[1].event.type).toBe("done");
	});

	it("caps a bot's sub-agent feed at the newest entries", () => {
		const events: ServerEvent[] = [hello];
		for (let index = 0; index < SUBAGENT_FEED_MAX + 5; index += 1) {
			events.push({
				type: "subagent",
				bot: "writer",
				entry: {
					parent: "writer",
					id: `writer-sub-${index}`,
					at: index,
					event: { type: "text_delta", text: `line ${index}` },
				},
			});
		}
		const state = apply(events);

		expect(state.subagents.writer).toHaveLength(SUBAGENT_FEED_MAX);
		// The oldest five dropped; the newest is kept.
		expect(state.subagents.writer[0].at).toBe(5);
		expect(state.subagents.writer.at(-1)?.at).toBe(SUBAGENT_FEED_MAX + 4);
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

// A search is read-only server data with its own client-only slice; these
// tests pin the four transitions the sidebar panel reads.
describe("search", () => {
	const results: SearchResponse = {
		query: "zed",
		chat: [
			{
				sessionId: "ses_chat",
				title: null,
				firstUserText: "zed talk",
				hits: [{ role: "user", text: "zed talk", at: 1 }],
			},
		],
		bots: [
			{
				bot: "writer",
				matches: [
					{
						sessionId: "chs_1",
						title: "Zed",
						firstUserText: "zed",
						hits: [{ role: "assistant", text: "zed here", at: 2 }],
					},
				],
			},
		],
	};

	it("keeps the prior results and clears the error on search_started", () => {
		const withError = clientReducer(
			clientReducer(initialState(), { type: "search_results", results }),
			{ type: "search_failed", error: "boom" },
		);
		expect(withError.search.results).toEqual(results);
		expect(withError.search.error).toBe("boom");

		const loading = clientReducer(withError, {
			type: "search_started",
			query: "next",
		});
		expect(loading.search.results).toEqual(results);
		expect(loading.search.query).toBe("next");
		expect(loading.search.loading).toBe(true);
		expect(loading.search.error).toBeNull();
	});

	it("stores the payload and drops loading on search_results", () => {
		const started = clientReducer(initialState(), {
			type: "search_started",
			query: "zed",
		});
		expect(started.search.loading).toBe(true);

		const done = clientReducer(started, { type: "search_results", results });
		expect(done.search.results).toEqual(results);
		expect(done.search.loading).toBe(false);
	});

	it("keeps the query, drops loading, and stores the message on search_failed", () => {
		const started = clientReducer(initialState(), {
			type: "search_started",
			query: "zed",
		});
		const failed = clientReducer(started, {
			type: "search_failed",
			error: "boom",
		});
		expect(failed.search.query).toBe("zed");
		expect(failed.search.loading).toBe(false);
		expect(failed.search.error).toBe("boom");
	});

	it("resets to the default on search_cleared", () => {
		const active = clientReducer(
			clientReducer(initialState(), { type: "search_results", results }),
			{ type: "search_started", query: "zed" },
		);
		const cleared = clientReducer(active, { type: "search_cleared" });
		expect(cleared.search).toEqual({
			query: "",
			results: null,
			loading: false,
			error: null,
		});
	});

	// The panel distinguishes "not searched" (null) from "nothing found" (an
	// empty payload); the two must not collapse to the same value.
	it("tells an empty payload apart from the not-searched default", () => {
		const empty: SearchResponse = { query: "zed", chat: [], bots: [] };
		const found = clientReducer(initialState(), {
			type: "search_results",
			results: empty,
		});

		expect(initialState().search.results).toBeNull();
		expect(found.search.results).not.toBeNull();
		expect(found.search.results).not.toBe(initialState().search.results);
		expect(found.search.results).toEqual({ query: "zed", chat: [], bots: [] });
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
