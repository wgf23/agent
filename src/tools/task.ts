import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import type { Tool } from "./types.js";

export const TASK_OUTPUT_MAX_CHARS = 4000;
export const MAX_TASK_DEPTH = 1;

const taskSchema = z.object({ task: z.string() }).strict();

export type TaskRunner = (
	task: string,
	signal?: AbortSignal,
) => Promise<string>;

export function createTaskTool(options: {
	run: TaskRunner;
	depth: number;
}): Tool<typeof taskSchema> {
	return {
		name: "task",
		description:
			"Delegate one self-contained sub-task to a fresh sub-agent and return only its final text. Sub-agents cannot delegate further.",
		schema: taskSchema,
		readOnly: false,
		async execute(args, ctx) {
			if (options.depth >= MAX_TASK_DEPTH) {
				return { ok: false, error: "Sub-agents cannot delegate further." };
			}
			try {
				const text = await options.run(args.task, ctx.signal);
				const output =
					text.length > TASK_OUTPUT_MAX_CHARS
						? text.slice(0, TASK_OUTPUT_MAX_CHARS)
						: text;
				return { ok: true, output };
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		},
	};
}
