import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { MemoryEntry, Turn } from "../../src/bot/schema.js";
import { createBotStore } from "../../src/bot/store.js";
import { manualTimer, type Timer } from "../../src/bot/wake.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import {
	summarizeSessions,
	TeamHub,
	UnknownMemoryEntryError,
} from "../../src/serve/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";

const settings: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-team-sessions-"),
	);
	process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-web-team-bots-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-web-team-ws-"));
});

function slowProvider(): Provider {
	return {
		id: "slow",
		async *stream(request) {
			yield { type: "text_delta", text: "working" };
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) return resolve();
				request.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
		},
	};
}

function createHub(provider: Provider, timer?: Timer): TeamHub {
	return new TeamHub({
		workspaceRoot,
		provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		robs: [{ name: "alpha", role: "a test rob" }],
		providerEnv: {},
		allowAll: createAllowAll(),
		timer,
	});
}

function collect(hub: TeamHub): ServerEvent[] {
	const events: ServerEvent[] = [];
	hub.subscribe((event) => events.push(event));
	return events;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 4000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const statusIs = (events: ServerEvent[], status: string) => () =>
	events.some(
		(event) => event.type === "bot_status" && event.state.status === status,
	);

describe("TeamHub", () => {
	it("lists configured robs in the hello snapshot", async () => {
		const hub = createHub(slowProvider());
		const hello = hub.hello();
		expect(hello.bots).toEqual([
			{
				name: "alpha",
				role: "a test rob",
				model: "deepseek-flash",
				backend: "native",
			},
		]);
		expect(hello.sessions).toEqual([]);
		await hub.dispose();
	});

	it("puts the queue's deadline on the approval it emits", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "bash",
					args: { command: "echo hi" },
				},
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		hub.dispatch("alpha", "go");
		await waitFor(
			() => events.some((event) => event.type === "approval_requested"),
			"the approval request",
		);

		const requested = events.find(
			(event) => event.type === "approval_requested",
		);
		expect(requested).toMatchObject({
			type: "approval_requested",
			request: { bot: "alpha", toolName: "bash" },
		});
		const expiresAt =
			requested?.type === "approval_requested"
				? requested.request.expiresAt
				: 0;
		// The queue armed a window on this request, so the client has a real
		// deadline to count down rather than an invented one.
		expect(typeof expiresAt).toBe("number");
		expect(expiresAt as number).toBeGreaterThan(Date.now());

		hub.resolveApproval(
			requested?.type === "approval_requested" ? requested.request.id : "",
			"deny",
		);
		await waitFor(
			() => events.some((event) => event.type === "approval_resolved"),
			"the approval to resolve",
		);
		await hub.dispose();
	});

	it("refuses a bad attachment with an error event, not a turn", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		hub.dispatch("alpha", "hi", [
			{ type: "image", mediaType: "image/bmp", data: "QkE=" },
		]);
		expect(events).toContainEqual({
			type: "error",
			bot: "alpha",
			message: expect.stringContaining("image/bmp"),
		});
		// Nothing reached the provider: the cap is enforced before the turn.
		expect(provider.requests).toEqual([]);
		await hub.dispose();
	});

	it("reports an unknown bot instead of throwing", async () => {
		const hub = createHub(slowProvider());
		const events = collect(hub);
		hub.dispatch("ghost", "hi");
		expect(events).toContainEqual({
			type: "error",
			bot: "ghost",
			message: "Unknown bot: ghost",
		});
		await hub.dispose();
	});

	it("interrupts a running turn and returns the rob to idle", async () => {
		const hub = createHub(slowProvider());
		const events = collect(hub);

		hub.dispatch("alpha", "hi");
		await waitFor(statusIs(events, "working"), "working status");

		hub.interrupt("alpha");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "agent_event" &&
						event.bot === "alpha" &&
						event.event.type === "done" &&
						event.event.reason === "aborted",
				),
			"aborted done",
		);
		await waitFor(statusIs(events, "idle"), "idle after interrupt");

		// The rob survived: a second dispatch still runs.
		hub.dispatch("alpha", "again");
		await waitFor(statusIs(events, "working"), "working after re-dispatch");
		hub.interrupt("alpha");
		await hub.dispose();
	});

	it("opens a bot session, replays a stored one, and reports an unknown id", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "one" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		await hub.newSession("alpha");
		const opened = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(opened).toMatchObject({ bot: "alpha", messages: [] });
		const sessionId = opened?.type === "session_opened" ? opened.sessionId : "";

		hub.dispatch("alpha", "first");
		await waitFor(
			() => provider.requests.length === 1 && hub.states()[0].status === "idle",
			"the first turn",
		);

		await hub.openSession("alpha", "nope");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "error",
				bot: "alpha",
				message: expect.stringContaining("nope"),
			}),
		);

		await hub.openSession("alpha", sessionId);
		const replayed = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(replayed).toMatchObject({ bot: "alpha", sessionId });
		const messages =
			replayed?.type === "session_opened" ? replayed.messages : [];
		expect(
			messages.some(
				(message) => message.role === "user" && message.text.includes("first"),
			),
		).toBe(true);

		await hub.closeSession("alpha", sessionId);
		const sessionsEvent = events
			.filter((event) => event.type === "bot_sessions")
			.at(-1);
		expect(sessionsEvent).toMatchObject({
			type: "bot_sessions",
			bot: "alpha",
			sessions: [
				{
					id: sessionId,
					messageCount: 2,
					firstUserText: "[from user] first",
				},
			],
		});
		// A bot's list is its own event: the chat's `sessions` must not fire here.
		expect(events.some((event) => event.type === "sessions")).toBe(false);
		await hub.dispose();
	});

	it("summarizes a bot's sessions newest first with the right message count", () => {
		const turns = [
			{
				id: "trn_0000000000000000000000000000000a",
				seq: 1,
				sessionId: "chs_a",
				workspaceRoot,
				at: 10,
				wake: "user",
				messages: [
					{ role: "user", content: "hi a" },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
				],
			},
			{
				id: "trn_0000000000000000000000000000000b",
				seq: 2,
				sessionId: "chs_b",
				workspaceRoot,
				at: 20,
				wake: "user",
				messages: [
					{ role: "user", content: "hi b" },
					{ role: "assistant", content: [{ type: "text", text: "yo" }] },
					{ role: "user", content: "more b" },
				],
			},
			{
				id: "trn_0000000000000000000000000000000c",
				seq: 3,
				sessionId: "chs_a",
				workspaceRoot,
				at: 30,
				wake: "user",
				messages: [
					{ role: "user", content: "again a" },
					{ role: "assistant", content: [{ type: "text", text: "sure" }] },
				],
			},
		] satisfies Turn[];

		expect(summarizeSessions(turns)).toEqual([
			{ id: "chs_a", updatedAt: 30, messageCount: 4, firstUserText: "hi a" },
			{ id: "chs_b", updatedAt: 20, messageCount: 3, firstUserText: "hi b" },
		]);
	});

	it("reads the current transcript without clearing the rob's live history", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "hello there" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		hub.dispatch("alpha", "first");
		await waitFor(
			() => provider.requests.length === 1 && hub.states()[0].status === "idle",
			"the first turn",
		);
		const before = hub.states()[0].messageCount;

		const first = await hub.readTranscript("alpha");
		const second = await hub.readTranscript("alpha");
		expect(first).not.toBeNull();
		expect(second).toEqual(first);
		expect(
			first?.messages.some(
				(message) => message.role === "user" && message.text.includes("first"),
			),
		).toBe(true);
		expect(
			first?.messages.some(
				(message) =>
					message.role === "assistant" && message.text === "hello there",
			),
		).toBe(true);
		// The read is a replay; the rob's live transcript is untouched.
		expect(hub.states()[0].messageCount).toBe(before);
		expect(await hub.readTranscript("ghost")).toBeNull();
		await hub.dispose();
	});

	it("lists a bot's memory and forgets an entry by id", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: "a test rob",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000001",
			at: 1,
			kind: "fact",
			text: "the sky is teal",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(
			loaded.record,
			{
				id: "trn_00000000000000000000000000000001",
				seq: 1,
				sessionId: "chs_seed",
				workspaceRoot,
				at: 1,
				wake: "user",
				messages: [],
			},
			{ upsert: [fact], drop: [] },
		);
		if (!seeded.ok) throw new Error(seeded.error);

		const hub = createHub(slowProvider());
		expect(await hub.readMemory("alpha")).toEqual({
			bot: "alpha",
			entries: [{ id: fact.id, at: 1, kind: "fact", text: "the sky is teal" }],
		});
		expect(await hub.readMemory("ghost")).toBeNull();

		await expect(hub.forgetMemory("ghost", fact.id)).resolves.toBe(false);
		await hub.forgetMemory("alpha", fact.id);
		expect((await hub.readMemory("alpha"))?.entries).toEqual([]);
		const record = readFileSync(
			path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json"),
			"utf8",
		);
		expect(record).not.toContain(fact.id);
		await hub.dispose();
	});

	it("refuses to forget a memory id the record does not have", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: "a test rob",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000001",
			at: 1,
			kind: "fact",
			text: "the sky is teal",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(
			loaded.record,
			{
				id: "trn_00000000000000000000000000000001",
				seq: 1,
				sessionId: "chs_seed",
				workspaceRoot,
				at: 1,
				wake: "user",
				messages: [],
			},
			{ upsert: [fact], drop: [] },
		);
		if (!seeded.ok) throw new Error(seeded.error);
		const ledger = path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json");
		const before = readFileSync(ledger, "utf8");

		const hub = createHub(slowProvider());
		await expect(hub.forgetMemory("alpha", "mem_missing")).rejects.toThrow(
			UnknownMemoryEntryError,
		);
		// The failed forget wrote nothing.
		expect(readFileSync(ledger, "utf8")).toBe(before);
		// A real id still forgets.
		await hub.forgetMemory("alpha", fact.id);
		expect((await hub.readMemory("alpha"))?.entries).toEqual([]);
		await hub.dispose();
	});

	it("sets and clears a bot's wake and re-arms the live timer", async () => {
		writeFileSync(
			projectFilePath(workspaceRoot),
			`${JSON.stringify(
				{ robs: [{ name: "alpha", role: "a test rob" }] },
				null,
				2,
			)}\n`,
		);
		const manual = manualTimer();
		const hub = createHub(slowProvider(), manual.timer);

		await expect(hub.setWake("ghost", null)).resolves.toBe(false);

		await hub.setWake("alpha", { everyMs: 60000, prompt: "tick" });
		expect(hub.bots()[0].wake).toEqual({ everyMs: 60000, prompt: "tick" });
		expect(manual.pending()).toEqual([
			{ bot: "alpha", everyMs: 60000, text: "tick" },
		]);
		const saving = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(saving.robs[0].wake).toEqual({ everyMs: 60000, prompt: "tick" });

		await hub.setWake("alpha", null);
		expect(hub.bots()[0].wake).toBeUndefined();
		expect(manual.pending()).toEqual([]);
		const cleared = JSON.parse(
			readFileSync(projectFilePath(workspaceRoot), "utf8"),
		);
		expect(cleared.robs[0].wake).toBeUndefined();
		await hub.dispose();
	});

	it("denies a pending approval when its bot is removed", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "bash",
					args: { command: "echo hi" },
				},
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = createHub(provider);
		const events = collect(hub);

		hub.dispatch("alpha", "go");
		await waitFor(
			() => events.some((event) => event.type === "approval_requested"),
			"the approval request",
		);
		const requested = events.find(
			(event) => event.type === "approval_requested",
		);
		expect(hub.states().find((state) => state.bot === "alpha")?.status).toBe(
			"waiting_approval",
		);

		expect(await hub.removeBot("alpha")).toBe(true);

		// The pending approval resolved denied rather than hanging, and the rob
		// reported the literal stopped status on its way out.
		expect(events).toContainEqual({
			type: "approval_resolved",
			id: requested?.type === "approval_requested" ? requested.request.id : "",
			decision: "deny",
		});
		expect(events).toContainEqual({
			type: "bot_status",
			state: expect.objectContaining({ bot: "alpha", status: "stopped" }),
		});
		expect(hub.bots()).toEqual([]);
		expect(hub.states().some((state) => state.bot === "alpha")).toBe(false);

		// A later dispatch to the removed name reports the literal unknown bot.
		hub.dispatch("alpha", "again");
		expect(events).toContainEqual({
			type: "error",
			bot: "alpha",
			message: "Unknown bot: alpha",
		});
		await hub.dispose();
	});

	it("deletes a removed bot's ledger", async () => {
		const store = createBotStore();
		const loaded = await store.load("alpha", {
			role: "a test rob",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		await store.commit(loaded.record, {
			id: "trn_00000000000000000000000000000001",
			seq: 1,
			sessionId: "chs_seed",
			workspaceRoot,
			at: 1,
			wake: "user",
			messages: [],
		});
		const ledger = path.join(process.env.MY_AGENT_BOTS_DIR ?? "", "alpha.json");
		expect(existsSync(ledger)).toBe(true);

		const hub = createHub(slowProvider());
		expect(await hub.removeBot("ghost")).toBe(false);
		expect(await hub.removeBot("alpha")).toBe(true);
		expect(existsSync(ledger)).toBe(false);
		await hub.dispose();
	});

	it("replaces a bot's role and model and keeps its wake", async () => {
		writeFileSync(
			projectFilePath(workspaceRoot),
			`${JSON.stringify(
				{
					robs: [
						{
							name: "alpha",
							role: "a test rob",
							wake: { everyMs: 60000, prompt: "tick" },
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const manual = manualTimer();
		const hub = createHub(slowProvider(), manual.timer);

		const updated = hub.replaceBot("alpha", {
			name: "alpha",
			role: "the edited rob",
			model: "deepseek-chat",
			wake: { everyMs: 60000, prompt: "tick" },
		});

		expect(updated).toEqual({
			name: "alpha",
			role: "the edited rob",
			model: "deepseek-chat",
			backend: "native",
			wake: { everyMs: 60000, prompt: "tick" },
		});
		expect(hub.hello().bots[0]).toMatchObject({
			name: "alpha",
			role: "the edited rob",
			model: "deepseek-chat",
		});
		expect(hub.hello().bots[0].wake).toEqual({
			everyMs: 60000,
			prompt: "tick",
		});
		expect(() => hub.replaceBot("ghost", { name: "ghost", role: "x" })).toThrow(
			"Unknown rob: ghost",
		);
		await hub.dispose();
	});
});
