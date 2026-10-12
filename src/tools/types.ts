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

export interface Tool<
	TSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
	name: string;
	description: string;
	schema: TSchema;
	readOnly: boolean;
	execute(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolResult>;
}
