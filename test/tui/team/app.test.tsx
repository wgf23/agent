import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizer } from "../../../src/permissions/authorizer.js";
import type { StreamEvent } from "../../../src/providers/types.js";
import { Team } from "../../../src/rob/team.js";
import { TeamApp, type TeamController } from "../../../src/tui/team/App.js";
import {
	createMockProvider,
	type MockProvider,
} from "../../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../../tools/helpers.js";

const robs = [{ name: "planner" }, { name: "worker" }];

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-team-tui-");
});

afterEach(async () => {
	cleanup();
	await removeWorkspace(workspace);
});

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			assertion();
			return;
		} catch (error) {
			if (Date.now() - start > timeoutMs) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

function makeTeam(providers: Record<string, MockProvider>): Team {
	return new Team({
		robs: robs.map((rob) => ({ ...rob, role: rob.name })),
		defaultModel: "deepseek-flash",
		providerFactory: (rob) => providers[rob.name],
		workspaceRoot: workspace,
		authorizerFactory: (rob) =>
			createAuthorizer({
				workspaceRoot: workspace,
				rules: rob.rules,
				approval: rob.approval,
				yesAll: false,
			}),
	});
}

function renderTeam(team: TeamController) {
	return render(<TeamApp team={team} robs={robs} model="deepseek-flash" />);
}

describe("TeamApp", () => {
	it("dispatches @planner and shows the reply in its transcript", async () => {
		const providers = {
			planner: createMockProvider([
				[
					{ type: "text_delta", text: "planning" },
					{ type: "finish", reason: "stop" },
				],
			]),
			worker: createMockProvider([[]]),
		};
		const { stdin, lastFrame } = renderTeam(makeTeam(providers));
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("@planner hello");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("you → planner: hello"));
		await waitFor(() => expect(lastFrame()).toContain("planning"));

		expect(providers.planner.requests).toHaveLength(1);
		expect(providers.planner.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "[from user] hello",
		});
	});

	it("cycles the selected rob with tab", async () => {
		const providers = {
			planner: createMockProvider([]),
			worker: createMockProvider([]),
		};
		const { stdin, lastFrame } = renderTeam(makeTeam(providers));
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("\t");

		await waitFor(() => expect(lastFrame()).toContain("> worker"));
		expect(lastFrame()).not.toContain("> planner");
	});

	it("shows DMs after ctrl+d", async () => {
		const providers = {
			planner: createMockProvider([]),
			worker: createMockProvider([]),
		};
		const team = makeTeam(providers);
		const { stdin, lastFrame } = renderTeam(team);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		team.postDm("planner", "worker", "secret plan");
		stdin.write("\u0004");

		await waitFor(() =>
			expect(lastFrame()).toContain("planner → worker: secret plan"),
		);
	});

	it("shows the FIFO head, blocks typing, and advances after y", async () => {
		const writeTurn = (path: string): StreamEvent[] => [
			{
				type: "tool_call",
				id: "call_1",
				name: "write_file",
				args: { path, content: "x" },
			},
			{ type: "finish", reason: "tool_calls" },
		];
		const done = (text: string): StreamEvent[] => [
			{ type: "text_delta", text },
			{ type: "finish", reason: "stop" },
		];
		const providers = {
			planner: createMockProvider([
				writeTurn("a.txt"),
				done("planner wrote it"),
			]),
			worker: createMockProvider([writeTurn("b.txt"), done("worker wrote it")]),
		};
		const team = makeTeam(providers);
		const { stdin, lastFrame } = renderTeam(team);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("@planner write a.txt");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("planner wants to"));
		expect(lastFrame()).toContain("write_file");
		expect(lastFrame()).toContain("a.txt");
		await tick();

		stdin.write("zzz");
		expect(lastFrame()).not.toContain("zzz");

		team.dispatch("worker", "write b.txt");
		await waitFor(() => expect(lastFrame()).toContain("(1 more waiting)"));

		stdin.write("y");
		await waitFor(() => expect(lastFrame()).toContain("worker wants to"));
		expect(lastFrame()).toContain("b.txt");
		expect(lastFrame()).not.toContain("planner wants to");

		stdin.write("y");
		await waitFor(() => expect(lastFrame()).toContain("planner wrote it"));
	});

	it("does not accept input or write to the team in read-only views", async () => {
		const calls: string[] = [];
		const team: TeamController = {
			subscribe: () => () => {},
			start: () => {},
			stop: async () => {},
			dispatch: (name, text) => {
				calls.push(`dispatch ${name} ${text}`);
			},
			interject: (name, text) => {
				calls.push(`interject ${name} ${text}`);
			},
			resolveApproval: (id) => {
				calls.push(`resolve ${id}`);
			},
		};
		const { stdin, lastFrame } = renderTeam(team);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("\u0004");
		await waitFor(() => expect(lastFrame()).toContain("Direct messages"));
		stdin.write("hello there");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lastFrame()).not.toContain("hello there");
		expect(calls).toEqual([]);

		stdin.write("\u001b");
		await waitFor(() => expect(lastFrame()).not.toContain("Direct messages"));

		stdin.write("\u0013");
		await waitFor(() => expect(lastFrame()).toContain("Sub-agents"));
		stdin.write("hello there");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lastFrame()).not.toContain("hello there");
		expect(calls).toEqual([]);
	});
});
