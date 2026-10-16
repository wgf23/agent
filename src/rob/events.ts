import type { AgentEvent } from "../agent/events.js";
import type { ApprovalChoice } from "../permissions/authorizer.js";
import type { ApprovalRequest } from "./approvals.js";
import type { RoomEvent } from "./room.js";
import type { DmEntry, RobStatus, SubagentEntry } from "./types.js";

export type TeamEvent =
	| { kind: "rob_event"; rob: string; event: AgentEvent }
	| { kind: "rob_status"; rob: string; status: RobStatus }
	| { kind: "notice"; rob: string; text: string }
	| { kind: "dm"; entry: DmEntry }
	| { kind: "subagent"; entry: SubagentEntry }
	// expiresAt is set when the request became the head of the approval queue
	// and its window started; it is absent for a request enqueued behind
	// another one, whose window has not begun.
	| {
			kind: "approval_requested";
			request: ApprovalRequest;
			expiresAt?: number;
	  }
	| { kind: "approval_resolved"; id: string; decision: ApprovalChoice }
	| { kind: "room"; event: RoomEvent };

export type TeamListener = (event: TeamEvent) => void;
