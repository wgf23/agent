import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { ToolMessage } from "../../src/providers/types.js";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { waitFor } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-rob-hooks-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function bashTurn() {
	return [
		[
			{
				type: "tool_call" as const,
				id: "call_1",
				name: "bash",
				args: { command: "echo hi" },
			},
			{ type: "finish" as const, reason: "tool_calls" as const },
		],
		[
			{ type: "text_delta" as const, text: "done" },
			{ type: "finish" as const, reason: "stop" as const },
		],
	];
}

describe("rob hooks", () => {
	it("blocks a rob's bash call through a preToolUse hook", async () => {
		const hookPath = path.join(workspace, "block-bash.sh");
		await writeFile(
			hookPath,
			"#!/bin/sh\necho 'bash is disabled'\nexit 1\n",
			"utf8",
		);
		await chmod(hookPath, 0o755);

		const provider = createMockProvider(bashTurn());
		const team = new Team({
			robs: [{ name: "planner", role: "plan" }],
			defaultModel: "deepseek-flash",
			providerFactory: () => provider,
			workspaceRoot: workspace,
			authorizerFactory: () => readOnlyAuthorize,
			hooks: { preToolUse: [{ match: "bash", command: hookPath }] },
		});

		team.start();
		team.dispatch("planner", "run it");
		await waitFor(
			() =>
				provider.requests.length === 2 && team.statuses()[0].status === "idle",
			"the rob to finish",
		);
		await team.stop();

		const toolMessages = provider.requests[1].messages.filter(
			(message): message is ToolMessage => message.role === "tool",
		);
		expect(toolMessages).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: "bash is disabled",
			isError: true,
		});
	});
});
