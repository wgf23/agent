import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../agent/events.js";
import { resolveInWorkspace } from "../util/paths.js";

// The tools whose success rewrites a file the tree should re-read. bash is
// deliberately absent: it can write anywhere, so its effects cannot be named.
const WRITING_TOOLS = new Set(["write_file", "edit_file"]);

// Turns an agent's tool events into the paths a `files_changed` event should
// carry, or null when the event says nothing about the tree. A `tool_finished`
// carries no args, so this remembers each `tool_started` by call id and looks
// the args up when the tool finishes. One instance tracks one agent run; a hub
// keeps a tracker per bot so concurrent robs cannot cross wires.
export class FilesChangedTracker {
	private readonly started = new Map<string, unknown>();

	onEvent(workspaceRoot: string, event: AgentEvent): string[] | null {
		switch (event.type) {
			case "tool_started":
				this.started.set(event.id, event.args);
				return null;
			case "tool_finished": {
				const args = this.started.get(event.id);
				this.started.delete(event.id);
				// A failed or blocked tool wrote nothing.
				if (event.status !== "ok") return null;
				if (event.name === "bash") return [];
				if (!WRITING_TOOLS.has(event.name)) return null;
				const rel = workspaceRelative(workspaceRoot, args);
				// The path is unknown or escapes the workspace: refresh blindly
				// rather than name a path the client cannot resolve.
				return rel === null ? [] : [rel];
			}
			default:
				return null;
		}
	}
}

// The workspace-relative posix path a writing tool's args name, or null when
// the arg is missing, not a string, or resolves outside the workspace.
function workspaceRelative(
	workspaceRoot: string,
	args: unknown,
): string | null {
	if (typeof args !== "object" || args === null) return null;
	const raw = (args as Record<string, unknown>).path;
	if (typeof raw !== "string" || raw === "") return null;
	try {
		// resolveInWorkspace roots against realpath(workspaceRoot); measure the
		// relative against that same root so a symlinked tmpdir stays inside.
		const root = realpathSync(workspaceRoot);
		const resolved = resolveInWorkspace(workspaceRoot, raw);
		return path.relative(root, resolved).split(path.sep).join("/");
	} catch {
		return null;
	}
}
