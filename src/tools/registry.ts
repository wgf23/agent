import { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import { loadSkillTool } from "../skills/tool.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit_file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read_file.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { webFetchTool } from "./web_fetch.js";
import { writeFileTool } from "./write_file.js";

export const tools: Tool[] = [
	readFileTool,
	writeFileTool,
	editFileTool,
	bashTool,
	globTool,
	grepTool,
	loadSkillTool,
	webFetchTool,
];

export function getTool(name: string): Tool | undefined {
	return tools.find((tool) => tool.name === name);
}

export function toolDefinition(tool: Tool): ToolDefinition {
	const parameters =
		tool.schema !== undefined
			? Object.fromEntries(Object.entries(z.toJSONSchema(tool.schema)))
			: (tool.parameters ?? { type: "object", properties: {} });
	return {
		name: tool.name,
		description: tool.description,
		parameters,
	};
}

export function toolDefinitions(): ToolDefinition[] {
	return tools.map(toolDefinition);
}

export async function executeTool(
	tool: Tool,
	rawArgs: unknown,
	ctx: ToolContext,
): Promise<ToolResult> {
	try {
		// A zod tool validates before its handler runs; an external tool owns its
		// own validation and receives the raw arguments.
		if (tool.schema !== undefined) {
			const parsed = tool.schema.safeParse(rawArgs);
			if (!parsed.success) {
				return {
					ok: false,
					error: `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`,
				};
			}
			return await tool.execute(parsed.data, ctx);
		}
		return await tool.execute(rawArgs, ctx);
	} catch (error) {
		return {
			ok: false,
			error: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function execute(
	name: string,
	rawArgs: unknown,
	ctx: ToolContext,
): Promise<ToolResult> {
	const tool = getTool(name);
	if (!tool) {
		return { ok: false, error: `Unknown tool: ${name}` };
	}
	return executeTool(tool, rawArgs, ctx);
}
