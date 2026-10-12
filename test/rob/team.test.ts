import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { Team, UnknownRobError } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

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
			},
			{
				name: "worker",
				status: "idle",
				messageCount: 0,
				pending: 0,
				lastMessage: null,
			},
		]);
	});
});
