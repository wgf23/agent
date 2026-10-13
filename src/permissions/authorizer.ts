import type { Authorize } from "../agent/authorize.js";
import { addPermissionRule } from "../config/project-file.js";
import type { AllowAll } from "./allow-all.js";
import { isDangerousCommand } from "./dangerous.js";
import {
	mergeRule,
	type PermissionRules,
	type RuleEntry,
	resolveAction,
	toolSubject,
} from "./rules.js";

export type ApprovalChoice = "allow_once" | "allow_always" | "deny";

export interface ApprovalRequest {
	toolName: string;
	subject: string;
	dangerous: boolean;
	rule: string | null;
}

export type ApprovalDecision = ApprovalChoice | { deny: string };

export type Approval = (
	request: ApprovalRequest,
) => Promise<ApprovalDecision> | ApprovalDecision;

export interface AuthorizerOptions {
	workspaceRoot: string;
	rules: PermissionRules;
	approval: Approval;
	yesAll: boolean;
	allowAll?: AllowAll;
	onAutoApproved?: (request: ApprovalRequest) => void;
}

export function createAuthorizer(options: AuthorizerOptions): Authorize {
	const rules: PermissionRules = { ...options.rules };

	return async (call, tool) => {
		const subject = toolSubject(call.name, call.args);
		const action = resolveAction(rules, call.name, subject);

		if (tool.readOnly && action === "allow") {
			return { allowed: true };
		}

		if (action === "deny") {
			return {
				allowed: false,
				reason: `Denied by rule for ${call.name} ${subject}.`,
			};
		}

		const dangerous = call.name === "bash" && isDangerousCommand(subject);
		const pattern = rulePattern(call.name, subject);

		if (action === "allow" && !dangerous) {
			return { allowed: true };
		}

		const request = {
			toolName: call.name,
			subject,
			dangerous,
			rule: dangerous ? null : pattern,
		};

		if (options.yesAll) {
			await options.approval(request);
			return { allowed: true };
		}

		if (options.allowAll?.get() === true) {
			if (dangerous) options.onAutoApproved?.(request);
			return { allowed: true };
		}

		const decision = await options.approval(request);

		if (typeof decision === "object") {
			return { allowed: false, reason: decision.deny };
		}
		if (decision === "deny") {
			return {
				allowed: false,
				reason: `The user denied ${call.name} ${subject}.`,
			};
		}
		if (decision === "allow_once") {
			return { allowed: true };
		}

		// A dangerous call can never be remembered as a standing rule.
		if (dangerous) {
			return { allowed: true };
		}

		const entry: RuleEntry = { pattern, action: "allow" };
		await addPermissionRule(options.workspaceRoot, call.name, pattern, "allow");
		rules[call.name] = mergeRule(rules[call.name], entry);
		return { allowed: true, remember: true };
	};
}

export interface HeadlessApprovalOptions {
	yesAll: boolean;
	log: (line: string) => void;
}

export function headlessApproval(options: HeadlessApprovalOptions): Approval {
	const { log } = options;

	return (request) => {
		if (!options.yesAll) {
			log(`[approval] ${request.toolName} ${request.subject} denied\n`);
			return {
				deny: `Approval required for ${request.toolName} ${request.subject}. Re-run with --yes to approve.`,
			};
		}
		const danger = request.dangerous ? " (dangerous)" : "";
		log(
			`[approval] ${request.toolName} ${request.subject} approved by --yes${danger}\n`,
		);
		return "allow_once";
	};
}

export function autoApprovedLine(request: ApprovalRequest): string {
	return `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`;
}

function rulePattern(toolName: string, subject: string): string {
	if (toolName !== "bash") return subject;
	const first = subject.trim().split(/\s+/)[0];
	if (first === undefined || first === "") return subject;
	return `${first} *`;
}
