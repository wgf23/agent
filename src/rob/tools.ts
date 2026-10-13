import { z } from "zod";
import type { PermissionRules } from "../permissions/rules.js";
import type { Tool } from "../tools/types.js";
import type { RobName, TeamPort } from "./types.js";

export const DM_LIMIT_PER_RUN = 20;
export const DELEGATE_OUTPUT_MAX_CHARS = 4000;
export const MAX_DELEGATE_DEPTH = 1;

// Rob tools carry no file subject, so the authorizer needs a default rule.
// send_message is read-only and auto-allowed; delegate can write and asks.
// remember and forget write only the rob's own memory, so they are allowed.
export function robToolRules(): PermissionRules {
	return {
		send_message: "allow",
		delegate: "ask",
		remember: "allow",
		forget: "allow",
	};
}

const sendMessageSchema = z
	.object({ to: z.string(), text: z.string() })
	.strict();

export function createSendMessageTool(options: {
	team: TeamPort;
	from: RobName;
	limit?: number;
}): Tool<typeof sendMessageSchema> {
	const limit = options.limit ?? DM_LIMIT_PER_RUN;
	let sent = 0;

	return {
		name: "send_message",
		description:
			"Send a private message to another rob on the team. Only that rob can read it.",
		schema: sendMessageSchema,
		readOnly: true,
		async execute(args) {
			if (args.to === options.from) {
				return { ok: false, error: "Cannot send a message to yourself." };
			}
			if (!options.team.hasRob(args.to)) {
				return { ok: false, error: `Unknown rob: ${args.to}` };
			}
			if (sent >= limit) {
				return {
					ok: false,
					error: `DM limit reached: a rob may send at most ${limit} messages per run.`,
				};
			}
			sent += 1;
			options.team.postDm(options.from, args.to as RobName, args.text);
			return { ok: true, output: `Message delivered to ${args.to}.` };
		},
	};
}

export type DelegateRunner = (
	task: string,
	signal?: AbortSignal,
) => Promise<string>;

const delegateSchema = z.object({ task: z.string() }).strict();

export function createDelegateTool(options: {
	from: RobName;
	depth: number;
	run: DelegateRunner;
}): Tool<typeof delegateSchema> {
	return {
		name: "delegate",
		description:
			"Delegate one self-contained task to a sub-agent and return its final answer. Sub-agents cannot delegate further.",
		schema: delegateSchema,
		readOnly: false,
		async execute(args, ctx) {
			if (options.depth >= MAX_DELEGATE_DEPTH) {
				return { ok: false, error: "Sub-agents cannot delegate further." };
			}
			const text = await options.run(args.task, ctx.signal);
			const output =
				text.length > DELEGATE_OUTPUT_MAX_CHARS
					? text.slice(0, DELEGATE_OUTPUT_MAX_CHARS)
					: text;
			return { ok: true, output };
		},
	};
}
