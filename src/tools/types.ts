import type { z } from "zod";
import type { BashPlanFn } from "../sandbox/index.js";

export interface ToolContext {
	workspaceRoot: string;
	signal?: AbortSignal;
	// Tests inject a plan so the bash tool never probes the host or reads config.
	planBash?: BashPlanFn;
}

export type ToolResult =
	| { ok: true; output: string }
	| { ok: false; error: string };

// A zod tool sets `schema` and the registry validates arguments with it. An
// external tool (MCP) sets `parameters` (JSON Schema) instead and receives raw,
// unvalidated arguments, because the server owns validation and its schema is
// not zod. Exactly one of the two is present.
export interface Tool<TSchema extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	readOnly: boolean;
	schema?: TSchema;
	parameters?: Record<string, unknown>;
	execute(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolResult>;
}
