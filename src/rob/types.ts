import { z } from "zod";
import { WORKSPACE_BOT } from "../../shared/protocol.js";
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

export const PI_CLI_COMMAND = "pi";
export const OPENCODE_CLI_COMMAND = "opencode";
export const CLAUDE_CLI_COMMAND = "claude";
const CLI_COMMANDS = [
	PI_CLI_COMMAND,
	OPENCODE_CLI_COMMAND,
	CLAUDE_CLI_COMMAND,
] as const;

const nativeBackendSchema = z.object({ kind: z.literal("native") }).strict();

const cliBackendSchema = z
	.object({
		kind: z.literal("cli"),
		command: z.string().min(1),
		// pi needs an explicit provider and model; opencode and claude resolve
		// them from the user's own setup, so they are optional there.
		provider: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		sessionDir: z.string().min(1).optional(),
	})
	.strict();

export const robBackendSchema = z.discriminatedUnion("kind", [
	nativeBackendSchema,
	cliBackendSchema,
]);
export type RobBackendConfig = z.infer<typeof robBackendSchema>;

// send_message and delegate are native-only; external CLIs have no equivalent.
const CLI_UNSUPPORTED_TOOLS = ["send_message", "delegate"] as const;

export const robConfigSchema = z
	.object({
		name: robNameSchema,
		role: z.string(),
		model: z.string().min(1).optional(),
		permissions: permissionRulesSchema.optional(),
		backend: robBackendSchema.optional(),
	})
	.superRefine((rob, ctx) => {
		if (rob.name === WORKSPACE_BOT) {
			ctx.addIssue({
				code: "custom",
				path: ["name"],
				message: `"${WORKSPACE_BOT}" is reserved for the workspace chat.`,
			});
		}
		const backend = rob.backend;
		if (backend === undefined || backend.kind !== "cli") return;
		if (
			!CLI_COMMANDS.includes(backend.command as (typeof CLI_COMMANDS)[number])
		) {
			ctx.addIssue({
				code: "custom",
				path: ["backend", "command"],
				message: `Unsupported CLI command "${backend.command}". Only "pi", "opencode", and "claude" are supported.`,
			});
			return;
		}
		if (
			backend.command === PI_CLI_COMMAND &&
			(backend.provider === undefined || backend.model === undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["backend"],
				message: `A "pi" cli backend requires "provider" and "model".`,
			});
		}
		const unsupported = CLI_UNSUPPORTED_TOOLS.filter(
			(tool) => rob.permissions?.[tool] !== undefined,
		);
		if (unsupported.length > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["permissions"],
				message: `A "cli" backend cannot use ${unsupported.join(", ")}. Those tools are only available to the native backend.`,
			});
		}
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

export interface RobUsage {
	input: number;
	output: number;
}

export interface RobStatusEntry {
	name: string;
	status: RobStatus;
	messageCount: number;
	pending: number;
	lastMessage: string | null;
	usage: RobUsage;
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
	emitNotice(rob: RobName, text: string): void;
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
