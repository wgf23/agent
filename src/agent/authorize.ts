import type { Tool } from "../tools/types.js";

export interface ToolCall {
	id: string;
	name: string;
	args: unknown;
}

export type AuthorizeResult =
	| { allowed: true }
	| { allowed: false; reason: string };

export type Authorize = (
	call: ToolCall,
	tool: Tool,
) => Promise<AuthorizeResult>;

export const readOnlyAuthorize: Authorize = async (_call, tool) => {
	if (tool.readOnly) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: `Tool ${tool.name} is not authorized yet. Only read-only tools run in this mode.`,
	};
};
