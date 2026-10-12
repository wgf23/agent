import { z } from "zod";

export const actionSchema = z.enum(["allow", "ask", "deny"]);
export type Action = z.infer<typeof actionSchema>;

export const ruleEntrySchema = z.object({
	pattern: z.string(),
	action: actionSchema,
});
export type RuleEntry = z.infer<typeof ruleEntrySchema>;

export const toolRuleSchema = z.union([actionSchema, z.array(ruleEntrySchema)]);
export type ToolRule = z.infer<typeof toolRuleSchema>;

export const permissionRulesSchema = z.record(z.string(), toolRuleSchema);
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

const DEFAULTS: PermissionRules = {
	read_file: "allow",
	glob: "allow",
	grep: "allow",
	write_file: "ask",
	edit_file: "ask",
	bash: "ask",
	task: "ask",
};

export function defaultRules(): PermissionRules {
	return { ...DEFAULTS };
}

export function resolveAction(
	rules: PermissionRules,
	toolName: string,
	subject: string,
): Action {
	const rule = rules[toolName];
	if (rule === undefined) return defaultAction(toolName);
	if (typeof rule === "string") return rule;
	for (const entry of rule) {
		if (matchesPattern(entry.pattern, subject)) return entry.action;
	}
	return defaultAction(toolName);
}

export function matchesPattern(pattern: string, subject: string): boolean {
	const segments = pattern.split("*");
	let position = 0;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (index === 0) {
			if (!subject.startsWith(segment)) return false;
			position = segment.length;
			continue;
		}
		if (index === segments.length - 1) {
			if (!subject.endsWith(segment)) return false;
			return position <= subject.length - segment.length;
		}
		const found = subject.indexOf(segment, position);
		if (found === -1) return false;
		position = found + segment.length;
	}
	return position === subject.length;
}

export function mergeRule(
	existing: ToolRule | undefined,
	entry: RuleEntry,
): ToolRule {
	if (existing === undefined) return [entry];
	if (Array.isArray(existing)) {
		const index = existing.findIndex(
			(candidate) => candidate.pattern === entry.pattern,
		);
		if (index === -1) return [...existing, entry];
		return existing.map((candidate, position) =>
			position === index ? entry : candidate,
		);
	}
	// A scalar rule has no pattern to preserve, so keep it as a trailing catch-all
	// that the new, more specific pattern takes precedence over.
	return [entry, { pattern: "*", action: existing }];
}

export function toolSubject(toolName: string, args: unknown): string {
	const record = isRecord(args) ? args : {};
	switch (toolName) {
		case "bash":
			return stringValue(record.command);
		case "read_file":
		case "write_file":
		case "edit_file":
			return stringValue(record.path);
		case "glob":
		case "grep":
			return stringValue(record.pattern);
		default:
			return "";
	}
}

function defaultAction(toolName: string): Action {
	const rule = DEFAULTS[toolName];
	if (rule === undefined || Array.isArray(rule)) return "ask";
	return rule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}
