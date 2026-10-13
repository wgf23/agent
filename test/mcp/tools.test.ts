import { describe, expect, it, vi } from "vitest";
import type { McpClient } from "../../src/mcp/client.js";
import {
	mapServerTools,
	mcpToolName,
	parseToolList,
} from "../../src/mcp/tools.js";
import { executeTool } from "../../src/tools/registry.js";

function stubClient(callTool: McpClient["callTool"]): McpClient {
	return {
		initialize: async () => {},
		listTools: async () => ({}),
		callTool,
		dispose: async () => {},
	};
}

describe("mcpToolName", () => {
	it("namespaces with the server and tool, sanitizing both parts", () => {
		expect(mcpToolName("memory", "create_entities")).toBe(
			"mcp__memory__create_entities",
		);
		expect(mcpToolName("my server", "weird.name")).toBe(
			"mcp__my_server__weird_name",
		);
	});
});

describe("mapServerTools", () => {
	it("maps readOnly from annotations.readOnlyHint, defaulting to false", () => {
		const infos = parseToolList({
			tools: [
				{
					name: "a",
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: true },
				},
				{ name: "b", inputSchema: { type: "object" } },
			],
		});
		const { tools } = mapServerTools({
			server: "s",
			client: stubClient(async () => ({})),
			infos,
			existingNames: new Set(),
		});

		expect(tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
			["mcp__s__a", true],
			["mcp__s__b", false],
		]);
	});

	it("reports a collision with an existing name and drops the server", () => {
		const infos = parseToolList({ tools: [{ name: "a" }] });
		const result = mapServerTools({
			server: "s",
			client: stubClient(async () => ({})),
			infos,
			existingNames: new Set(["mcp__s__a"]),
		});

		expect(result).toEqual({
			tools: [],
			error: "tool name collision: mcp__s__a",
		});
	});

	it("joins text parts with newlines and maps isError to ok false", async () => {
		const infos = parseToolList({
			tools: [{ name: "read", description: "d" }],
		});
		const ok = mapServerTools({
			server: "s",
			client: stubClient(async () => ({
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
				isError: false,
			})),
			infos,
			existingNames: new Set(),
		});
		const ctx = { workspaceRoot: process.cwd() };

		expect(await executeTool(ok.tools[0], { x: 1 }, ctx)).toEqual({
			ok: true,
			output: "first\nsecond",
		});

		const failed = mapServerTools({
			server: "s",
			client: stubClient(async () => ({
				content: [{ type: "text", text: "boom" }],
				isError: true,
			})),
			infos,
			existingNames: new Set(),
		});

		expect(await executeTool(failed.tools[0], {}, ctx)).toEqual({
			ok: false,
			error: "boom",
		});
	});

	it("forwards raw arguments untouched and returns the transport error", async () => {
		const infos = parseToolList({ tools: [{ name: "read" }] });
		const callTool = vi.fn(async (tool: string, args: unknown) => {
			expect(tool).toBe("read");
			return {
				content: [{ type: "text", text: JSON.stringify(args) }],
				isError: false,
			};
		});
		const { tools } = mapServerTools({
			server: "s",
			client: stubClient(callTool),
			infos,
			existingNames: new Set(),
		});
		const ctx = { workspaceRoot: process.cwd() };
		const rawArgs = { extra: true, nested: { a: 1 } };

		expect(await executeTool(tools[0], rawArgs, ctx)).toEqual({
			ok: true,
			output: JSON.stringify(rawArgs),
		});
		expect(callTool).toHaveBeenCalledWith("read", rawArgs);

		const broken = mapServerTools({
			server: "s",
			client: stubClient(async () => {
				throw new Error("mcp s: connection lost");
			}),
			infos,
			existingNames: new Set(),
		});

		expect(await executeTool(broken.tools[0], {}, ctx)).toEqual({
			ok: false,
			error: "mcp s: connection lost",
		});
	});
});
