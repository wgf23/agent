import type { AgentEvent } from "../../src/agent/events.js";
import type {
	ApprovalDecision,
	ApprovalRequest,
} from "../../src/permissions/authorizer.js";
import type { AuthorizerFactory } from "../../src/rob/rob.js";
import type { RoomLedger, RoomState } from "../../src/rob/room.js";
import { createTeamOperations, teamTools } from "../../src/rob/tools.js";
import type {
	BridgePort,
	DeliveryOutcome,
	DmEntry,
	RobName,
	RobStatus,
	SubagentEntry,
	Teammate,
	TeamPort,
	TurnHost,
} from "../../src/rob/types.js";

/** The room's persistence port in memory, for tests that do not exercise the
 *  file store (graft 3). */
export class MemoryRoomLedger implements RoomLedger {
	readonly saves: RoomState[] = [];
	async save(state: RoomState): Promise<void> {
		this.saves.push(state);
	}
	async flush(): Promise<void> {}
}

export function allowAllAuthorizerFactory(): AuthorizerFactory {
	return () => async () => ({ allowed: true });
}

export function fakeBridge(overrides: Partial<BridgePort> = {}): BridgePort {
	return {
		rob: "reviewer",
		tools: [],
		roster: () => [],
		childEnv: () => ({}),
		close: () => undefined,
		...overrides,
	};
}

export class FakeTeam implements TeamPort {
	readonly dms: DmEntry[] = [];
	readonly subagents: SubagentEntry[] = [];
	readonly teammates: readonly Teammate[];
	stopped = false;

	constructor(teammates: readonly Teammate[] = []) {
		this.teammates = [...teammates];
	}

	roster(): readonly Teammate[] {
		return this.teammates;
	}

	async beginTurn(rob: RobName, host: TurnHost): Promise<BridgePort> {
		const operations = createTeamOperations({
			team: this,
			from: rob,
			runSubagent: host.runSubagent,
		});
		return {
			rob,
			tools: teamTools(operations),
			roster: () => this.teammates.filter((teammate) => teammate.name !== rob),
			childEnv: () => ({}),
			close: () => undefined,
		};
	}

	postDm(from: RobName, to: RobName, text: string): DeliveryOutcome {
		if (from === to) return { status: "rejected", reason: "self" };
		if (!this.teammates.some((teammate) => teammate.name === to)) {
			return { status: "rejected", reason: "unknown_target" };
		}
		if (this.stopped) return { status: "rejected", reason: "team_stopped" };
		this.dms.push({ from, to, text, at: 0 });
		return { status: "queued" };
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
