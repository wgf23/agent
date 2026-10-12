import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { Team, UnknownRobError } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-team-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function makeTeam(): Team {
	return new Team({
		robs: [
			{ name: "planner", role: "plan" },
			{ name: "worker", role: "work" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: () => createMockProvider([]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
	});
}

describe("Team", () => {
	it("throws a typed error when dispatching to an unknown rob", () => {
		const team = makeTeam();

		expect(() => team.dispatch("ghost", "hi")).toThrow(UnknownRobError);
		expect(() => team.dispatch("ghost", "hi")).toThrow("Unknown rob: ghost");
	});

	it("returns a DM snapshot that cannot mutate the log", () => {
		const team = makeTeam();
		team.postDm("planner", "worker", "secret");

		const snapshot = team.readDms();
		expect(snapshot).toEqual([
			{ from: "planner", to: "worker", text: "secret", at: expect.any(Number) },
		]);

		snapshot[0].text = "tampered";
		expect(team.readDms()[0].text).toBe("secret");
	});

	it("reports a status snapshot per rob", () => {
		const team = makeTeam();

		expect(team.statuses()).toEqual([
			{
				name: "planner",
				status: "idle",
				messageCount: 0,
				pending: 0,
				lastMessage: null,
				usage: { input: 0, output: 0 },
			},
			{
				name: "worker",
				status: "idle",
				messageCount: 0,
				pending: 0,
				lastMessage: null,
				usage: { input: 0, output: 0 },
			},
		]);
	});

	it("sums token usage per rob from the event stream", async () => {
		const provider = createMockProvider([
			[
				{ type: "usage", inputTokens: 12, outputTokens: 7 },
				{ type: "usage", inputTokens: 3, outputTokens: 5 },
				{ type: "finish", reason: "stop" },
			],
		]);
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
		});
		team.start();

		team.dispatch("planner", "go");
		await waitFor(() => {
			const status = team.statuses()[0];
			return status.status === "idle" && status.pending === 0;
		}, "the planner to finish");

		expect(team.statuses()[0].usage).toEqual({ input: 15, output: 12 });
		await team.stop();
	});
});
