import { z } from "zod";
import { WORKSPACE_BOT } from "../../shared/protocol.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import type {
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import { permissionRulesSchema } from "../permissions/rules.js";
import type { Tool } from "../tools/types.js";

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
		// both from their own setup, so they are optional there.
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
	});
export type RobConfig = z.infer<typeof robConfigSchema>;

export type InboundKind = "user" | "dm" | "subagent_result" | "room";

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

/** One teammate as the live roster presents it. Derived per call; never stored. */
export interface Teammate {
	readonly name: RobName;
	readonly role: string;
}

/** Why an outbound DM was not queued. Machine-readable; the tool renders the
 *  model-facing text from it in one place. */
export type DeliveryReason =
	| "unknown_target"
	| "self"
	| "turn_limit"
	| "team_stopped";

export type DeliveryOutcome =
	| { readonly status: "queued" }
	| { readonly status: "rejected"; readonly reason: DeliveryReason };

export type DelegateReason = "denied" | "depth_exceeded" | "aborted" | "failed";

export type DelegateOutcome =
	| { readonly status: "ok"; readonly text: string }
	| {
			readonly status: "rejected";
			readonly reason: DelegateReason;
			readonly detail: string;
	  };

export type DelegateRunner = (
	task: string,
	signal?: AbortSignal,
) => Promise<string>;

/** What the rob lends the team for one turn: the team cannot authorize or run
 *  a sub-agent without the rob's rules, provider and approval path. */
export interface TurnHost {
	readonly signal: AbortSignal;
	readonly workspaceRoot: string;
	readonly authorize: Authorize;
	readonly runSubagent: DelegateRunner;
}

/** The only team surface a backend sees. It deliberately has no execute: a
 *  transport reaches the host through the gateway socket, so no backend can
 *  run a team tool without passing the authorization gate. */
export interface BridgePort {
	readonly rob: RobName;
	/** The two Tool objects, bound to this turn. There is no second list. */
	readonly tools: readonly Tool[];
	/** Live roster, self excluded. Called at prompt-build time. */
	roster(): readonly Teammate[];
	/** Opaque env that attaches one of this rob's children to the gateway.
	 *  Backends spread it into spawn env; they never read the values. */
	childEnv(): Record<string, string>;
	/** Idempotent; closes this turn's gateway link. Safe in a finally. */
	close(): void;
}

export interface TeamPort {
	/** Opens the bridge for one turn of `rob`. Resolves once the gateway is
	 *  listening, so a backend can safely spawn with childEnv(). */
	beginTurn(rob: RobName, host: TurnHost): Promise<BridgePort>;
	postDm(from: RobName, to: RobName, text: string): DeliveryOutcome;
	/** The live roster, in configuration order. */
	roster(): readonly Teammate[];
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
