import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { ChannelRegistry } from "../../src/bot/channel.js";
import { renderMemory } from "../../src/bot/record.js";
import type { MemoryEntry, Turn } from "../../src/bot/schema.js";
import { type BotStore, createBotStore } from "../../src/bot/store.js";
import type { Provider, ToolMessage } from "../../src/providers/types.js";
import { Rob } from "../../src/rob/rob.js";
import { Team } from "../../src/rob/team.js";
import type { RobName } from "../../src/rob/types.js";
import type { Tool } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, FakeTeam, waitFor } from "./helpers.js";

let workspace: string;
let botsDir: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-");
	botsDir = await mkdtemp(path.join(tmpdir(), "my-agent-rob-bots-"));
});

afterEach(async () => {
	await removeWorkspace(workspace);
	await rm(botsDir, { recursive: true, force: true });
});

function memoryStore(): BotStore {
	return createBotStore({ MY_AGENT_BOTS_DIR: botsDir });
}

async function loadBot(name: string) {
	const loaded = await memoryStore().load(name, {
		role: "work",
		model: "deepseek-flash",
	});
	if (!loaded.ok) throw new Error(loaded.error);
	return loaded.record;
}

describe("Rob", () => {
	it("replies to a dispatched user message and keeps history across runs", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "first reply" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "second reply" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "coordinate the team" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: memoryStore(),
		});
		team.start();

		team.dispatch("planner", "hello");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"first reply",
		);

		team.dispatch("planner", "again");
		await waitFor(
			() =>
				provider.requests.length === 2 && team.statuses()[0].status === "idle",
			"second reply",
		);
		await team.stop();

		const status = team.statuses()[0];
		expect(status.name).toBe("planner");
		expect(status.status).toBe("stopped");
		expect(status.messageCount).toBe(4);
		expect(status.lastMessage).toBe("second reply");

		const first = provider.requests[0].messages;
		expect(first[0].role).toBe("system");
		expect(first[0].content).toContain('You are rob "planner"');
		expect(first[0].content).toContain("coordinate the team");
		expect(first).toContainEqual({
			role: "user",
			content: "[from user] hello",
		});

		// The second request carries the first run's history.
		expect(provider.requests[1].messages).toContainEqual({
			role: "assistant",
			content: [{ type: "text", text: "first reply" }],
		});
		expect(provider.requests[1].messages).toContainEqual({
			role: "user",
			content: "[from user] again",
		});
	});

	it("records exactly one turn carrying only that turn's messages", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "only reply" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "coordinate the team" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: memoryStore(),
		});
		team.start();

		team.dispatch("planner", "hello");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the reply",
		);
		await team.stop();

		const record = await loadBot("planner");
		expect(record.turns).toHaveLength(1);
		const [turn] = record.turns;
		expect(turn.sessionId).toMatch(/^chs_[0-9a-f]{16}$/);
		expect(turn.workspaceRoot).toBe(workspace);
		expect(turn.wake).toBe("user");
		expect(turn.seq).toBe(1);
		// The turn carries only the user prompt and the reply, not the system
		// prompt or anything replayed from earlier turns.
		expect(turn.messages).toEqual([
			{ role: "user", content: "[from user] hello" },
			{ role: "assistant", content: [{ type: "text", text: "only reply" }] },
		]);
	});

	it("reaches the model with memory remembered on an earlier turn", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "remember",
					args: { text: "the sky is teal" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "noted" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "still teal" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({
			kind: "user",
			from: "user",
			text: "remember the sky",
			at: 0,
		});
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the first turn",
		);
		rob.deliver({ kind: "user", from: "user", text: "what color", at: 0 });
		await waitFor(() => provider.requests.length === 3, "the second turn");
		rob.stop();
		await running;

		const system = provider.requests[2].messages[0];
		expect(system.role).toBe("system");
		expect(system.content).toContain("the sky is teal");

		const record = await loadBot("planner");
		expect(record.memory).toHaveLength(1);
		expect(record.memory[0].text).toBe("the sky is teal");
		expect(record.memory[0].source).toEqual({
			sessionId: record.turns[0].sessionId,
			turnSeq: 1,
		});
	});

	it("sees a seeded fact and never writes memory into the transcript", async () => {
		const store = memoryStore();
		const loaded = await store.load("planner", {
			role: "work",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const seedTurn: Turn = {
			id: "trn_00000000000000000000000000000001",
			seq: 1,
			sessionId: "chs_seed",
			workspaceRoot: workspace,
			at: 1,
			wake: "user",
			messages: [],
		};
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000001",
			at: 1,
			kind: "fact",
			text: "the password is hunter2",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(loaded.record, seedTurn, {
			upsert: [fact],
			drop: [],
		});
		expect(seeded.ok).toBe(true);

		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store,
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({
			kind: "user",
			from: "user",
			text: "what is the password",
			at: 0,
		});
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		// A fresh Rob's first system prompt carries the seeded fact.
		expect(provider.requests[0].messages[0].content).toContain(
			"the password is hunter2",
		);

		const record = await loadBot("planner");
		const turn = record.turns.find((entry) => entry.seq === 2);
		if (turn === undefined) throw new Error("the rob's turn was not committed");
		expect(JSON.stringify(turn.messages)).not.toContain(
			"the password is hunter2",
		);
	});

	it("forgets a remembered entry so it leaves renderMemory", async () => {
		const store = memoryStore();
		const loaded = await store.load("planner", {
			role: "work",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const fact: MemoryEntry = {
			id: "mem_0000000000000000000000000000000a",
			at: 1,
			kind: "fact",
			text: "the vault code is 1234",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(
			loaded.record,
			{
				id: "trn_0000000000000000000000000000000a",
				seq: 1,
				sessionId: "chs_seed",
				workspaceRoot: workspace,
				at: 1,
				wake: "user",
				messages: [],
			},
			{ upsert: [fact], drop: [] },
		);
		if (!seeded.ok) throw new Error(seeded.error);
		expect(renderMemory(seeded.record.memory)).toContain(
			"the vault code is 1234",
		);

		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "forget",
					args: { id: fact.id },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "forgotten" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store,
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "forget the code", at: 0 });
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		const record = await loadBot("planner");
		expect(record.memory).toEqual([]);
		expect(renderMemory(record.memory)).not.toContain("the vault code is 1234");
	});

	it("commits the turn and notices when the backend throws", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "hi" },
				{ type: "finish", reason: "stop" },
			],
		]);

		class FailingTeam extends FakeTeam {
			readonly notices: string[] = [];
			override emitRobEvent(): void {
				throw new Error("event sink failed");
			}
			override emitNotice(_rob: RobName, text: string): void {
				this.notices.push(text);
			}
		}

		const team = new FailingTeam();
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team,
			store: memoryStore(),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(() => team.notices.length > 0, "the failure notice");
		rob.stop();
		await running;

		expect(team.notices.join("\n")).toContain("event sink failed");
		const record = await loadBot("planner");
		expect(record.turns).toHaveLength(1);
		expect(record.turns[0].messages).toEqual([]);
	});

	it("adds a delegate sub-agent's usage to the rob's totals", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "delegate",
					args: { task: "count the files" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "usage", inputTokens: 5, outputTokens: 3 },
				{ type: "text_delta", text: "sub answer" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "usage", inputTokens: 10, outputTokens: 4 },
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			store: memoryStore(),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		expect(rob.statusSnapshot().usage).toEqual({ input: 15, output: 7 });
	});

	it("aborts an in-flight run when stop is called", async () => {
		const provider: Provider = {
			id: "slow",
			async *stream(request) {
				yield { type: "text_delta", text: "working" };
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) {
						resolve();
						return;
					}
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			},
		};
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			team: new FakeTeam(),
			store: memoryStore(),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "long task", at: 0 });
		await waitFor(
			() => rob.readEvents().some((event) => event.type === "text_delta"),
			"the provider to yield before the abort",
		);

		rob.stop();
		await running;

		expect(rob.statusSnapshot().status).toBe("stopped");
		expect(rob.readEvents()).toContainEqual({
			type: "done",
			reason: "aborted",
			steps: 1,
		});
	});

	it("advertises and runs an injected extra tool beside send_message and delegate", async () => {
		const extra: Tool = {
			name: "mcp__memory__create_entity",
			description: "create an entity",
			readOnly: false,
			parameters: { type: "object", properties: { name: { type: "string" } } },
			execute: async () => ({ ok: true, output: "created Ada" }),
		};
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "mcp__memory__create_entity",
					args: { name: "Ada" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "work",
			rules: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam(),
			extraTools: [extra],
			store: memoryStore(),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "user", from: "user", text: "go", at: 0 });
		await waitFor(
			() =>
				rob
					.readEvents()
					.some(
						(event) => event.type === "done" && event.reason === "finished",
					),
			"the rob to finish",
		);
		rob.stop();
		await running;

		const names = provider.requests[0].tools.map((tool) => tool.name);
		expect(names).toContain("mcp__memory__create_entity");
		expect(names).toContain("send_message");
		expect(names).toContain("delegate");
		expect(names).toContain("remember");
		expect(names).toContain("forget");

		const toolMessages = provider.requests[1].messages.filter(
			(message): message is ToolMessage => message.role === "tool",
		);
		expect(toolMessages).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "created Ada",
			isError: false,
		});
	});

	it("destroys a session without touching memory or the next transcript", async () => {
		const store = memoryStore();
		const loaded = await store.load("planner", {
			role: "work",
			model: "deepseek-flash",
		});
		if (!loaded.ok) throw new Error(loaded.error);
		const seedTurn: Turn = {
			id: "trn_00000000000000000000000000000002",
			seq: 1,
			sessionId: "chs_seed",
			workspaceRoot: workspace,
			at: 1,
			wake: "user",
			messages: [],
		};
		const fact: MemoryEntry = {
			id: "mem_00000000000000000000000000000002",
			at: 1,
			kind: "fact",
			text: "the password is hunter2",
			source: { sessionId: null, turnSeq: 0 },
			supersedes: [],
		};
		const seeded = await store.commit(loaded.record, seedTurn, {
			upsert: [fact],
			drop: [],
		});
		expect(seeded.ok).toBe(true);

		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "reply one" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "reply two" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "work" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store,
		});
		team.start();

		team.dispatch("planner", "hello A");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the first session's turn",
		);
		team.openChannel("planner");
		team.dispatch("planner", "hello B");
		await waitFor(
			() =>
				provider.requests.length === 2 && team.statuses()[0].status === "idle",
			"the second session's turn",
		);
		await team.stop();

		const record = await loadBot("planner");
		const turns = record.turns.filter((turn) => turn.sessionId !== "chs_seed");
		expect(turns).toHaveLength(2);
		expect(turns[0].sessionId).not.toBe(turns[1].sessionId);

		// The destroyed session cannot leak into the next transcript, but the
		// bot's memory still reaches the model.
		const second = provider.requests[1].messages;
		expect(JSON.stringify(second)).not.toContain("reply one");
		expect(JSON.stringify(second)).toContain("hello B");
		expect(second[0].content).toContain("the password is hunter2");
	});

	it("replays an opened session's literal history into the next turn", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "reply one" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "reply two" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "reply three" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "work" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			store: memoryStore(),
		});
		team.start();

		team.dispatch("planner", "hello A");
		await waitFor(
			() =>
				provider.requests.length === 1 && team.statuses()[0].status === "idle",
			"the first session's turn",
		);
		const a = team.listChannels("planner")[0].id;
		team.openChannel("planner");
		team.dispatch("planner", "hello B");
		await waitFor(
			() =>
				provider.requests.length === 2 && team.statuses()[0].status === "idle",
			"the second session's turn",
		);

		const opened = await team.loadChannel("planner", a);
		expect(opened).toEqual({
			ok: true,
			messages: [
				{ role: "user", content: "[from user] hello A" },
				{ role: "assistant", content: [{ type: "text", text: "reply one" }] },
			],
		});

		team.dispatch("planner", "again A");
		await waitFor(
			() =>
				provider.requests.length === 3 && team.statuses()[0].status === "idle",
			"the replayed session's turn",
		);
		await team.stop();

		const replayed = JSON.stringify(provider.requests[2].messages);
		expect(replayed).toContain("hello A");
		expect(replayed).toContain("reply one");
		expect(replayed).toContain("again A");

		// The reopened turn continues the same session id.
		const record = await loadBot("planner");
		expect(record.turns.filter((turn) => turn.sessionId === a)).toHaveLength(2);
	});
});
