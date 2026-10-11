import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
	type Action,
	mergeRule,
	type PermissionRules,
	permissionRulesSchema,
	type RuleEntry,
} from "../permissions/rules.js";
import { errorMessage } from "../util/errors.js";

export const PROJECT_FILE_NAME = "my-agent.json";

export const projectFileSchema = z.looseObject({
	permissions: permissionRulesSchema.optional(),
});
export type ProjectConfig = z.infer<typeof projectFileSchema>;

export type ProjectConfigResult =
	| { ok: true; config: ProjectConfig }
	| { ok: false; error: string };

export type WriteResult = { ok: true } | { ok: false; error: string };

export function projectFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, PROJECT_FILE_NAME);
}

export async function readProjectConfig(
	workspaceRoot: string,
): Promise<ProjectConfigResult> {
	const filePath = projectFilePath(workspaceRoot);

	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: true, config: {} };
		return {
			ok: false,
			error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON in ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

	const parsed = projectFileSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid ${PROJECT_FILE_NAME}: ${z.prettifyError(parsed.error)}`,
		};
	}
	return { ok: true, config: parsed.data };
}

export async function addPermissionRule(
	workspaceRoot: string,
	toolName: string,
	pattern: string,
	action: Action,
): Promise<WriteResult> {
	const filePath = projectFilePath(workspaceRoot);

	let raw: Record<string, unknown> = {};
	try {
		const text = await readFile(filePath, "utf8");
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(text);
		} catch (error) {
			return {
				ok: false,
				error: `Invalid JSON in ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
			};
		}
		const parsed = projectFileSchema.safeParse(parsedJson);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid ${PROJECT_FILE_NAME}: ${z.prettifyError(parsed.error)}`,
			};
		}
		raw = parsedJson as Record<string, unknown>;
	} catch (error) {
		if (!isEnoent(error)) {
			return {
				ok: false,
				error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
			};
		}
	}

	const permissions = (raw.permissions ?? {}) as PermissionRules;
	const entry: RuleEntry = { pattern, action };
	const next: PermissionRules = {
		...permissions,
		[toolName]: mergeRule(permissions[toolName], entry),
	};

	try {
		await writeFile(
			filePath,
			`${JSON.stringify({ ...raw, permissions: next }, null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to write ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}
	return { ok: true };
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
