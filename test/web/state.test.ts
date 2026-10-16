import { describe, expect, it } from "vitest";
import type {
	AgentEvent,
	RoomInfo,
	SearchResponse,
	ServerEvent,
} from "../../shared/protocol";
import {
	applyAgentEvent,
	clientReducer,
	initialState,
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
	rooms: [],
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

	it("appends a bot's sub-agent entries in order under its parent", () => {
		const entry = (at: number, inner: AgentEvent): ServerEvent => ({
			type: "subagent",
			bot: "alpha",
			entry: { parent: "alpha", id: "alpha-sub-0", at, event: inner },
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
		expect(state.subagents.alpha).toHaveLength(2);
		expect(state.subagents.alpha[0].event.type).toBe("tool_started");
		expect(state.subagents.alpha[1].event.type).toBe("done");
	});

	it("caps a bot's sub-agent feed at the newest entries", () => {
		const events: ServerEvent[] = [hello];
		for (let index = 0; index < SUBAGENT_FEED_MAX + 5; index += 1) {
			events.push({
				type: "subagent",
				bot: "alpha",
				entry: {
					parent: "alpha",
					id: `alpha-sub-${index}`,
					at: index,
					event: { type: "text_delta", text: `line ${index}` },
				},
			});
		}
		const state = apply(events);

		expect(state.subagents.alpha).toHaveLength(SUBAGENT_FEED_MAX);
		// The oldest five dropped; the newest is kept.
		expect(state.subagents.alpha[0].at).toBe(5);
		expect(state.subagents.alpha.at(-1)?.at).toBe(SUBAGENT_FEED_MAX + 4);
	});
});

const shipIt: RoomInfo = {
	name: "ship-it",
	members: ["alpha", "beta"],
	coordinator: null,
	transcript: [
		{ id: 1, at: 1_700_000_000_000, kind: "user", text: "status?" },
		{
			id: 2,
			at: 1_700_000_001_000,
			kind: "member",
			from: "alpha",
			text: "on it",
		},
	],
	run: { phase: "idle" },
	pending: 0,
	deliverable: null,
	limits: {
		minMembers: 2,
		maxMembers: 6,
		maxRounds: 3,
		maxMessagesPerRun: 10,
		maxQueuedSends: 5,
	},
};

describe("rooms", () => {
	it("seeds hello rooms and folds every room event into them", () => {
		const running = {
			phase: "running" as const,
			round: 2,
			rounds: 3,
			current: "beta",
			posted: 1,
			remaining: 9,
			addressed: ["alpha"],
		};
		const state = apply([
			{ ...hello, rooms: [shipIt] },
			{
				type: "room",
				event: {
					kind: "entry",
					room: "ship-it",
					entry: { id: 3, at: 1_700_000_002_000, kind: "user", text: "again" },
				},
			},
			{ type: "room", event: { kind: "run", room: "ship-it", run: running } },
			{
				type: "room",
				event: {
					kind: "turn",
					room: "ship-it",
					member: "alpha",
					round: 1,
					state: "replied",
				},
			},
			{
				type: "room",
				event: {
					kind: "members",
					room: "ship-it",
					members: ["alpha", "beta", "gamma"],
				},
			},
			{
				type: "room",
				event: {
					kind: "run_ended",
					room: "ship-it",
					run: running,
					outcome: "settled",
				},
			},
		]);
		expect(state.rooms["ship-it"].members).toEqual(["alpha", "beta", "gamma"]);
		expect(
			state.rooms["ship-it"].transcript.map((entry) => entry.text),
		).toEqual(["status?", "on it", "again"]);
		expect(state.rooms["ship-it"].run).toEqual({ phase: "idle" });
		expect(state.rooms["ship-it"].lastOutcome).toBe("settled");
	});

	it("seeds a room's coordinator and last deliverable", () => {
		const state = apply([
			{
				...hello,
				rooms: [
					{
						...shipIt,
						coordinator: "alpha",
						deliverable: {
							at: 1_700_000_003_000,
							path: "docs/deliverables/20261015T143012-ship-it.md",
							coordinator: "alpha",
						},
					},
				],
			},
		]);

		expect(state.rooms["ship-it"].coordinator).toBe("alpha");
		expect(state.rooms["ship-it"].deliverable).toEqual({
			at: 1_700_000_003_000,
			path: "docs/deliverables/20261015T143012-ship-it.md",
			coordinator: "alpha",
		});
	});

	it("keeps the last 100 entries of a room, like the DM feed", () => {
		const entries: ServerEvent[] = Array.from({ length: 101 }, (_, index) => ({
			type: "room",
			event: {
				kind: "entry",
				room: "other-tab",
				entry: {
					id: index + 10,
					at: index + 10,
					kind: "user",
					text: `line ${index + 1}`,
				},
			},
		}));
		const state = apply([hello, ...entries]);
		const transcript = state.rooms["other-tab"].transcript;
		expect(transcript).toHaveLength(100);
		expect(transcript[0].text).toBe("line 2");
		expect(transcript.at(-1)?.text).toBe("line 101");
	});

	it("creates a room named by an event hello never sent", () => {
		const state = apply([
			{ ...hello, rooms: [shipIt] },
			{
				type: "room",
				event: {
					kind: "members",
					room: "side-room",
					members: ["alpha", "beta"],
				},
			},
		]);
		expect(state.rooms["side-room"].members).toEqual(["alpha", "beta"]);
		expect(state.rooms["side-room"].run).toEqual({ phase: "idle" });
		expect(state.rooms["ship-it"].members).toEqual(["alpha", "beta"]);
	});

	it("seeds a created room from the create response without dropping live entries", () => {
		const fresh: RoomInfo = { ...shipIt, transcript: [] };
		const seeded = clientReducer(initialState(), {
			type: "room_created",
			room: fresh,
		});
		expect(seeded.rooms["ship-it"].members).toEqual(["alpha", "beta"]);

		const live = clientReducer(seeded, {
			type: "server",
			event: {
				type: "room",
				event: {
					kind: "entry",
					room: "ship-it",
					entry: { id: 1, at: 1, kind: "user", text: "first line" },
				},
			},
		});
		const late = clientReducer(live, { type: "room_created", room: fresh });
		expect(late.rooms["ship-it"].transcript.map((entry) => entry.text)).toEqual(
			["first line"],
		);
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

describe("request failures", () => {
	it("puts a refused send's reason on the error banner", () => {
		const state = clientReducer(initialState(), {
			type: "request_error",
			error: 'Unsupported image type "image/bmp": allowed types are ...',
		});
		expect(state.lastError).toBe(
			'Unsupported image type "image/bmp": allowed types are ...',
		);
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
		rooms: [
			{
				room: "ship-it",
				matches: [
					{
						sessionId: "ship-it",
						title: "ship-it",
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
		const empty: SearchResponse = { query: "zed", chat: [], rooms: [] };
		const found = clientReducer(initialState(), {
			type: "search_results",
			results: empty,
		});

		expect(initialState().search.results).toBeNull();
		expect(found.search.results).not.toBeNull();
		expect(found.search.results).not.toBe(initialState().search.results);
		expect(found.search.results).toEqual({ query: "zed", chat: [], rooms: [] });
	});
});
