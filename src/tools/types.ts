import type { z } from "zod";
import type { BashPlanFn } from "../sandbox/index.js";

/** What a tool with no declared schema takes. Three places answer this
 *  question -- the MCP mapper, the MCP scan and the registry fallback -- and
 *  they have to agree: `{}` accepts any value, while this says the tool takes
 *  an object, so drifting apart would widen the contract the model sees.
 */
export const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

/** A fresh copy per call. `properties` is mutable, so handing out one object
 *  would let a consumer editing one tool's schema reach every other tool's.
 */
export function emptyInputSchema(): Record<string, unknown> {
	return { type: EMPTY_INPUT_SCHEMA.type, properties: {} };
}

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
