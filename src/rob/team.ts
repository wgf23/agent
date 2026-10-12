import type { AgentEvent } from "../agent/events.js";
import type {
	ApprovalChoice,
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import { defaultRules, type PermissionRules } from "../permissions/rules.js";
import type { Provider } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { ApprovalQueue } from "./approvals.js";
import type { TeamEvent, TeamListener } from "./events.js";
import { type AuthorizerFactory, Rob } from "./rob.js";
import { robToolRules } from "./tools.js";
import type {
	DmEntry,
	RobConfig,
	RobName,
	RobStatus,
	RobStatusEntry,
	SubagentEntry,
	TeamPort,
} from "./types.js";

export const TEAM_STOPPED_REASON =
	"The team stopped before this approval was answered.";

export const TURN_INTERRUPTED_REASON =
	"The turn was interrupted before the approval was answered.";

export class UnknownRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Unknown rob: ${name}`);
		this.name = "UnknownRobError";
		this.robName = name;
	}
}

export class DuplicateRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Duplicate rob name: ${name}`);
		this.name = "DuplicateRobError";
		this.robName = name;
	}
}

export interface TeamOptions {
	robs: RobConfig[];
	defaultModel: string;
	providerFactory: (rob: RobConfig) => Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
	permissions?: PermissionRules;
	providerEnv?: Record<string, string>;
	// Native robs receive these; cli backends run their own tool registry.
	extraTools?: Tool[];
}

export class Team implements TeamPort {
	private readonly options: TeamOptions;
	private readonly robs = new Map<RobName, Rob>();
	private readonly loops = new Map<RobName, Promise<void>>();
	private readonly dms: DmEntry[] = [];
	private readonly subagents: SubagentEntry[] = [];
	private readonly approvals = new ApprovalQueue();
	private readonly listeners = new Set<TeamListener>();
	private started = false;
	private stopping = false;

	constructor(options: TeamOptions) {
		this.options = options;
		for (const config of options.robs) {
			this.robs.set(config.name, this.createRob(config));
		}
	}

	// Adds a rob at runtime and starts its loop when the team is already
	// running. A duplicate name is an error; the caller validates first.
	addRob(config: RobConfig): void {
		if (this.robs.has(config.name)) {
			throw new DuplicateRobError(config.name);
		}
		const rob = this.createRob(config);
		this.robs.set(config.name, rob);
		if (this.started && !this.stopping) {
			this.loops.set(config.name, rob.run());
		}
	}

	private createRob(config: RobConfig): Rob {
		return new Rob({
			name: config.name,
			role: config.role,
			rules: resolveRobRules(this.options.permissions ?? {}, config),
			model: config.model ?? this.options.defaultModel,
			provider: this.options.providerFactory(config),
			workspaceRoot: this.options.workspaceRoot,
			authorizerFactory: this.options.authorizerFactory,
			team: this,
			backend: config.backend,
			providerEnv: this.options.providerEnv,
			extraTools: this.options.extraTools,
		});
	}

	subscribe(listener: TeamListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		for (const [name, rob] of this.robs) {
			this.loops.set(name, rob.run());
		}
	}

	dispatch(name: string, text: string): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now() });
	}

	interject(name: string, text: string): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now() });
	}

	readDms(): readonly DmEntry[] {
		return this.dms.map((entry) => ({ ...entry }));
	}

	readSubagents(robName?: string): readonly SubagentEntry[] {
		const entries =
			robName === undefined
				? this.subagents
				: this.subagents.filter((entry) => entry.parent === robName);
		return entries.map((entry) => structuredClone(entry));
	}

	statuses(): readonly RobStatusEntry[] {
		return [...this.robs.values()].map((rob) => rob.statusSnapshot());
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.approvals.denyAll(TEAM_STOPPED_REASON);
		for (const rob of this.robs.values()) {
			rob.stop();
		}
		await Promise.all([...this.loops.values()]);
	}

	// Ends the rob's current turn and keeps the rob alive for the next dispatch.
	interrupt(name: string): void {
		const rob = this.requireRob(name);
		rob.abortTurn();
		this.approvals.denyRob(name, TURN_INTERRUPTED_REASON);
	}

	hasRob(name: string): boolean {
		return this.robs.has(name);
	}

	postDm(from: RobName, to: RobName, text: string): void {
		const at = Date.now();
		const entry: DmEntry = { from, to, text, at };
		this.dms.push(entry);
		this.emit({ kind: "dm", entry: { ...entry } });
		this.robs.get(to)?.deliver({ kind: "dm", from, text, at });
	}

	recordSubagent(entry: SubagentEntry): void {
		this.subagents.push(entry);
		this.emit({ kind: "subagent", entry: structuredClone(entry) });
	}

	requestApproval(
		rob: RobName,
		request: ApprovalRequest,
	): Promise<ApprovalDecision> {
		const target = this.requireRob(rob);
		// A rob mid-authorize can ask after stop began denying; enqueueing then
		// would wait forever and hang stop(), so deny it here.
		if (this.stopping) {
			return Promise.resolve({ deny: TEAM_STOPPED_REASON });
		}
		const enqueued = this.approvals.request(rob, request);
		target.markWaitingApproval();
		this.emit({
			kind: "approval_requested",
			request: { ...enqueued.request },
		});
		return enqueued.decision.then((decision) => {
			this.emit({
				kind: "approval_resolved",
				id: enqueued.id,
				decision: toChoice(decision),
			});
			target.markWorking();
			return decision;
		});
	}

	resolveApproval(id: string, decision: ApprovalDecision): void {
		this.approvals.resolve(id, decision);
	}

	emitRobEvent(rob: RobName, event: AgentEvent): void {
		this.emit({ kind: "rob_event", rob, event: structuredClone(event) });
	}

	emitStatus(rob: RobName, status: RobStatus): void {
		this.emit({ kind: "rob_status", rob, status });
	}

	emitNotice(rob: RobName, text: string): void {
		this.emit({ kind: "notice", rob, text });
	}

	private emit(event: TeamEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private requireRob(name: string): Rob {
		const rob = this.robs.get(name);
		if (rob === undefined) throw new UnknownRobError(name);
		return rob;
	}
}

function toChoice(decision: ApprovalDecision): ApprovalChoice {
	if (typeof decision === "object") return "deny";
	return decision;
}

// One merge for the authorizer and the cli tool allowlist, so a rob's effective
// rules cannot differ between the two.
function resolveRobRules(
	project: PermissionRules,
	rob: RobConfig,
): PermissionRules {
	return {
		...defaultRules(),
		...robToolRules(),
		...project,
		...rob.permissions,
	};
}
