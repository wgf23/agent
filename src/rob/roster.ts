import type { Tool } from "../tools/types.js";
import type { RobName, Teammate } from "./types.js";

export interface TeamPreambleInput {
	readonly rob: RobName;
	readonly role: string;
	readonly roster: readonly Teammate[];
	readonly tools: readonly Tool[];
}

/** The only composer of rob instructions. The roster is live at call time, so
 *  a teammate added mid-session shows up on the next turn. */
export function renderTeamPreamble(input: TeamPreambleInput): string {
	const lines = [
		`You are rob "${input.rob}", one member of a team of robs.`,
		`Your role: ${input.role}`,
	];
	if (input.roster.length === 0) {
		lines.push("You are the only rob: there is no teammate to message.");
	} else {
		lines.push("", "Your teammates:");
		for (const teammate of input.roster) {
			lines.push(`- "${teammate.name}": ${teammate.role}`);
		}
	}
	lines.push("", "Team tools:");
	for (const tool of input.tools) {
		lines.push(`- ${tool.name}: ${tool.description}`);
	}
	lines.push(
		"",
		"send_message is fire-and-forget: the message is delivered when the teammate next runs, and their reply arrives later as a message from them.",
	);
	return lines.join("\n");
}
