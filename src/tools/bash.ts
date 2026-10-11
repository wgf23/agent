import { spawn } from "node:child_process";
import { z } from "zod";
import { truncateOutput } from "../util/truncate.js";
import type { Tool, ToolContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const schema = z
	.object({
		command: z.string().describe("Shell command to run."),
		timeout_ms: z
			.number()
			.int()
			.min(1)
			.max(MAX_TIMEOUT_MS)
			.default(DEFAULT_TIMEOUT_MS)
			.describe("Kill the command after this many milliseconds."),
	})
	.strict();

interface CommandOutcome {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export const bashTool: Tool<typeof schema> = {
	name: "bash",
	description:
		"Run a shell command in the workspace root. Returns combined stdout and stderr plus the exit code.",
	readOnly: false,
	schema,
	async execute(args, ctx) {
		if (ctx.signal?.aborted) {
			return { ok: false, error: "bash: command aborted before it started" };
		}

		const outcome = await runCommand(args.command, args.timeout_ms, ctx);
		const text = truncateOutput(outcome.output).text;

		if (outcome.aborted) {
			return { ok: false, error: `bash: command aborted\n${text}` };
		}
		if (outcome.timedOut) {
			return {
				ok: false,
				error: `bash: command timed out after ${args.timeout_ms}ms\n${text}`,
			};
		}
		if (outcome.exitCode !== 0) {
			return {
				ok: false,
				error: `bash: exit code ${outcome.exitCode}\n${text}`,
			};
		}
		return { ok: true, output: text };
	},
};

function runCommand(
	command: string,
	timeoutMs: number,
	ctx: ToolContext,
): Promise<CommandOutcome> {
	return new Promise((resolve) => {
		// A shell wrapper means the real command is a grandchild. `detached` puts the
		// shell and its descendants in one process group so the timeout can kill them all.
		const child = spawn(command, {
			shell: true,
			cwd: ctx.workspaceRoot,
			detached: process.platform !== "win32",
		});
		let output = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});

		const kill = () => {
			if (child.pid === undefined) return;
			// Windows has no process group here; taskkill walks the child tree.
			// spawn reports a missing taskkill through its error event, not a throw.
			if (process.platform === "win32") {
				const killer = spawn(
					"taskkill",
					["/pid", String(child.pid), "/T", "/F"],
					{ stdio: "ignore" },
				);
				killer.on("error", () => child.kill());
				return;
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);

		const onAbort = () => {
			aborted = true;
			kill();
		};
		ctx.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
			resolve({ output, exitCode, timedOut, aborted });
		};

		child.on("error", (error) => {
			output += error.message;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}
