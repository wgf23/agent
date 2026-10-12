import { z } from "zod";
import type { AgentEvent } from "../agent/events.js";
import type {
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import { permissionRulesSchema } from "../permissions/rules.js";

const ROB_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const robNameSchema = z
	.string()
	.regex(
		ROB_NAME_PATTERN,
		"Rob names must start with a lowercase letter and contain only lowercase letters, digits, and dashes (at most 32 characters).",
	);
export type RobName = z.infer<typeof robNameSchema>;

export const robConfigSchema = z.object({
	name: robNameSchema,
	role: z.string(),
	model: z.string().min(1).optional(),
	permissions: permissionRulesSchema.optional(),
});
export type RobConfig = z.infer<typeof robConfigSchema>;

export type InboundKind = "user" | "dm" | "subagent_result";

export interface Inbound {
	kind: InboundKind;
	from: string;
	text: string;
	at: number;
}

export type RobStatus = "idle" | "working" | "waiting_approval" | "stopped";

export interface DmEntry {
	from: string;
	to: string;
	text: string;
	at: number;
}

export interface SubagentEntry {
	parent: string;
	id: string;
	at: number;
	event: AgentEvent;
}

export interface RobStatusEntry {
	name: string;
	status: RobStatus;
	messageCount: number;
	pending: number;
	lastMessage: string | null;
}

export interface TeamPort {
	hasRob(name: string): boolean;
	postDm(from: RobName, to: RobName, text: string): void;
	recordSubagent(entry: SubagentEntry): void;
	requestApproval(
		rob: RobName,
		request: ApprovalRequest,
	): Promise<ApprovalDecision>;
	emitRobEvent(rob: RobName, event: AgentEvent): void;
	emitStatus(rob: RobName, status: RobStatus): void;
}

export function duplicateRobName(
	robs: readonly RobConfig[],
): string | undefined {
	const seen = new Set<string>();
	for (const rob of robs) {
		if (seen.has(rob.name)) return rob.name;
		seen.add(rob.name);
	}
	return undefined;
}
