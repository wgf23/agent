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

/** Turns one half of a tool name into the characters the wire allows.
 *
 *  Exported so the security scan can compare a configured value against the
 *  shape it would take in a tool name. Both sides must use this one function:
 *  a second copy of the pattern is a second place for it to drift.
 */
/** What a tool with no declared schema takes. A tool may legitimately omit
 *  `inputSchema`, and the fallback has to be the same in the mapper and in the
 *  scan: `{}` accepts any value, while this says the tool takes an object, so
 *  the two are not interchangeable. Spread it rather than sharing one object --
 *  the scan builds a new value per tool.
 */
export const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

export function sanitizeNamePart(part: string): string {
	return part.replace(INVALID_NAME_CHAR, "_");
}

export function mcpToolName(server: string, tool: string): string {
	return `mcp__${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
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
		parameters: info.inputSchema ?? { ...EMPTY_INPUT_SCHEMA },
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
