import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { createSubagentRunner } from "../../src/agent/subagent.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-subagent-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("createSubagentRunner", () => {
	it("returns the sub-agent's streamed text and inherits thinking", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "sub " },
				{ type: "text_delta", text: "answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const run = createSubagentRunner({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			authorize: async () => ({ allowed: true }),
			thinking: "disabled",
			reasoningEffort: "none",
		});

		expect(await run("do it")).toBe("sub answer");
		expect(provider.requests[0].thinking).toBe("disabled");
		expect(provider.requests[0].reasoningEffort).toBe("none");
		expect(provider.requests[0].messages[1]).toEqual({
			role: "user",
			content: "do it",
		});
	});

	it("offers the sub-agent's usage to onEvent", async () => {
		const provider = createMockProvider([
			[
				{ type: "usage", inputTokens: 7, outputTokens: 3 },
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const events: AgentEvent[] = [];
		const run = createSubagentRunner({
			provider,
			model: "deepseek-flash",
			workspaceRoot: workspace,
			authorize: async () => ({ allowed: true }),
			onEvent: (event) => events.push(event),
		});

		expect(await run("count it")).toBe("done");
		expect(events.filter((event) => event.type === "usage")).toEqual([
			{ type: "usage", inputTokens: 7, outputTokens: 3 },
		]);
	});
});
