import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Provider } from "../../src/providers/types.js";
import { SoloHub } from "../../src/serve/solo.js";
import { latestSession, newSession } from "../../src/session/store.js";
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
