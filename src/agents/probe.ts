import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { NPM_BIN } from "../util/npm.js";
import { killProcessGroup } from "../util/process.js";
import { resolveCommand } from "../util/which.js";

export type ProbeResult =
	| { ok: true; version: string | null; path: string }
	| {
			ok: false;
			kind: "not_found" | "timeout" | "spawn_failed";
			error: string;
	  };

export type Probe = (command: string) => Promise<ProbeResult>;

export interface ProbeOptions {
	timeoutMs?: number;
	pathEnv?: string;
	platform?: NodeJS.Platform;
}

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

// Resolves the command to an absolute path and runs `<path> --version` with no
// shell. The first non-empty stdout line is the version, verbatim; a command
// that runs but prints nothing is still installed, with a null version. A
// timeout kills the whole process group and resolves instead of throwing, and a
// missing command is `not_found` rather than a raw spawn error.
export async function probeVersion(
	command: string,
	options: ProbeOptions = {},
): Promise<ProbeResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const platform = options.platform ?? process.platform;
	const pathEnv = options.pathEnv ?? process.env.PATH;
	const resolved = resolveCommand(command, pathEnv, platform);
	if (resolved === undefined) {
		return {
			ok: false,
			kind: "not_found",
			error: `Cannot find "${command}" on PATH.`,
		};
	}

	return new Promise<ProbeResult>((resolve) => {
		let settled = false;
		let buffer = "";
		let timer: NodeJS.Timeout | undefined;

		const child = spawn(resolved, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		const finish = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(result);
		};

		const firstLine = (): string | null => {
			for (const line of buffer.split("\n")) {
				const value = line.replace(/\r$/, "");
				if (value.trim() !== "") return value;
			}
			return null;
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
		});

		// Drain stderr so a chatty binary cannot fill the pipe and deadlock.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => {});

		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				ok: false,
				kind: "spawn_failed",
				error: spawnMessage(command, error),
			});
		});

		child.on("close", () => {
			finish({ ok: true, version: firstLine(), path: resolved });
		});

		timer = setTimeout(() => {
			killProcessGroup(child);
			finish({
				ok: false,
				kind: "timeout",
				error: `"${command} --version" timed out after ${timeoutMs}ms.`,
			});
		}, timeoutMs);
	});
}

export interface NpmGlobalBinDirOptions {
	command?: string;
	platform?: NodeJS.Platform;
}

// The directory npm links global package bins into: `<prefix>/bin` on posix and
// `<prefix>` on Windows. Resolve the prefix by running `npm prefix -g`, never a
// shell; any failure (no npm, non-zero exit) means there is no known directory.
export async function npmGlobalBinDir(
	options: NpmGlobalBinDirOptions = {},
): Promise<string | null> {
	const command = options.command ?? NPM_BIN;
	const platform = options.platform ?? process.platform;
	const prefix = await readPrefix(command);
	if (prefix === null) return null;
	return platform === "win32" ? prefix : path.join(prefix, "bin");
}

function readPrefix(command: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			command,
			["prefix", "-g"],
			{ encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const line = stdout
					.split("\n")
					.map((entry) => entry.trim())
					.find((entry) => entry !== "");
				resolve(line ?? null);
			},
		);
	});
}

function spawnMessage(command: string, error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") {
		return `Cannot start "${command}": command not found on PATH. Install it, or set this bot's backend to native.`;
	}
	return `Failed to start "${command}": ${error.message}`;
}
