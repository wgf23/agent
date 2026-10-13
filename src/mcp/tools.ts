import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import type { McpClient } from "./client.js";

const toolInfoSchema = z.looseObject({
	name: z.string().min(1),
	description: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()).optional(),
	annotations: z
		.looseObject({ readOnlyHint: z.boolean().optional() })
		.optional(),
});
export type McpToolInfo = z.infer<typeof toolInfoSchema>;

const contentPartSchema = z.looseObject({
	type: z.string(),
	text: z.string().optional(),
});
const callResultSchema = z.looseObject({
	content: z.array(contentPartSchema).optional(),
	isError: z.boolean().optional(),
});

const INVALID_NAME_CHAR = /[^A-Za-z0-9_-]/g;

function sanitize(part: string): string {
	return part.replace(INVALID_NAME_CHAR, "_");
}

export function mcpToolName(server: string, tool: string): string {
	return `mcp__${sanitize(server)}__${sanitize(tool)}`;
}

export function parseToolList(result: unknown): McpToolInfo[] {
	if (!isRecord(result) || !Array.isArray(result.tools)) return [];
	const tools: McpToolInfo[] = [];
	for (const raw of result.tools) {
		const parsed = toolInfoSchema.safeParse(raw);
		if (parsed.success) tools.push(parsed.data);
	}
	return tools;
}

export interface MapServerToolsInput {
	server: string;
	client: McpClient;
	infos: McpToolInfo[];
	existingNames: Set<string>;
}

// Maps one server's tools to our shape. A name collision with any already-known
// tool rejects the whole server, because two tools cannot share one name.
export function mapServerTools(input: MapServerToolsInput): {
	tools: Tool[];
	error?: string;
} {
	const { server, client, infos, existingNames } = input;
	const named: Array<{ name: string; info: McpToolInfo }> = [];
	for (const info of infos) {
		const name = mcpToolName(server, info.name);
		if (existingNames.has(name) || named.some((entry) => entry.name === name)) {
			return { tools: [], error: `tool name collision: ${name}` };
		}
		named.push({ name, info });
	}
	const tools: Tool[] = named.map(({ name, info }) => ({
		name,
		description: info.description ?? "",
		readOnly: info.annotations?.readOnlyHint === true,
		parameters: info.inputSchema ?? { type: "object", properties: {} },
		execute: (args) => callTool(client, name, info.name, args),
	}));
	for (const entry of named) existingNames.add(entry.name);
	return { tools };
}

async function callTool(
	client: McpClient,
	fullName: string,
	toolName: string,
	args: unknown,
): Promise<ToolResult> {
	try {
		const parsed = callResultSchema.safeParse(
			await client.callTool(toolName, args),
		);
		if (!parsed.success) {
			return { ok: false, error: `${fullName}: unexpected tools/call result` };
		}
		const text = (parsed.data.content ?? [])
			.map((part) => (part.type === "text" ? (part.text ?? "") : null))
			.filter((value): value is string => value !== null)
			.join("\n");
		if (parsed.data.isError === true) return { ok: false, error: text };
		return { ok: true, output: text };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
