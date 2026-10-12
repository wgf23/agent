import type {
	ApprovalDecision,
	ApprovalRequest as AuthorizerApprovalRequest,
} from "../permissions/authorizer.js";
import type { RobName } from "./types.js";

export interface ApprovalRequest {
	id: string;
	rob: RobName;
	toolName: string;
	subject: string;
	dangerous: boolean;
	rule: string | null;
}

export class UnknownApprovalError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Unknown or already resolved approval: ${id}`);
		this.name = "UnknownApprovalError";
		this.id = id;
	}
}

interface PendingApproval {
	request: ApprovalRequest;
	resolve: (decision: ApprovalDecision) => void;
}

export interface EnqueuedApproval {
	id: string;
	request: ApprovalRequest;
	decision: Promise<ApprovalDecision>;
}

// All robs share one FIFO queue. Whoever resolves an id answers that rob's
// authorizer; an unknown id is a programming error, not a silent no-op.
export class ApprovalQueue {
	private seq = 0;
	private readonly entries = new Map<string, PendingApproval>();
	private readonly order: string[] = [];

	request(rob: RobName, request: AuthorizerApprovalRequest): EnqueuedApproval {
		const id = `approval-${this.seq}`;
		this.seq += 1;
		const queued: ApprovalRequest = { id, rob, ...request };
		const decision = new Promise<ApprovalDecision>((resolve) => {
			this.entries.set(id, { request: queued, resolve });
		});
		this.order.push(id);
		return { id, request: queued, decision };
	}

	pending(): readonly ApprovalRequest[] {
		return this.order
			.map((id) => this.entries.get(id)?.request)
			.filter((request): request is ApprovalRequest => request !== undefined)
			.map((request) => ({ ...request }));
	}

	get size(): number {
		return this.entries.size;
	}

	resolve(id: string, decision: ApprovalDecision): void {
		const entry = this.take(id);
		entry.resolve(decision);
		// allow_always persists a standing rule, so later identical requests no
		// longer need to prompt. Resolve them allow_once to avoid writing twice.
		if (decision === "allow_always") this.allowDuplicates(entry.request);
	}

	denyAll(reason: string): void {
		for (const id of [...this.order]) {
			this.take(id).resolve({ deny: reason });
		}
	}

	private allowDuplicates(source: ApprovalRequest): void {
		if (source.dangerous || source.rule === null) return;
		for (const id of [...this.order]) {
			const entry = this.entries.get(id);
			if (entry === undefined) continue;
			if (entry.request.toolName !== source.toolName) continue;
			if (entry.request.rule !== source.rule) continue;
			this.take(id).resolve("allow_once");
		}
	}

	private take(id: string): PendingApproval {
		const entry = this.entries.get(id);
		if (entry === undefined) throw new UnknownApprovalError(id);
		this.entries.delete(id);
		const index = this.order.indexOf(id);
		if (index !== -1) this.order.splice(index, 1);
		return entry;
	}
}
