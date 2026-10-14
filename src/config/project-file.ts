import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hooksSchema } from "../hooks/hooks.js";
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
		hooks: hooksSchema.optional(),
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

export function setRobWake(
	workspaceRoot: string,
	name: string,
	wake: RobConfig["wake"] | null,
): Promise<WriteResult> {
	const run = writeChain.then(() => writeRobWake(workspaceRoot, name, wake));
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

// Rewrites only the named rob's wake, leaving every other key and every other
// rob byte-for-byte intact. A rob the file does not name is an error: the
// schedule is config-owned, so there is nothing to arm from a missing entry.
async function writeRobWake(
	workspaceRoot: string,
	name: string,
	wake: RobConfig["wake"] | null,
): Promise<WriteResult> {
	const filePath = projectFilePath(workspaceRoot);

	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: false, error: `Unknown rob: ${name}` };
		return {
			ok: false,
			error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

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
	const raw = parsedJson as Record<string, unknown>;
	const robs = Array.isArray(raw.robs) ? raw.robs : [];

	let found = false;
	const nextRobs = robs.map((entry) => {
		if (typeof entry !== "object" || entry === null) return entry;
		const rob = entry as Record<string, unknown>;
		if (rob.name !== name) return rob;
		found = true;
		const copy = { ...rob };
		if (wake === null || wake === undefined) delete copy.wake;
		else copy.wake = { everyMs: wake.everyMs, prompt: wake.prompt };
		return copy;
	});
	if (!found) return { ok: false, error: `Unknown rob: ${name}` };

	const nextRaw = { ...raw, robs: nextRobs };
	const validated = projectFileSchema.safeParse(nextRaw);
	if (!validated.success) {
		return {
			ok: false,
			error: `Invalid ${PROJECT_FILE_NAME}: ${z.prettifyError(validated.error)}`,
		};
	}

	try {
		await writeFile(filePath, `${JSON.stringify(nextRaw, null, 2)}\n`, "utf8");
	} catch (error) {
		return {
			ok: false,
			error: `Failed to write ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}
	return { ok: true };
}

export function updateRob(
	workspaceRoot: string,
	name: string,
	next: RobConfig,
): Promise<WriteResult> {
	const run = writeChain.then(() => writeRobUpdate(workspaceRoot, name, next));
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

// Replaces the named rob's role, model, and backend in place and leaves every
// key it does not own byte-for-byte intact: permissions, unknown fields, and the
// wake the schedule owns (unless the replacement carries its own). A name the
// file does not carry is an error, mirroring writeRobWake.
async function writeRobUpdate(
	workspaceRoot: string,
	name: string,
	next: RobConfig,
): Promise<WriteResult> {
	const parsedNext = robConfigSchema.safeParse(next);
	if (!parsedNext.success) {
		return { ok: false, error: z.prettifyError(parsedNext.error) };
	}
	const incoming = parsedNext.data;

	const filePath = projectFilePath(workspaceRoot);

	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: false, error: `Unknown rob: ${name}` };
		return {
			ok: false,
			error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

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
	const raw = parsedJson as Record<string, unknown>;
	const robs = Array.isArray(raw.robs) ? raw.robs : [];

	let found = false;
	const nextRobs = robs.map((entry) => {
		if (typeof entry !== "object" || entry === null) return entry;
		const rob = entry as Record<string, unknown>;
		if (rob.name !== name) return rob;
		found = true;
		const merged: Record<string, unknown> = { ...rob, role: incoming.role };
		if (incoming.model === undefined) delete merged.model;
		else merged.model = incoming.model;
		if (incoming.backend === undefined) delete merged.backend;
		else merged.backend = incoming.backend;
		if (incoming.permissions !== undefined) {
			merged.permissions = incoming.permissions;
		}
		if (incoming.wake !== undefined) {
			merged.wake = {
				everyMs: incoming.wake.everyMs,
				prompt: incoming.wake.prompt,
			};
		}
		return merged;
	});
	if (!found) return { ok: false, error: `Unknown rob: ${name}` };

	const nextRaw = { ...raw, robs: nextRobs };
	const validated = projectFileSchema.safeParse(nextRaw);
	if (!validated.success) {
		return {
			ok: false,
			error: `Invalid ${PROJECT_FILE_NAME}: ${z.prettifyError(validated.error)}`,
		};
	}

	try {
		await writeFile(filePath, `${JSON.stringify(nextRaw, null, 2)}\n`, "utf8");
	} catch (error) {
		return {
			ok: false,
			error: `Failed to write ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}
	return { ok: true };
}

export function removeRob(
	workspaceRoot: string,
	name: string,
): Promise<WriteResult> {
	const run = writeChain.then(() => writeRobRemoval(workspaceRoot, name));
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

// Drops exactly the named rob and leaves every other key and every other rob
// byte-for-byte intact. A name the file does not carry is an error: re-adding
// the same name is the only way to get it back.
async function writeRobRemoval(
	workspaceRoot: string,
	name: string,
): Promise<WriteResult> {
	const filePath = projectFilePath(workspaceRoot);

	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: false, error: `Unknown rob: ${name}` };
		return {
			ok: false,
			error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

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
	const raw = parsedJson as Record<string, unknown>;
	const robs = Array.isArray(raw.robs) ? raw.robs : [];

	let found = false;
	const nextRobs = robs.filter((entry) => {
		if (typeof entry !== "object" || entry === null) return true;
		const rob = entry as Record<string, unknown>;
		if (rob.name !== name) return true;
		found = true;
		return false;
	});
	if (!found) return { ok: false, error: `Unknown rob: ${name}` };

	try {
		await writeFile(
			filePath,
			`${JSON.stringify({ ...raw, robs: nextRobs }, null, 2)}\n`,
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

export type MigrateRobsResult =
	| { ok: true; migrated: number }
	| { ok: false; error: string };

// The web Bot surface is native-only, so a `cli` rob written by an older
// config is rewritten to the built-in backend when the server opens the
// workspace. Every other key and every other rob is preserved; a missing file
// or a file with no cli rob is a no-op that writes nothing.
export function migrateRobsToNative(
	workspaceRoot: string,
): Promise<MigrateRobsResult> {
	const run = writeChain.then(() => migrateRobs(workspaceRoot));
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function migrateRobs(workspaceRoot: string): Promise<MigrateRobsResult> {
	const filePath = projectFilePath(workspaceRoot);

	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: true, migrated: 0 };
		return {
			ok: false,
			error: `Failed to read ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}

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
	const raw = parsedJson as Record<string, unknown>;
	const robs = Array.isArray(raw.robs) ? raw.robs : [];

	let migrated = 0;
	const nextRobs = robs.map((entry) => {
		if (typeof entry !== "object" || entry === null) return entry;
		const rob = entry as Record<string, unknown>;
		const backend = rob.backend as { kind?: unknown } | undefined;
		if (backend?.kind !== "cli") return rob;
		migrated += 1;
		// Replacing the whole backend drops the cli-only fields (command,
		// provider, model, sessionDir) along with the kind.
		return { ...rob, backend: { kind: "native" } };
	});
	if (migrated === 0) return { ok: true, migrated: 0 };

	const nextRaw = { ...raw, robs: nextRobs };
	const validated = projectFileSchema.safeParse(nextRaw);
	if (!validated.success) {
		return {
			ok: false,
			error: `Invalid ${PROJECT_FILE_NAME}: ${z.prettifyError(validated.error)}`,
		};
	}

	try {
		await writeFile(filePath, `${JSON.stringify(nextRaw, null, 2)}\n`, "utf8");
	} catch (error) {
		return {
			ok: false,
			error: `Failed to write ${PROJECT_FILE_NAME}: ${errorMessage(error)}`,
		};
	}
	return { ok: true, migrated };
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
