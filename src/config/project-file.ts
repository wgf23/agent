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
	type RoomConfig,
	roomConfigSchema,
	validateRoomCoordinator,
	validateRoomMembers,
} from "../rob/room.js";
import { renderRoomOutcome } from "../rob/room-text.js";
import {
	duplicateRobName,
	type RobConfig,
	type RobName,
	robConfigSchema,
} from "../rob/types.js";
import { errorMessage } from "../util/errors.js";

export const PROJECT_FILE_NAME = "my-agent.json";

export type SkillScopeFields = {
	skills?: readonly string[] | undefined;
	skillsConfigured?: boolean | undefined;
};

export type NormalizedSkillScope =
	| { ok: true; skills?: string[]; skillsConfigured?: boolean }
	| { ok: false; error: string };

// Both write paths (create and update) funnel through this, so the invariant
// has exactly one implementation. A skill scope is a list plus a confirmation
// flag, and the pair must never reach storage in a shape that means other than
// what was sent: a bare list with no flag is truth table row 2 — "never
// configured" — which resolves to *every* installed skill. Persisting "no
// skills" that way would widen a bot's scope instead of narrowing it.
//
// A list without a flag is therefore taken as confirmed. Omitting both fields
// stays the only way to say "leave the scope alone", and an explicit
// `skillsConfigured: false` is the way back to the default. A flag with no
// list means nothing on its own, so it is refused rather than guessed at.
export function normalizeSkillScope(
	incoming: SkillScopeFields,
): NormalizedSkillScope {
	if (
		incoming.skillsConfigured !== undefined &&
		incoming.skills === undefined
	) {
		return { ok: false, error: "skillsConfigured requires skills" };
	}
	if (incoming.skills === undefined) return { ok: true };
	return {
		ok: true,
		skills: [...incoming.skills],
		skillsConfigured: incoming.skillsConfigured ?? true,
	};
}

export const robsSchema = z.array(robConfigSchema);
export const roomsSchema = z.array(roomConfigSchema);

/** The one room rule at the file boundary: shape from the schema, then the
 *  shared membership rule against this file's robs, plus the two name
 *  collisions the roster only knows at load time. */
export function parseRooms(
	value: unknown,
	roster: readonly RobName[],
): { ok: true; rooms: RoomConfig[] } | { ok: false; error: string } {
	const parsed = roomsSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}
	const seen = new Set<string>();
	for (const room of parsed.data) {
		if (seen.has(room.name)) {
			return {
				ok: false,
				error: `Duplicate room name "${room.name}". Room names must be unique.`,
			};
		}
		seen.add(room.name);
		if (roster.includes(room.name)) {
			return {
				ok: false,
				error: `Room "${room.name}" cannot use a rob's name.`,
			};
		}
		const members = validateRoomMembers(room.members, roster);
		if (members.status === "rejected") {
			return { ok: false, error: renderRoomOutcome(members, room.name) };
		}
		const coordinator = validateRoomCoordinator(
			room.coordinator,
			members.members,
		);
		if (coordinator.status === "rejected") {
			return { ok: false, error: renderRoomOutcome(coordinator, room.name) };
		}
	}
	return { ok: true, rooms: parsed.data };
}

export const projectFileSchema = z
	.looseObject({
		permissions: permissionRulesSchema.optional(),
		robs: robsSchema.optional(),
		rooms: roomsSchema.optional(),
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
		if (config.rooms === undefined) return;
		const rooms = parseRooms(
			config.rooms,
			(config.robs ?? []).map((rob) => rob.name),
		);
		if (!rooms.ok) {
			ctx.addIssue({
				code: "custom",
				message: `Invalid rooms: ${rooms.error}`,
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
	const scope = normalizeSkillScope(parsedRob.data);
	if (!scope.ok) return { ok: false, error: scope.error };
	// A new bot stores its scope exactly as normalized, so a bare list cannot
	// land on disk meaning "all installed".
	const created: RobConfig =
		scope.skills === undefined
			? parsedRob.data
			: {
					...parsedRob.data,
					skills: scope.skills,
					skillsConfigured: scope.skillsConfigured ?? true,
				};

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
	if (duplicateRobName([...existing.robs, created]) !== undefined) {
		return { ok: false, error: `A rob named "${rob.name}" already exists.` };
	}

	try {
		await writeFile(
			filePath,
			`${JSON.stringify({ ...raw, robs: [...existing.robs, created] }, null, 2)}\n`,
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
	const scope = normalizeSkillScope(incoming);
	if (!scope.ok) return { ok: false, error: scope.error };

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
		// Skill scope and MCP opt-in. Absent fields are left untouched, so a
		// caller that only edits role/model keeps the bot's current scope;
		// `scope` above already rejected a flag with no list and confirmed a
		// list sent without one.
		if (scope.skills !== undefined) {
			merged.skills = scope.skills;
			merged.skillsConfigured = scope.skillsConfigured ?? true;
		}
		// MCP is a patch: absent on create means "no servers", absent on
		// update means "leave the selection alone".
		if (incoming.mcp !== undefined) merged.mcp = incoming.mcp;
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

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
