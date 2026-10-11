import type { z } from "zod";

export interface ToolContext {
	workspaceRoot: string;
	signal?: AbortSignal;
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
