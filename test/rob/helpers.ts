import type { AgentEvent } from "../../src/agent/events.js";
import type {
	ApprovalDecision,
	ApprovalRequest,
} from "../../src/permissions/authorizer.js";
import type { AuthorizerFactory } from "../../src/rob/rob.js";
import type {
	DmEntry,
	DmReadResult,
	RobName,
	RobStatus,
	SubagentEntry,
	TeamMember,
	TeamPort,
} from "../../src/rob/types.js";

export function allowAllAuthorizerFactory(): AuthorizerFactory {
	return () => async () => ({ allowed: true });
}

export class FakeTeam implements TeamPort {
	readonly dms: DmEntry[] = [];
	readonly subagents: SubagentEntry[] = [];
	private readonly members: TeamMember[];

	constructor(members: TeamMember[] = []) {
		this.members = members;
	}

	hasRob(): boolean {
		return true;
	}

	roster(): TeamMember[] {
		return this.members.map((member) => ({ ...member }));
	}

	readDms(to: RobName, fromIndex: number): DmReadResult {
		const start = Math.max(0, fromIndex);
		const entries = this.dms
			.slice(start)
			.filter((entry) => entry.to === to)
			.map((entry) => ({ ...entry }));
		return { entries, next: this.dms.length };
	}

	postDm(from: RobName, to: RobName, text: string): void {
		this.dms.push({ from, to, text, at: 0 });
	}

	recordSubagent(entry: SubagentEntry): void {
		this.subagents.push(entry);
	}

	requestApproval(
		_rob: RobName,
		_request: ApprovalRequest,
	): Promise<ApprovalDecision> {
		return Promise.resolve("allow_once");
	}

	emitRobEvent(_rob: RobName, _event: AgentEvent): void {}

	emitStatus(_rob: RobName, _status: RobStatus): void {}

	emitNotice(_rob: RobName, _text: string): void {}
}

export async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
