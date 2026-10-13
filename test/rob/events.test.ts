import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { TeamEvent } from "../../src/rob/events.js";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-events-");
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
		providerFactory: () =>
			createMockProvider([
				[
					{ type: "text_delta", text: "hello" },
					{ type: "finish", reason: "stop" },
				],
			]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
	});
}

describe("Team events", () => {
	it("delivers rob_event and rob_status for a dispatch", async () => {
		const team = makeTeam();
		const events: TeamEvent[] = [];
		team.subscribe((event) => events.push(event));
		team.start();

		team.dispatch("planner", "hi");
		await waitFor(
			() => team.statuses()[0].status === "idle" && events.length > 0,
			"the planner to finish",
		);
		await team.stop();

		expect(events).toContainEqual({
			kind: "rob_status",
			rob: "planner",
			status: "working",
		});
		expect(events).toContainEqual({
			kind: "rob_event",
			rob: "planner",
			event: { type: "text_delta", text: "hello" },
		});
		expect(events).toContainEqual({
			kind: "rob_status",
			rob: "planner",
			status: "idle",
		});
	});

	it("delivers a dm event when a rob posts a DM", () => {
		const team = makeTeam();
		const events: TeamEvent[] = [];
		team.subscribe((event) => events.push(event));

		team.postDm("planner", "worker", "secret");

		expect(events).toEqual([
			{
				kind: "dm",
				entry: {
					from: "planner",
					to: "worker",
					text: "secret",
					at: expect.any(Number),
				},
			},
		]);
	});

	it("stops delivering after unsubscribe", () => {
		const team = makeTeam();
		const events: TeamEvent[] = [];
		const unsubscribe = team.subscribe((event) => events.push(event));

		team.postDm("planner", "worker", "one");
		unsubscribe();
		team.postDm("planner", "worker", "two");

		expect(events).toEqual([
			{
				kind: "dm",
				entry: {
					from: "planner",
					to: "worker",
					text: "one",
					at: expect.any(Number),
				},
			},
		]);
	});

	it("hands the listener a copy that cannot mutate team state", () => {
		const team = makeTeam();
		const events: TeamEvent[] = [];
		team.subscribe((event) => events.push(event));

		team.postDm("planner", "worker", "secret");
		const first = events[0];
		if (first.kind === "dm") first.entry.text = "tampered";

		expect(team.readDms()[0].text).toBe("secret");
	});
});
