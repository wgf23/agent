import { describe, expect, it } from "vitest";
import { renderTeamPreamble } from "../../src/rob/roster.js";
import { createTeamOperations, teamTools } from "../../src/rob/tools.js";
import { FakeTeam } from "./helpers.js";

function tools(): ReturnType<typeof teamTools> {
	const team = new FakeTeam([{ name: "worker", role: "work" }]);
	const operations = createTeamOperations({
		team,
		from: "planner",
		runSubagent: async () => "",
	});
	return teamTools(operations);
}

describe("renderTeamPreamble", () => {
	it("names the rob, its role, its teammates and its team tools", () => {
		const preamble = renderTeamPreamble({
			rob: "planner",
			role: "coordinate the team",
			roster: [
				{ name: "worker", role: "write the code" },
				{ name: "docs", role: "write the docs" },
			],
			tools: tools(),
		});

		expect(preamble).toContain(
			'You are rob "planner", one member of a team of robs.',
		);
		expect(preamble).toContain("Your role: coordinate the team");
		expect(preamble).toContain('"worker": write the code');
		expect(preamble).toContain('"docs": write the docs');
		expect(preamble).toContain(
			"send_message: Send a private message to another rob on the team. Only that rob can read it.",
		);
		expect(preamble).toContain(
			"delegate: Delegate one self-contained task to a sub-agent and return its final answer. Sub-agents cannot delegate further.",
		);
		expect(preamble).toContain(
			"send_message is fire-and-forget: the message is delivered when the teammate next runs, and their reply arrives later as a message from them.",
		);
	});

	it("says there is nobody to message when the rob is alone", () => {
		const preamble = renderTeamPreamble({
			rob: "solo",
			role: "work",
			roster: [],
			tools: tools(),
		});

		expect(preamble).toContain(
			"You are the only rob: there is no teammate to message.",
		);
		expect(preamble).not.toContain("Your teammates:");
	});
});
