import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { buildServer } from "../../src/serve/server.js";
import { SoloHub } from "../../src/serve/solo.js";
import { newSession } from "../../src/session/store.js";
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
		path.join(tmpdir(), "my-agent-web-http-sessions-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-web-http-ws-"));
});

describe("web server over SSE", () => {
	it("sends hello, streams a turn, and answers a send", async () => {
		const provider = createMockProvider([
			[{ type: "text_delta", text: "pong" }],
		]);
		const session = newSession(workspaceRoot, settings.model);
		const hub = new SoloHub(
			{
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
			},
			{ session, sessions: [] },
		);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const ac = new AbortController();
		const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
			signal: ac.signal,
		});
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const events = readEvents(response, ac.signal);

		const hello = await events.next((event) => event.type === "hello");
		expect(hello).toMatchObject({ mode: "solo", activeSessionId: session.id });

		const sent = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bot: "assistant", text: "ping" }),
		});
		expect(sent.status).toBe(200);

		const delta = await events.next(
			(event) =>
				event.type === "agent_event" &&
				event.event.type === "text_delta" &&
				event.event.text === "pong",
		);
		expect(delta.type).toBe("agent_event");
		await events.next(
			(event) => event.type === "agent_event" && event.event.type === "done",
		);

		ac.abort();
		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});

// Reads the SSE body, framing on blank lines, and resolves the first event that
// matches. Buffers across reads so a chunk boundary never splits an event.
function readEvents(response: Response, signal: AbortSignal) {
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("no response body");
	const decoder = new TextDecoder();
	let buffer = "";

	const pump = async (
		predicate: (event: ServerEvent) => boolean,
	): Promise<ServerEvent> => {
		while (true) {
			const frameEnd = buffer.indexOf("\n\n");
			if (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const dataLine = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (dataLine !== undefined) {
					const event = JSON.parse(dataLine.slice(6)) as ServerEvent;
					if (predicate(event)) return event;
					continue;
				}
				continue;
			}
			if (signal.aborted) throw new Error("stream aborted");
			const { value, done } = await reader.read();
			if (done) throw new Error("stream ended before the expected event");
			buffer += decoder.decode(value, { stream: true });
		}
	};

	return { next: pump };
}
