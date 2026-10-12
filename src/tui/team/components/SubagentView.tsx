import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { AgentEvent } from "../../../agent/events.js";
import type { SubagentEntry } from "../../../rob/types.js";

export interface SubagentViewProps {
	entries: SubagentEntry[];
}

// Read-only: the view owns no input handler and no Team reference.
export function SubagentView({ entries }: SubagentViewProps): ReactElement {
	const lines = entries
		.map((entry) => ({
			key: `${entry.parent}-${entry.id}-${entry.at}-${JSON.stringify(entry.event)}`,
			parent: entry.parent,
			text: subagentLine(entry.event),
		}))
		.filter((line) => line.text !== "");
	return (
		<Box flexDirection="column">
			<Text bold>Sub-agents (read-only)</Text>
			{lines.length === 0 ? (
				<Text dimColor>(no sub-agent activity)</Text>
			) : (
				lines.map((line) => (
					<Text key={line.key}>{`[${line.parent}] ${line.text}`}</Text>
				))
			)}
			<Text dimColor>escape to close</Text>
		</Box>
	);
}

function subagentLine(event: AgentEvent): string {
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
