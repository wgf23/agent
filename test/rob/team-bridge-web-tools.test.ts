// The host-side web tools mount on the turn bridge (docs/design/web-tools.md
// D1). createBridge is the one tool list all four backends consume, so pinning
// it here catches a future edit that drops web_fetch/web_search from the team
// surface before any backend notices.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { Team } from "../../src/rob/team.js";
import { webTools } from "../../src/tools/web.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-team-web-tools-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function makeTeam(): Team {
	return new Team({
		robs: [
			{ name: "planner", role: "plan" },
			{ name: "builder", role: "build" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: () => createMockProvider([]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
	});
}

describe("web tools on the turn bridge", () => {
	it("a DM turn carries web_fetch and web_search alongside the team tools", async () => {
		const team = makeTeam();
		team.start();
		try {
			const bridge = await team.beginTurn("planner", {
				signal: new AbortController().signal,
				workspaceRoot: workspace,
				authorize: async () => ({ allowed: true }),
				runSubagent: async () => "answer",
			});
			const names = bridge.tools.map((tool) => tool.name);
			expect(names).toContain("send_message");
			expect(names).toContain("delegate");
			expect(names).toContain("web_fetch");
			expect(names).toContain("web_search");
		} finally {
			await team.stop();
		}
	});

	it("mounts the host-side implementation, not a hand-rolled stub", () => {
		// The same factory the bridge calls builds tools that expose the typed
		// `run` entry point the gateway invoke path uses.
		const [webFetch] = webTools({ skipEgressProbe: true });
		expect(webFetch.name).toBe("web_fetch");
		expect(typeof webFetch.run).toBe("function");
		expect(webFetch.readOnly).toBe(false);
	});
});
