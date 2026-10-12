import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../util/errors.js";
import { PathEscapeError, resolveInWorkspace } from "../util/paths.js";
import { parseFrontmatter } from "./frontmatter.js";
import { skillsRoot } from "./paths.js";

export const SKILL_FILENAME = "SKILL.md";
export const SKILL_PACKAGE_FIELD = "my-agent-skill";

export interface Skill {
	name: string;
	description: string;
	packageName: string;
	version: string;
	dir: string;
}

export type LoadSkillResult =
	| { ok: true; skill: Skill }
	| { ok: false; error: string };

export async function loadSkillPackage(
	packageDir: string,
): Promise<LoadSkillResult> {
	const fallbackName = path.basename(packageDir);

	let text: string;
	try {
		text = await readFile(path.join(packageDir, "package.json"), "utf8");
	} catch {
		return {
			ok: false,
			error: `Package "${fallbackName}" has no package.json.`,
		};
	}

	let pkg: unknown;
	try {
		pkg = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			error: `Package "${fallbackName}" has invalid package.json: ${errorMessage(error)}`,
		};
	}
	if (!isRecord(pkg)) {
		return {
			ok: false,
			error: `Package "${fallbackName}" has invalid package.json.`,
		};
	}

	const packageName = typeof pkg.name === "string" ? pkg.name : fallbackName;
	const version = typeof pkg.version === "string" ? pkg.version : "";
	const field = pkg[SKILL_PACKAGE_FIELD];
	if (field === undefined) {
		return {
			ok: false,
			error: `Package "${packageName}" does not declare a "${SKILL_PACKAGE_FIELD}" field.`,
		};
	}
	if (typeof field !== "string" || field.trim() === "") {
		return {
			ok: false,
			error: `Package "${packageName}" has an invalid "${SKILL_PACKAGE_FIELD}" field.`,
		};
	}

	let skillDir: string;
	try {
		skillDir = resolveInWorkspace(packageDir, field);
	} catch {
		return {
			ok: false,
			error: `Package "${packageName}" points "${SKILL_PACKAGE_FIELD}" outside the package.`,
		};
	}

	let skillText: string;
	let skillFile: string;
	try {
		skillFile = resolveInWorkspace(skillDir, SKILL_FILENAME);
		skillText = await readFile(skillFile, "utf8");
	} catch (error) {
		if (error instanceof PathEscapeError) {
			return {
				ok: false,
				error: `Package "${packageName}" has an unsafe ${SKILL_FILENAME} path.`,
			};
		}
		return {
			ok: false,
			error: `Package "${packageName}" has no ${SKILL_FILENAME} at "${field}".`,
		};
	}

	const parsed = parseFrontmatter(skillText);
	if (!parsed.ok) {
		return {
			ok: false,
			error: `Package "${packageName}" has an invalid ${SKILL_FILENAME}: ${parsed.error}`,
		};
	}

	return {
		ok: true,
		skill: {
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			packageName,
			version,
			dir: skillDir,
		},
	};
}

export async function discoverSkills(
	root: string = skillsRoot(),
): Promise<Skill[]> {
	let dirs: string[];
	try {
		dirs = await listPackageDirs(root);
	} catch {
		// An unreadable node_modules means no discoverable skills. A missing one
		// is already handled in listPackageDirs, so this covers the rest such as
		// permissions and a non-directory entry.
		return [];
	}
	const skills: Skill[] = [];
	for (const dir of dirs) {
		const loaded = await loadSkillPackage(dir);
		if (loaded.ok) skills.push(loaded.skill);
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPackageDirs(root: string): Promise<string[]> {
	const nodeModules = path.join(root, "node_modules");
	let entries: string[];
	try {
		entries = await readdir(nodeModules);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const full = path.join(nodeModules, entry);
		if (entry.startsWith("@")) {
			for (const child of await readScoped(full)) {
				if (child.startsWith(".")) continue;
				dirs.push(path.join(full, child));
			}
			continue;
		}
		dirs.push(full);
	}
	return dirs;
}

async function readScoped(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
