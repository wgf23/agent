import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider } from "../../src/providers/types.js";
import { Rob } from "../../src/rob/rob.js";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { FakeTeam, waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

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
			permissions: {},
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			team: new FakeTeam(),
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
});
