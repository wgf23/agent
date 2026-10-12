import type { AgentEvent } from "../agent/events.js";
import type {
	ApprovalChoice,
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";
import type { Provider } from "../providers/types.js";
import { ApprovalQueue } from "./approvals.js";
import type { TeamEvent, TeamListener } from "./events.js";
import { type AuthorizerFactory, Rob } from "./rob.js";
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

export class UnknownRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Unknown rob: ${name}`);
		this.name = "UnknownRobError";
		this.robName = name;
	}
}

export interface TeamOptions {
	robs: RobConfig[];
	defaultModel: string;
	providerFactory: (rob: RobConfig) => Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
}

export class Team implements TeamPort {
	private readonly robs = new Map<RobName, Rob>();
	private readonly loops = new Map<RobName, Promise<void>>();
	private readonly dms: DmEntry[] = [];
	private readonly subagents: SubagentEntry[] = [];
	private readonly approvals = new ApprovalQueue();
	private readonly listeners = new Set<TeamListener>();
	private started = false;
	private stopping = false;

	constructor(options: TeamOptions) {
		for (const config of options.robs) {
			this.robs.set(
				config.name,
				new Rob({
					name: config.name,
					role: config.role,
					permissions: config.permissions ?? {},
					model: config.model ?? options.defaultModel,
					provider: options.providerFactory(config),
					workspaceRoot: options.workspaceRoot,
					authorizerFactory: options.authorizerFactory,
					team: this,
				}),
			);
		}
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
