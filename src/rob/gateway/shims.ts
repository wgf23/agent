import type { ToolDefinition } from "../../providers/types.js";
import { gatewayClientSource } from "./wire.js";

/** The one pi extension source for a bridged turn. The gateway client half is
 *  inlined, so the child shares this process's wire format instead of a copy. */
export function piBridgeExtension(spec: {
	defs: readonly ToolDefinition[];
	approval: boolean;
}): string {
	const names = JSON.stringify(spec.defs.map((def) => def.name));
	const registrations = spec.defs.map(registerToolSource).join("\n");
	// The gateway authorizes a team call, so the hook must not gate it again: a
	// confirm here would block the call on a second answer to the same question.
	const hook = spec.approval
		? `
	pi.on("tool_call", async (event, ctx) => {
		if (TEAM_TOOLS.has(event.toolName)) return;
		const allowed = await ctx.ui.confirm(
			"my-agent approval",
			JSON.stringify({ toolName: event.toolName, input: event.input }),
		);
		if (!allowed) {
			return { block: true, reason: "Denied by the my-agent approval bridge." };
		}
	});`
		: "";
	return `${gatewayClientSource()}
const TEAM_TOOLS = new Set(${names});

export default function (pi) {
${registrations}${hook}
}
`;
}

function registerToolSource(def: ToolDefinition): string {
	const name = JSON.stringify(def.name);
	return `	pi.registerTool({
		name: ${name},
		label: ${name},
		description: ${JSON.stringify(def.description)},
		parameters: ${JSON.stringify(def.parameters)},
		execute: async (_toolCallId, params) => {
			const outcome = await callTeamTool(${name}, params);
			// A resolved pi tool result cannot carry failure, so a refused call
			// has to throw; pi turns the thrown message into an error result.
			if (!outcome.ok) throw new Error(outcome.text);
			return { content: [{ type: "text", text: outcome.text }], details: {} };
		},
	});`;
}
