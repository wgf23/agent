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
	// Clears the expiry timer while the request is the head of the queue
	// and is resolved, denied, or expired.
	cancel?: () => void;
	// The expiry window the request gets once it becomes the head.
	timeoutMs: number;
	schedule: ApprovalScheduler;
}

export interface EnqueuedApproval {
	id: string;
	request: ApprovalRequest;
	decision: Promise<ApprovalDecision>;
}

// The queue defaults to a five-minute expiry. A proactive wake could otherwise
// wait on an approval nobody answers and hang its turn forever.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export type ApprovalScheduler = (delayMs: number, fn: () => void) => () => void;

export interface ApprovalRequestOptions {
	timeoutMs?: number;
	schedule?: ApprovalScheduler;
}

// Unrefs the handle so a lone pending approval never holds the process open;
// the returned cancel clears it when the request resolves first.
const defaultScheduler: ApprovalScheduler = (delayMs, fn) => {
	const handle = setTimeout(fn, delayMs);
	handle.unref?.();
	return () => clearTimeout(handle);
};

// All robs share one FIFO queue. Whoever resolves an id answers that rob's
// authorizer; an unknown id is a programming error, not a silent no-op.
export class ApprovalQueue {
	private seq = 0;
	private readonly entries = new Map<string, PendingApproval>();
	private readonly order: string[] = [];
	// The id whose expiry timer is live. Only the head of the queue has
	// one: the client shows only the first request, so a queued approval
	// is invisible and its window must not run while the user works on
	// the head.
	private armedId: string | undefined;

	request(
		rob: RobName,
		request: AuthorizerApprovalRequest,
		options: ApprovalRequestOptions = {},
	): EnqueuedApproval {
		const id = `approval-${this.seq}`;
		this.seq += 1;
		const queued: ApprovalRequest = { id, rob, ...request };
		const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		const schedule = options.schedule ?? defaultScheduler;
		const decision = new Promise<ApprovalDecision>((resolve) => {
			const entry: PendingApproval = {
				request: queued,
				resolve,
				timeoutMs,
				schedule,
			};
			this.entries.set(id, entry);
			this.order.push(id);
		});
		// The expiry clock starts at promotion to the head, not at
		// enqueue; arming happens immediately only for the first request.
		if (this.order[0] === id) this.armHead();
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

	denyRob(rob: RobName, reason: string): void {
		for (const id of [...this.order]) {
			if (this.entries.get(id)?.request.rob !== rob) continue;
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

	// Arms the head's expiry, replacing the head's own timer. A
	// head that is already armed keeps its timer: only a removal
	// moves the queue, and every removal re-arms here.
	private armHead(): void {
		const id = this.order[0];
		if (id === undefined || id === this.armedId) return;
		const entry = this.entries.get(id);
		if (entry === undefined) return;
		if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs < 0) return;
		entry.cancel = entry.schedule(entry.timeoutMs, () => {
			if (!this.entries.has(id)) return;
			this.take(id).resolve({
				deny: `No one answered this approval within ${entry.timeoutMs / 1000}s, so it was denied.`,
			});
		});
		this.armedId = id;
	}

	private take(id: string): PendingApproval {
		const entry = this.entries.get(id);
		if (entry === undefined) throw new UnknownApprovalError(id);
		this.entries.delete(id);
		const index = this.order.indexOf(id);
		if (index !== -1) this.order.splice(index, 1);
		entry.cancel?.();
		entry.cancel = undefined;
		if (this.armedId === id) this.armedId = undefined;
		// The queue moved up, so the new head's own window starts
		// now (and denyAll/denyRob leave no timer armed).
		this.armHead();
		return entry;
	}
}
