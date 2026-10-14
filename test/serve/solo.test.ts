import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { SoloHub } from "../../src/serve/solo.js";
import {
	latestSession,
	newSession,
	saveSession,
} from "../../src/session/store.js";
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
		path.join(tmpdir(), "my-agent-web-sessions-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-web-ws-"));
});

function hubOptions(provider: Provider) {
	return {
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
		allowAll: createAllowAll(),
	};
}

function collect(hub: SoloHub): ServerEvent[] {
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

describe("SoloHub", () => {
	it("streams a turn and persists the session", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "Hello" },
				{ type: "text_delta", text: " world" },
			],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "hi");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "bot_status" &&
						event.state.status === "idle" &&
						event.state.messageCount > 1,
				),
			"turn to finish",
		);

		const text = events
			.filter((event) => event.type === "agent_event")
			.map((event) => event.event)
			.filter((event) => event.type === "text_delta")
			.map((event) => event.text)
			.join("");
		expect(text).toBe("Hello world");
		expect(
			events.some(
				(event) => event.type === "agent_event" && event.event.type === "done",
			),
		).toBe(true);

		const saved = await latestSession(workspaceRoot);
		expect(saved?.id).toBe(session.id);
		expect(
			saved?.messages.some((message) => message.role === "assistant"),
		).toBe(true);
	});

	it("announces the file a chat write wrote so the tree can refresh", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call-1",
					name: "write_file",
					args: { path: "notes/hello.txt", content: "hi" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(
			{ ...hubOptions(provider), allowAll: createAllowAll(true) },
			{ session, sessions: [] },
		);
		const events = collect(hub);

		hub.dispatch("assistant", "write a note");
		await waitFor(
			() => events.some((event) => event.type === "files_changed"),
			"files_changed for the write",
		);

		expect(events).toContainEqual({
			type: "files_changed",
			paths: ["notes/hello.txt"],
		});
		await hub.dispose();
	});

	it("queues a message sent mid-turn and injects it next step", async () => {
		const provider = createMockProvider([
			[{ type: "text_delta", text: "first" }],
			[{ type: "text_delta", text: "second" }],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "one");
		hub.dispatch("assistant", "two");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "bot_status" &&
						event.state.status === "idle" &&
						event.state.messageCount >= 3,
				),
			"both messages to be handled",
			5000,
		);

		// Both messages were queued before the first step boundary, so they
		// reach the provider in the same request rather than being dropped.
		const firstRequest = provider.requests[0];
		const userTexts = firstRequest.messages
			.filter((message) => message.role === "user")
			.map((message) => message.content);
		expect(userTexts).toEqual(["one", "two"]);
	});

	it("keeps an attachment on the turn and on a queued interjection", async () => {
		const provider = createMockProvider([
			[{ type: "text_delta", text: "first" }],
			[{ type: "text_delta", text: "second" }],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });

		hub.dispatch("assistant", "one", [
			{ type: "image", mediaType: "image/png", data: "QQ==" },
		]);
		// The second message lands mid-turn, so it is queued with its own
		// image rather than losing it.
		hub.dispatch("assistant", "two", [
			{ type: "image", mediaType: "image/webp", data: "Qg==" },
		]);
		await waitFor(
			() =>
				hub.hello().states[0]?.status === "idle" &&
				hub.hello().states[0].messageCount >= 3,
			"both messages to be handled",
			5000,
		);

		// Both reach the same request: the queued one is injected at the step
		// boundary, and its image rides with it.
		const users = provider.requests[0]?.messages.filter(
			(message) => message.role === "user",
		);
		expect(users).toEqual([
			{
				role: "user",
				content: "one",
				images: [{ type: "image", mediaType: "image/png", data: "QQ==" }],
			},
			{
				role: "user",
				content: "two",
				images: [{ type: "image", mediaType: "image/webp", data: "Qg==" }],
			},
		]);
		await hub.dispose();
	});

	it("refuses a bad attachment with an error event, not a turn", async () => {
		const provider = createMockProvider([[{ type: "text_delta", text: "ok" }]]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "hi", [
			{ type: "image", mediaType: "image/bmp", data: "QkE=" },
		]);
		expect(events).toContainEqual({
			type: "error",
			bot: "assistant",
			message: expect.stringContaining("image/bmp"),
		});
		expect(provider.requests).toEqual([]);
		await hub.dispose();
	});

	it("creates a new session and reopens a saved one", async () => {
		const provider = createMockProvider([
			[{ type: "text_delta", text: "hello" }],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "remember me");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "bot_status" &&
						event.state.status === "idle" &&
						event.state.messageCount >= 2,
				),
			"turn to finish",
		);

		await hub.newSession("assistant");
		expect(hub.hello().activeSessionId).not.toBe(session.id);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "session_opened", messages: [] }),
		);

		await hub.openSession("assistant", session.id);
		const opened = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(opened).toMatchObject({ sessionId: session.id });
		const messages = opened?.type === "session_opened" ? opened.messages : [];
		expect(messages.some((message) => message.role === "user")).toBe(true);
		await hub.dispose();
	});

	it("asks for approval and blocks the tool on deny", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call-1",
					name: "bash",
					args: { command: "echo hi" },
				},
			],
			[{ type: "text_delta", text: "ok" }],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "run it");
		await waitFor(
			() => events.some((event) => event.type === "approval_requested"),
			"approval request",
		);

		const requested = events.find(
			(event) => event.type === "approval_requested",
		);
		expect(requested).toMatchObject({
			request: { bot: "assistant", toolName: "bash", subject: "echo hi" },
		});
		const id =
			requested?.type === "approval_requested" ? requested.request.id : "";
		hub.resolveApproval(id, "deny");

		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "agent_event" &&
						event.event.type === "tool_finished" &&
						event.event.status === "blocked",
				),
			"tool to be blocked",
		);
		expect(
			events.some(
				(event) =>
					event.type === "approval_resolved" && event.decision === "deny",
			),
		).toBe(true);
	});

	it("deletes a stored session and adopts the newest remaining or a fresh one", async () => {
		const provider = createMockProvider([]);
		const first = newSession(workspaceRoot, settings.model);
		first.messages = [{ role: "user", content: "first" }];
		first.updatedAt = 1000;
		const second = newSession(workspaceRoot, settings.model);
		second.messages = [{ role: "user", content: "second" }];
		second.updatedAt = 2000;
		await saveSession(first);
		await saveSession(second);
		const hub = new SoloHub(hubOptions(provider), {
			session: second,
			sessions: [],
		});
		const events = collect(hub);

		// Deleting the live session adopts the newest remaining one, and the
		// emitted session_opened names something other than what was deleted.
		expect(await hub.deleteSession("assistant", second.id)).toBe(true);
		expect(hub.hello().activeSessionId).toBe(first.id);
		const adopted = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		expect(adopted).toMatchObject({ sessionId: first.id });
		const adoptedId =
			adopted?.type === "session_opened" ? adopted.sessionId : "";
		expect(adoptedId).not.toBe(second.id);

		// Deleting the last one starts a fresh session.
		expect(await hub.deleteSession("assistant", first.id)).toBe(true);
		const fresh = events
			.filter((event) => event.type === "session_opened")
			.at(-1);
		const freshId = fresh?.type === "session_opened" ? fresh.sessionId : "";
		expect(freshId).not.toBe(first.id);
		expect(hub.hello().activeSessionId).toBe(freshId);
		expect(hub.hello().sessions).toEqual([]);

		// An unknown id is reported, not accepted.
		expect(await hub.deleteSession("assistant", "ses_missing")).toBe(false);
		await hub.dispose();
	});

	it("renames a stored session and carries the trimmed title in the list", async () => {
		const provider = createMockProvider([]);
		const session = newSession(workspaceRoot, settings.model);
		session.messages = [{ role: "user", content: "hello" }];
		await saveSession(session);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		expect(await hub.renameSession("assistant", session.id, "Greeting")).toBe(
			true,
		);
		const sessionsEvent = events
			.filter((event) => event.type === "sessions")
			.at(-1);
		const listed =
			sessionsEvent?.type === "sessions" ? sessionsEvent.sessions : [];
		expect(listed).toEqual([
			expect.objectContaining({ id: session.id, title: "Greeting" }),
		]);

		expect(await hub.renameSession("assistant", "ses_missing", "x")).toBe(
			false,
		);
		await hub.dispose();
	});

	it("searches the chat's stored sessions and reports a hit's role", async () => {
		const provider = createMockProvider([]);
		const match = newSession(workspaceRoot, settings.model);
		match.messages = [{ role: "user", content: "the needle is here" }];
		await saveSession(match);
		const miss = newSession(workspaceRoot, settings.model);
		miss.messages = [{ role: "user", content: "nothing to see" }];
		await saveSession(miss);
		const hub = new SoloHub(hubOptions(provider), {
			session: newSession(workspaceRoot, settings.model),
			sessions: [],
		});

		// The query is matched case-insensitively and echoed into the snippet.
		const found = await hub.search("NEEDLE", workspaceRoot);
		expect(found).toEqual([
			{
				sessionId: match.id,
				title: null,
				firstUserText: "the needle is here",
				hits: [
					{ role: "user", text: "the needle is here", at: match.updatedAt },
				],
			},
		]);
		// The "nothing found" case is an empty list, not every session.
		expect(await hub.search("absent", workspaceRoot)).toEqual([]);
		await hub.dispose();
	});
});

describe("SoloHub interrupt", () => {
	it("aborts the turn and returns to idle", async () => {
		const provider: Provider = {
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
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(hubOptions(provider), { session, sessions: [] });
		const events = collect(hub);

		hub.dispatch("assistant", "go");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "agent_event" && event.event.type === "text_delta",
				),
			"stream to start",
		);
		hub.interrupt("assistant");
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "agent_event" &&
						event.event.type === "done" &&
						event.event.reason === "aborted",
				),
			"aborted done",
		);
		await waitFor(
			() =>
				events.some(
					(event) =>
						event.type === "bot_status" && event.state.status === "idle",
				),
			"idle after abort",
		);
		await hub.dispose();
	});
});
