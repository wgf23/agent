import type {
	ApprovalChoice,
	ApprovalDecision,
	ApprovalRequest,
} from "../permissions/authorizer.js";

export interface PendingPermission {
	toolName: string;
	subject: string;
	dangerous: boolean;
	rule: string | null;
}

export interface ApprovalBridge {
	request: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	subscribe: (
		listener: (pending: PendingPermission | null) => void,
	) => () => void;
	respond: (choice: ApprovalChoice) => void;
}

export function createApprovalBridge(): ApprovalBridge {
	let pending: PendingPermission | null = null;
	let resolve: ((decision: ApprovalDecision) => void) | null = null;
	const listeners = new Set<(pending: PendingPermission | null) => void>();

	const publish = (): void => {
		for (const listener of listeners) listener(pending);
	};

	return {
		request(request) {
			return new Promise<ApprovalDecision>((res) => {
				pending = {
					toolName: request.toolName,
					subject: request.subject,
					dangerous: request.dangerous,
					rule: request.rule,
				};
				resolve = res;
				publish();
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		respond(choice) {
			const res = resolve;
			if (res === null) return;
			pending = null;
			resolve = null;
			publish();
			res(choice);
		},
	};
}
