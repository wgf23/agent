import os from "node:os";
import { bwrapArgv } from "./bwrap.js";
import type { BackendPlan } from "./detect.js";
import { landlockArgv } from "./landlock.js";

export type SandboxMode = "auto" | "require" | "off";

export interface SandboxSettings {
	mode: SandboxMode;
	network: boolean;
	writablePaths: string[];
}

export const DEFAULT_SANDBOX: SandboxSettings = {
	mode: "auto",
	// Network is on by default: the sandbox's job is to bound the filesystem, and
	// a sandboxed `bash` that cannot reach the network breaks ordinary work such
	// as `npm install` or `git fetch`. Set `sandbox.network` to false to deny TCP.
	network: true,
	writablePaths: [],
};

export interface SandboxExec {
	argv: string[];
	env: Record<string, string>;
}

export type SandboxPlan =
	| { run: true; argv: string[]; env: Record<string, string>; warning?: string }
	| { run: false; reason: string };

export interface PlanSandboxedBashInput {
	command: string;
	workspaceRoot: string;
	settings: SandboxSettings;
	plan: BackendPlan;
}

// The bash tool resolves settings and probes backends, then hands both to this
// pure policy function. Tests inject a BashPlanFn instead of doing either.
export type BashPlanFn = (input: {
	command: string;
	workspaceRoot: string;
}) => Promise<SandboxPlan> | SandboxPlan;

export const NO_BACKEND_REASON =
	'Sandboxing is required (sandbox.mode = "require") but no sandbox backend is available. Install bubblewrap, or set sandbox.mode to "auto" or "off".';

export function planSandboxedBash(input: PlanSandboxedBashInput): SandboxPlan {
	const { command, workspaceRoot, settings, plan } = input;

	if (settings.mode === "off") {
		return { run: true, ...unsandboxed(command) };
	}

	if (plan.backend === "none") {
		if (settings.mode === "require") {
			return { run: false, reason: NO_BACKEND_REASON };
		}
		return {
			run: true,
			...unsandboxed(command),
			warning: `sandbox unavailable: ${plan.reason}; running unsandboxed`,
		};
	}

	const writableRoots = [workspaceRoot, os.tmpdir(), ...settings.writablePaths];
	if (plan.backend === "bwrap") {
		return {
			run: true,
			...bwrapArgv({
				command,
				workspaceRoot,
				writableRoots,
				network: settings.network,
			}),
		};
	}
	return {
		run: true,
		...landlockArgv({
			command,
			python: plan.python,
			writableRoots,
			network: settings.network,
		}),
	};
}

function unsandboxed(command: string): SandboxExec {
	if (process.platform === "win32") {
		return {
			argv: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command],
			env: {},
		};
	}
	return { argv: ["/bin/sh", "-c", command], env: {} };
}
