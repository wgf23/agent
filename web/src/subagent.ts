import type { AgentEvent } from "./protocol";

// Mirrors src/tui/team/components/SubagentView.tsx's subagentLine exactly, so
// the web feed and the TUI describe the same activity identically. An event
// with no user-facing line maps to "" and is filtered out by the caller.
export function subagentLine(event: AgentEvent): string {
	switch (event.type) {
		case "text_delta":
			return event.text;
		case "tool_started":
			return `tool ${event.name} started`;
		case "tool_finished":
			return `tool ${event.name} ${event.status}`;
		case "error":
			return `error: ${event.message}`;
		case "done":
			return `done (${event.reason})`;
		default:
			return "";
	}
}
