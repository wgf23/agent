import { spawn } from "node:child_process";
import { z } from "zod";
import { matchesPattern } from "../permissions/rules.js";
import { errorMessage } from "../util/errors.js";

export const hookEntrySchema = z.object({
	match: z.string().min(1),
	command: z.string().min(1),
});
export type HookEntry = z.infer<typeof hookEntrySchema>;

export const hooksSchema = z.object({
	preToolUse: z.array(hookEntrySchema).optional(),
	postToolUse: z.array(hookEntrySchema).optional(),
});
export type HooksConfig = z.infer<typeof hooksSchema>;

export type HookName = "preToolUse" | "postToolUse";

export interface HookInput {
	hook: HookName;
	tool: string;
	args: unknown;
}

export type HookOutcome =
	| { kind: "exit"; code: number | null; stdout: string; stderr: string }
	| { kind: "spawn-error"; message: string };

export type HookRunner = (
	command: string,
	input: HookInput,
	workspaceRoot: string,
) => Promise<HookOutcome>;

export function matchingHooks(
	entries: HookEntry[] | undefined,
	toolName: string,
): HookEntry[] {
	return (entries ?? []).filter((entry) =>
		matchesPattern(entry.match, toolName),
	);
}

export function preToolAllowed(outcome: HookOutcome): boolean {
	return outcome.kind === "exit" && outcome.code === 0;
}

export function preToolBlockReason(
	outcome: HookOutcome,
	toolName: string,
): string {
	if (outcome.kind === "exit") {
		const trimmed = outcome.stdout.trim();
		if (trimmed !== "") return trimmed;
	}
	return `Tool ${toolName} was blocked by a preToolUse hook.`;
}

// Runs one hook command through the system shell with the workspace root as the
// working directory. The payload is delivered as a single JSON object on stdin,
// and the tool name is also exposed as MY_AGENT_TOOL for simple shell scripts.
export function runHook(
	command: string,
	input: HookInput,
	workspaceRoot: string,
): Promise<HookOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (outcome: HookOutcome): void => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, {
				shell: true,
				cwd: workspaceRoot,
				env: { ...process.env, MY_AGENT_TOOL: input.tool },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			done({ kind: "spawn-error", message: errorMessage(error) });
			return;
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			done({ kind: "spawn-error", message: errorMessage(error) });
		});
		child.on("close", (code) => {
			done({ kind: "exit", code, stdout, stderr });
		});
		// A hook may exit before reading stdin, so a broken pipe on the write is
		// expected and never an error worth surfacing.
		child.stdin?.on("error", () => {});
		child.stdin?.write(JSON.stringify(input));
		child.stdin?.end();
	});
}
