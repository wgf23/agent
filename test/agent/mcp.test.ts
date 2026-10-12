import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { connectMcpServers } from "../../src/mcp/manager.js";
import type { ToolMessage } from "../../src/providers/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { FAKE_MCP_SERVER } from "../mcp/helpers.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeAll(async () => {
	workspace = await makeWorkspace("my-agent-mcp-agent-");
});

afterAll(async () => {
	await removeWorkspace(workspace);
});

describe("runAgent with MCP tools", () => {
	it("executes a namespaced MCP tool and feeds the result back", async () => {
		const mcp = await connectMcpServers({
			servers: {
				memory: { command: [process.execPath, FAKE_MCP_SERVER] },
			},
			workspaceRoot: workspace,
			timeoutMs: 2000,
		});
		try {
			const provider = createMockProvider([
				[
					{
						type: "tool_call",
						id: "call_1",
						name: "mcp__memory__create_entity",
						args: { name: "Ada" },
					},
					{ type: "finish", reason: "tool_calls" },
				],
				[
					{ type: "text_delta", text: "created" },
					{ type: "finish", reason: "stop" },
				],
			]);
			const events: AgentEvent[] = [];

			const result = await runAgent({
				provider,
				model: "deepseek-flash",
				workspaceRoot: workspace,
				prompt: "create Ada",
				extraTools: mcp.tools,
				onEvent: (event) => events.push(event),
			});

			expect(result.reason).toBe("finished");
			expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
				"mcp__memory__create_entity",
			);
			const toolMessages = provider.requests[1].messages.filter(
				(message): message is ToolMessage => message.role === "tool",
			);
			expect(toolMessages).toContainEqual({
				role: "tool",
				toolCallId: "call_1",
				content: 'create_entity:{"name":"Ada"}\nok',
				isError: false,
			});
			expect(events).toContainEqual({
				type: "tool_finished",
				id: "call_1",
				name: "mcp__memory__create_entity",
				ok: true,
				status: "ok",
				summary: 'create_entity:{"name":"Ada"}',
				output: 'create_entity:{"name":"Ada"}\nok',
			});
		} finally {
			await mcp.dispose();
		}
	});
});
