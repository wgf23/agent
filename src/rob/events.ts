import type { AgentEvent } from "../agent/events.js";
import type { ApprovalChoice } from "../permissions/authorizer.js";
import type { ApprovalRequest } from "./approvals.js";
import type { DmEntry, RobStatus, SubagentEntry } from "./types.js";

export type TeamEvent =
	| { kind: "rob_event"; rob: string; event: AgentEvent }
	| { kind: "rob_status"; rob: string; status: RobStatus }
	| { kind: "notice"; rob: string; text: string }
	| { kind: "dm"; entry: DmEntry }
	| { kind: "subagent"; entry: SubagentEntry }
	| { kind: "approval_requested"; request: ApprovalRequest }
	| { kind: "approval_resolved"; id: string; decision: ApprovalChoice };

export type TeamListener = (event: TeamEvent) => void;
