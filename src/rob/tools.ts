import { z } from "zod";
import type { PermissionRules } from "../permissions/rules.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import type { RoomName, RoomReplyOutcome, RoomReplyReason } from "./room.js";
import { renderRoomOutcome } from "./room-text.js";
import {
	type DelegateOutcome,
	type DelegateReason,
	type DelegateRunner,
	type DeliveryOutcome,
	type DeliveryReason,
	type RobName,
	robNameSchema,
	type TeamPort,
} from "./types.js";

export const DM_LIMIT_PER_RUN = 20;
export const DELEGATE_OUTPUT_MAX_CHARS = 4000;
export const MAX_DELEGATE_DEPTH = 1;

// Rob tools carry no file subject, so the authorizer needs a default rule.
// send_message is read-only and auto-replied; room_reply only writes the room
// transcript; delegate can write and asks. remember and forget write only the
// rob's own memory delta, never the filesystem, so they are allowed.
export function robToolRules(): PermissionRules {
	return {
		send_message: "allow",
		room_reply: "allow",
		delegate: "ask",
		remember: "allow",
		forget: "allow",
	};
}

const sendMessageSchema = z
	.object({ to: robNameSchema, text: z.string() })
	.strict();
const delegateSchema = z.object({ task: z.string() }).strict();
const roomReplySchema = z.object({ text: z.string().min(1) }).strict();

export interface TeamOperations {
	/** Counts against this turn's DM budget. Fire-and-forget. */
	sendMessage(to: RobName, text: string): DeliveryOutcome;
	/** Runs the rob's sub-agent; its text comes back capped for the model. */
	delegate(task: string, signal?: AbortSignal): Promise<DelegateOutcome>;
}

export function createTeamOperations(options: {
	team: TeamPort;
	from: RobName;
	limit?: number;
	depth?: number;
	runSubagent: DelegateRunner;
}): TeamOperations {
	const limit = options.limit ?? DM_LIMIT_PER_RUN;
	const depth = options.depth ?? 0;
	let sent = 0;

	return {
		sendMessage(to, text) {
			if (sent >= limit) return { status: "rejected", reason: "turn_limit" };
			const outcome = options.team.postDm(options.from, to, text);
			if (outcome.status === "queued") sent += 1;
			return outcome;
		},
		async delegate(task, signal) {
			if (depth >= MAX_DELEGATE_DEPTH) {
				return {
					status: "rejected",
					reason: "depth_exceeded",
					detail: "Sub-agents cannot delegate further.",
				};
			}
			try {
				const text = await options.runSubagent(task, signal);
				return {
					status: "ok",
					text:
						text.length > DELEGATE_OUTPUT_MAX_CHARS
							? text.slice(0, DELEGATE_OUTPUT_MAX_CHARS)
							: text,
				};
			} catch (error) {
				if (signal?.aborted === true) {
					return {
						status: "rejected",
						reason: "aborted",
						detail: "The turn was interrupted before the sub-agent finished.",
					};
				}
				return {
					status: "rejected",
					reason: "failed",
					detail: errorMessage(error),
				};
			}
		},
	};
}

/** One served team-tool call: the typed domain reason plus the text the model
 *  sees. The native loop and the gateway both consume this shape. */
export type TeamCallOutcome =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly reason: DeliveryReason | DelegateReason | RoomReplyReason;
			readonly text: string;
	  };

/** A `Tool` plus the typed-outcome entry point the gateway's invoke uses. */
export interface TeamTool extends Tool {
	run(args: unknown, ctx: ToolContext): Promise<TeamCallOutcome>;
}

function buildTeamTool<TSchema extends z.ZodType>(spec: {
	name: string;
	description: string;
	readOnly: boolean;
	schema: TSchema;
	serve(args: z.infer<TSchema>, ctx: ToolContext): Promise<TeamCallOutcome>;
}): TeamTool {
	return {
		name: spec.name,
		description: spec.description,
		readOnly: spec.readOnly,
		schema: spec.schema,
		async run(args, ctx) {
			return spec.serve(args as z.infer<TSchema>, ctx);
		},
		async execute(args, ctx) {
			return toToolResult(await spec.serve(args as z.infer<TSchema>, ctx));
		},
	};
}

function toToolResult(outcome: TeamCallOutcome): ToolResult {
	return outcome.ok
		? { ok: true, output: outcome.text }
		: { ok: false, error: outcome.text };
}

/** The one place both Tool objects are built: the native loop mounts them and
 *  the gateway serves the same objects. */
export function teamTools(operations: TeamOperations): readonly TeamTool[] {
	return [
		buildTeamTool({
			name: "send_message",
			description:
				"Send a private message to another rob on the team. Only that rob can read it.",
			readOnly: true,
			schema: sendMessageSchema,
			async serve(args) {
				const outcome = operations.sendMessage(args.to, args.text);
				return outcome.status === "queued"
					? { ok: true, text: renderOutcome(outcome, args.to) }
					: {
							ok: false,
							reason: outcome.reason,
							text: renderOutcome(outcome, args.to),
						};
			},
		}),
		buildTeamTool({
			name: "delegate",
			description:
				"Delegate one self-contained task to a sub-agent and return its final answer. Sub-agents cannot delegate further.",
			readOnly: false,
			schema: delegateSchema,
			async serve(args, ctx) {
				const outcome = await operations.delegate(args.task, ctx.signal);
				return outcome.status === "ok"
					? { ok: true, text: renderOutcome(outcome) }
					: { ok: false, reason: outcome.reason, text: renderOutcome(outcome) };
			},
		}),
	];
}

/** What one room turn lets a rob do. Bound at bridge-build time to one room, so
 *  the tool takes no room name and cannot address another room. */
export interface RoomTurnOperations {
	readonly room: RoomName;
	reply(text: string): RoomReplyOutcome;
}

/** The room tool set for one turn. Present only in room turns, so its
 *  appearance in the team preamble is itself the instruction to speak. */
export function roomTools(operations: RoomTurnOperations): readonly TeamTool[] {
	return [
		buildTeamTool({
			name: "room_reply",
			description:
				"Post one brief message to the room this turn belongs to. Call it at most once, or end the turn without calling it to pass.",
			readOnly: true,
			schema: roomReplySchema,
			async serve(args) {
				const outcome = operations.reply(args.text);
				const text = renderRoomOutcome(outcome, operations.room);
				return outcome.status === "rejected"
					? { ok: false, reason: outcome.reason, text }
					: { ok: true, text };
			},
		}),
	];
}

/** The one place outcome text is rendered. `to` names the DM recipient, which
 *  a DeliveryOutcome does not carry. */
export function renderOutcome(outcome: DelegateOutcome): string;
export function renderOutcome(outcome: DeliveryOutcome, to: string): string;
export function renderOutcome(
	outcome: DeliveryOutcome | DelegateOutcome,
	to?: string,
): string {
	switch (outcome.status) {
		case "ok":
			return outcome.text;
		case "queued":
			return `Message queued for "${to}".`;
		case "rejected":
			switch (outcome.reason) {
				case "unknown_target":
					return `Unknown rob: ${to}`;
				case "self":
					return "Cannot send a message to yourself.";
				case "turn_limit":
					return "DM limit reached for this turn.";
				case "team_stopped":
					return "The team is stopping; the message was not sent.";
				default:
					return outcome.detail;
			}
	}
}
