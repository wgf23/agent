import { spawn } from "node:child_process";
import { NPM_BIN, NPM_FLAGS, npmError } from "../util/npm.js";
import { killProcessGroup } from "../util/process.js";

export type NpmResult =
	| { ok: true }
	| { ok: false; error: string; cancelled: boolean };

export interface NpmOptions {
	// Called once per non-empty stdout or stderr line, in arrival order.
	onOutput?: (line: string) => void;
	// Aborting kills the whole npm process group and resolves cancelled.
	signal?: AbortSignal;
	// Kills a hung npm after this many milliseconds and resolves failed.
	timeoutMs?: number;
}

const CANCEL_MESSAGE = "The npm install was cancelled.";

// Runs a global npm install as a streaming job. stderr is folded into the same
// line stream as stdout so progress is visible in order. `--ignore-scripts` is
// deliberately absent: these CLIs create their bin shims in postinstall.
export function npmInstallGlobal(
	pkg: string,
	options: NpmOptions = {},
): Promise<NpmResult> {
	return new Promise<NpmResult>((resolve) => {
		const args = ["install", "-g", ...NPM_FLAGS, "--", pkg];
		const timeoutMs = options.timeoutMs;
		const child = spawn(NPM_BIN, args, {
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		let settled = false;
		let cancelled = false;
		let timedOut = false;
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let timer: NodeJS.Timeout | undefined;

		const finish = (result: NpmResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const emitLine = (line: string): void => {
			const value = line.replace(/\r$/, "");
			if (value !== "") options.onOutput?.(value);
		};

		const push = (chunk: string): void => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				emitLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			push(chunk);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			push(chunk);
		});

		const onAbort = (): void => {
			cancelled = true;
			killProcessGroup(child);
		};
		if (options.signal !== undefined) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		if (timeoutMs !== undefined && timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				killProcessGroup(child);
			}, timeoutMs);
		}

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (cancelled) {
				finish({ ok: false, error: CANCEL_MESSAGE, cancelled: true });
				return;
			}
			finish({ ok: false, error: spawnMessage(error), cancelled: false });
		});

		child.on("close", (code) => {
			if (buffer !== "") emitLine(buffer);
			if (cancelled) {
				finish({ ok: false, error: CANCEL_MESSAGE, cancelled: true });
				return;
			}
			if (timedOut) {
				finish({
					ok: false,
					error: `npm install timed out after ${String(timeoutMs)}ms.`,
					cancelled: false,
				});
				return;
			}
			if (code === 0) {
				finish({ ok: true });
				return;
			}
			finish({
				ok: false,
				error: npmError({ stderr, stdout }),
				cancelled: false,
			});
		});
	});
}

function spawnMessage(error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") {
		return `Cannot start "${NPM_BIN}": npm is not on PATH. Install Node.js (which includes npm) first.`;
	}
	return `Failed to start "${NPM_BIN}": ${error.message}`;
}
