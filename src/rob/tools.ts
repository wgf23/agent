import { z } from "zod";
import type { PermissionRules } from "../permissions/rules.js";
import type { Tool } from "../tools/types.js";
import type { DmEntry, RobName, TeamMember, TeamPort } from "./types.js";

export const DM_LIMIT_PER_RUN = 20;
export const DELEGATE_OUTPUT_MAX_CHARS = 4000;
export const MAX_DELEGATE_DEPTH = 1;

// Rob tools carry no file subject, so the authorizer needs a default rule.
// send_message, list_robs, and read_messages are read-only and auto-allowed;
// delegate can write and asks. remember and forget write only the rob's own
// memory, so they are allowed.
export function robToolRules(): PermissionRules {
	return {
		send_message: "allow",
		list_robs: "allow",
		read_messages: "allow",
		delegate: "ask",
		remember: "allow",
		forget: "allow",
	};
}

const sendMessageSchema = z
	.object({
		to: z.union([z.string(), z.array(z.string()).min(1)]),
		text: z.string(),
	})
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
			"Send a private message to one or more teammates. Each recipient reads it at its next turn.",
		schema: sendMessageSchema,
		readOnly: true,
		async execute(args) {
			// A list reaches several teammates at once; each name becomes its own
			// DM so every recipient gets an independent turn. Dedupe and drop self
			// before touching the limit or the log.
			const requested = Array.isArray(args.to) ? args.to : [args.to];
			const recipients: string[] = [];
			for (const name of requested) {
				if (name === options.from) continue;
				if (!recipients.includes(name)) recipients.push(name);
			}
			if (recipients.length === 0) {
				return { ok: false, error: "Cannot send a message to yourself." };
			}
			for (const name of recipients) {
				if (!options.team.hasRob(name)) {
					return { ok: false, error: `Unknown rob: ${name}` };
				}
			}
			// A broadcast counts once per unique recipient against the per-turn
			// limit, and the whole batch is refused when it would not fit.
			if (sent + recipients.length > limit) {
				return {
					ok: false,
					error: `DM limit reached: a rob may send at most ${limit} messages per run.`,
				};
			}
			sent += recipients.length;
			for (const name of recipients) {
				options.team.postDm(options.from, name as RobName, args.text);
			}
			return {
				ok: true,
				output: `Message delivered to ${recipients.join(", ")}.`,
			};
		},
	};
}

const listRobsSchema = z.object({}).strict();

export function createListRobsTool(options: {
	self: RobName;
	roster: () => TeamMember[];
}): Tool<typeof listRobsSchema> {
	return {
		name: "list_robs",
		description:
			"List every rob on the team with its name and role. The calling rob is marked (you).",
		schema: listRobsSchema,
		readOnly: true,
		async execute() {
			const lines = options
				.roster()
				.map((member) =>
					member.name === options.self
						? `- ${member.name} — ${member.role} (you)`
						: `- ${member.name} — ${member.role}`,
				);
			return { ok: true, output: lines.join("\n") };
		},
	};
}

const readMessagesSchema = z.object({}).strict();

// Reads from a cursor the caller owns, so "since the last read" survives across
// turns and a rob never re-reads a DM it already saw.
export function createReadMessagesTool(options: {
	read: () => DmEntry[];
}): Tool<typeof readMessagesSchema> {
	return {
		name: "read_messages",
		description:
			"Read the private messages you received since your last read, oldest first.",
		schema: readMessagesSchema,
		readOnly: true,
		async execute() {
			const entries = options.read();
			if (entries.length === 0) {
				return { ok: true, output: "(no new messages)" };
			}
			const lines = entries.map(
				(entry) => `[from rob:${entry.from}] ${entry.text}`,
			);
			return { ok: true, output: lines.join("\n") };
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
