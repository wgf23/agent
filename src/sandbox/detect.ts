import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { ensureHelperFile, helperFilePath } from "./landlock.js";
import { ensureWindowsHelperFile } from "./windows.js";

export type BackendPlan =
	| { backend: "bwrap" }
	| { backend: "landlock"; python: string }
	| { backend: "windows"; pwsh: string }
	| { backend: "none"; reason: string };

export interface DetectProbes {
	platform: NodeJS.Platform;
	bwrap(): Promise<boolean>;
	python(): Promise<string | null>;
	landlockAbi(python: string): Promise<number | null>;
	pwsh(): Promise<string | null>;
	powershell(): Promise<string | null>;
	windowsHelper(): Promise<boolean>;
}

const NONE_REASON = "no bubblewrap binary and no Landlock-capable python3";
const WINDOWS_NONE_REASON = "no pwsh or powershell.exe on PATH";
const WINDOWS_HELPER_REASON = "could not write the Windows sandbox helper";

// Keyed by probe object so the real probes are detected once per process while
// tests with their own probes stay isolated.
const cache = new WeakMap<DetectProbes, Promise<BackendPlan>>();

export function detectBackends(probe: DetectProbes): Promise<BackendPlan> {
	const cached = cache.get(probe);
	if (cached !== undefined) return cached;
	const result = choose(probe);
	cache.set(probe, result);
	return result;
}

async function choose(probe: DetectProbes): Promise<BackendPlan> {
	if (probe.platform === "win32") return chooseWindows(probe);
	if (await probe.bwrap()) return { backend: "bwrap" };
	const python = await probe.python();
	if (python !== null) {
		const abi = await probe.landlockAbi(python);
		if (abi !== null && abi >= 1) return { backend: "landlock", python };
	}
	return { backend: "none", reason: NONE_REASON };
}

async function chooseWindows(probe: DetectProbes): Promise<BackendPlan> {
	const pwsh = await probe.pwsh();
	const shell = pwsh !== null ? pwsh : await probe.powershell();
	if (shell === null) return { backend: "none", reason: WINDOWS_NONE_REASON };
	if (!(await probe.windowsHelper())) {
		return { backend: "none", reason: WINDOWS_HELPER_REASON };
	}
	return { backend: "windows", pwsh: shell };
}

export const systemProbes: DetectProbes = {
	platform: process.platform,
	bwrap: async () => findExecutable("bwrap") !== null,
	python: async () => findExecutable("python3"),
	landlockAbi: async (python) => {
		try {
			await ensureHelperFile();
		} catch {
			return null;
		}
		const probe = spawnSync(python, [helperFilePath(), "--probe"], {
			encoding: "utf8",
		});
		if (probe.error !== undefined || probe.status !== 0) return null;
		const abi = Number.parseInt(probe.stdout.trim(), 10);
		return Number.isInteger(abi) ? abi : null;
	},
	pwsh: async () => findExecutable("pwsh"),
	powershell: async () => findExecutable("powershell.exe"),
	windowsHelper: async () => {
		try {
			await ensureWindowsHelperFile();
			return true;
		} catch {
			return false;
		}
	},
};

function findExecutable(name: string): string | null {
	const pathValue = process.env.PATH;
	if (pathValue === undefined) return null;
	for (const dir of pathValue.split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here; keep looking.
		}
	}
	return null;
}
