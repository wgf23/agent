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
import {
	duplicateRobName,
	type RobConfig,
	robConfigSchema,
} from "../rob/types.js";
import { errorMessage } from "../util/errors.js";

export const PROJECT_FILE_NAME = "my-agent.json";

export const robsSchema = z.array(robConfigSchema);

export const projectFileSchema = z
	.looseObject({
		permissions: permissionRulesSchema.optional(),
		robs: robsSchema.optional(),
	})
	.superRefine((config, ctx) => {
		const duplicate = duplicateRobName(config.robs ?? []);
		if (duplicate !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: `Duplicate rob name "${duplicate}". Rob names must be unique.`,
			});
		}
	});
export type ProjectConfig = z.infer<typeof projectFileSchema>;

export function parseRobs(
	value: unknown,
): { ok: true; robs: RobConfig[] } | { ok: false; error: string } {
	const parsed = robsSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}
	const duplicate = duplicateRobName(parsed.data);
	if (duplicate !== undefined) {
		return {
			ok: false,
			error: `Duplicate rob name "${duplicate}". Rob names must be unique.`,
		};
	}
	return { ok: true, robs: parsed.data };
}

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

let writeChain: Promise<unknown> = Promise.resolve();

// Two robs can answer allow_always at the same moment, so the whole
// read-merge-write runs one call at a time or the second clobbers the first.
export function addPermissionRule(
	workspaceRoot: string,
	toolName: string,
	pattern: string,
	action: Action,
): Promise<WriteResult> {
	const run = writeChain.then(() =>
		writePermissionRule(workspaceRoot, toolName, pattern, action),
	);
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function writePermissionRule(
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

export function addRob(
	workspaceRoot: string,
	rob: RobConfig,
): Promise<WriteResult> {
	const run = writeChain.then(() => writeRob(workspaceRoot, rob));
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

// Appends one rob and leaves every other key (permissions, unknown fields)
// untouched. Sharing writeChain with addPermissionRule keeps both writers from
// clobbering each other's read-merge-write.
async function writeRob(
	workspaceRoot: string,
	rob: RobConfig,
): Promise<WriteResult> {
	const parsedRob = robConfigSchema.safeParse(rob);
	if (!parsedRob.success) {
		return { ok: false, error: z.prettifyError(parsedRob.error) };
	}

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

	const existing =
		raw.robs === undefined
			? { ok: true as const, robs: [] }
			: parseRobs(raw.robs);
	if (!existing.ok) return { ok: false, error: existing.error };
	if (duplicateRobName([...existing.robs, parsedRob.data]) !== undefined) {
		return { ok: false, error: `A rob named "${rob.name}" already exists.` };
	}

	try {
		await writeFile(
			filePath,
			`${JSON.stringify({ ...raw, robs: [...existing.robs, parsedRob.data] }, null, 2)}\n`,
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
