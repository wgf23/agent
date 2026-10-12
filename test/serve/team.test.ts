import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../../shared/protocol.js";
import type { ProviderSettings } from "../../src/config/resolve.js";
import type { Provider } from "../../src/providers/types.js";
import { TeamHub } from "../../src/serve/team.js";

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

function createHub(provider: Provider): TeamHub {
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
		expect(hello.mode).toBe("team");
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
});
