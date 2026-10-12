import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../util/errors.js";
import {
	discoverSkills,
	listPackageDirs,
	loadSkillPackage,
	type Skill,
} from "./discover.js";
import { skillsRoot } from "./paths.js";

const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_FLAGS = [
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
	"--loglevel=error",
];
const PREFIX_PACKAGE = { name: "my-agent-skills", private: true };
const MAX_BUFFER = 10 * 1024 * 1024;

export type AddSkillResult =
	| { ok: true; skill: Skill }
	| { ok: false; error: string };

export type RemoveSkillResult =
	| { ok: true; skill: Skill }
	| { ok: false; error: string };

export async function addSkill(
	spec: string,
	root: string = skillsRoot(),
): Promise<AddSkillResult> {
	try {
		await ensurePrefix(root);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to prepare the skills directory: ${errorMessage(error)}`,
		};
	}

	const argvSpec = normalizeSpec(spec);
	const before = new Set(await listPackageDirs(root));
	try {
		await runNpm(["install", argvSpec, "--prefix", root, ...NPM_FLAGS], root);
	} catch (error) {
		const afterFailure = await listPackageDirs(root);
		await rollback(
			root,
			undefined,
			afterFailure.filter((dir) => !before.has(dir)),
		);
		return {
			ok: false,
			error: `Failed to install "${spec}": ${npmError(error)}`,
		};
	}

	const after = await listPackageDirs(root);
	const added = after.filter((dir) => !before.has(dir));
	const specDirs = await dirsForSpec(argvSpec, root);
	const candidates = [
		...specDirs,
		...added.filter((d) => !specDirs.includes(d)),
	];

	const errors: string[] = [];
	for (const dir of candidates) {
		const loaded = await loadSkillPackage(dir);
		if (loaded.ok) return { ok: true, skill: loaded.skill };
		errors.push(loaded.error);
	}

	const intended = candidates[0];
	const rollbackDirs = added.length > 0 ? added : intended ? [intended] : [];
	await rollback(root, intended, rollbackDirs);
	return {
		ok: false,
		error: errors[0] ?? `Package "${spec}" is not a valid my-agent skill.`,
	};
}

export async function removeSkill(
	name: string,
	root: string = skillsRoot(),
): Promise<RemoveSkillResult> {
	const skills = await discoverSkills(root);
	const skill = skills.find((candidate) => candidate.name === name);
	if (skill === undefined) {
		return { ok: false, error: `Unknown skill: ${name}` };
	}

	try {
		await runNpm(
			["uninstall", skill.packageName, "--prefix", root, ...NPM_FLAGS],
			root,
		);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to remove "${name}": ${npmError(error)}`,
		};
	}
	return { ok: true, skill };
}

async function ensurePrefix(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	const file = path.join(root, "package.json");
	try {
		await writeFile(file, `${JSON.stringify(PREFIX_PACKAGE, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
	} catch (error) {
		if (!isEexist(error)) throw error;
	}
}

// A failed validation must leave no trace of the package, including any
// transitive dependencies npm hoisted into the prefix.
async function rollback(
	root: string,
	intendedDir: string | undefined,
	dirs: string[],
): Promise<void> {
	if (intendedDir !== undefined) {
		const name = path.relative(path.join(root, "node_modules"), intendedDir);
		try {
			await runNpm(["uninstall", name, "--prefix", root, ...NPM_FLAGS], root);
		} catch {
			// Best effort; the directory removal below still restores the prefix.
		}
	}
	for (const dir of dirs) {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			// Nothing else to do if the path is already gone.
		}
	}
}

async function dirsForSpec(spec: string, root: string): Promise<string[]> {
	const names = await packageNamesForSpec(spec);
	const nodeModules = path.join(root, "node_modules");
	return names.map((name) => path.join(nodeModules, name));
}

async function packageNamesForSpec(spec: string): Promise<string[]> {
	let value = spec;
	if (value.startsWith("file:")) value = value.slice(5);

	if (value.startsWith("/") || value.startsWith(".")) {
		try {
			const text = await readFile(
				path.join(path.resolve(process.cwd(), value), "package.json"),
				"utf8",
			);
			const pkg: unknown = JSON.parse(text);
			if (isRecord(pkg) && typeof pkg.name === "string") return [pkg.name];
		} catch {
			return [];
		}
		return [];
	}

	if (value.startsWith("@")) {
		const slash = value.indexOf("/");
		if (slash === -1) return [];
		const at = value.indexOf("@", slash);
		return [at === -1 ? value : value.slice(0, at)];
	}
	const at = value.indexOf("@");
	return [at === -1 ? value : value.slice(0, at)];
}

// npm resolves relative path specs against its cwd, which is the prefix here,
// so turn path-like specs into absolute paths from the caller's directory.
function normalizeSpec(spec: string): string {
	if (spec.startsWith("file:")) {
		const target = spec.slice(5);
		return path.isAbsolute(target)
			? spec
			: `file:${path.resolve(process.cwd(), target)}`;
	}
	if (spec.startsWith(".") || spec.startsWith("/")) {
		return path.resolve(process.cwd(), spec);
	}
	return spec;
}

function runNpm(args: string[], root: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			NPM_BIN,
			args,
			{
				cwd: root,
				// Keep npm's cache and logs inside the prefix too, so an install
				// cannot create files elsewhere in the home directory.
				env: {
					...process.env,
					npm_config_cache: path.join(root, ".npm"),
					npm_config_update_notifier: "false",
				},
				maxBuffer: MAX_BUFFER,
			},
			(error) => {
				if (error) reject(error);
				else resolve();
			},
		);
	});
}

function npmError(error: unknown): string {
	if (isRecord(error)) {
		const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
		const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
		const text = stderr !== "" ? stderr : stdout;
		if (text !== "") {
			const lines = text.split("\n").filter((line) => line.trim() !== "");
			const last = lines[lines.length - 1] ?? "";
			return last.length > 200 ? `${last.slice(0, 200)}...` : last;
		}
	}
	return errorMessage(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEexist(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}
