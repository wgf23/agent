import type { ToolDefinition } from "../../providers/types.js";
import { gatewayClientSource } from "./wire.js";

/** The one name both bridged backends mount the shim under. It decides the
 *  claude tool name `mcp__<server>__<tool>` and the opencode permission action
 *  `${server}_<tool>`, so the two can never drift apart. */
export const TEAM_MCP_SERVER = "myagent-team";

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

/** The one opencode MCP server source for a bridged turn. The gateway client
 *  half is inlined and nothing imports my-agent, so the child runs the file
 *  under both `tsx` and a built `dist`. */
export function teamMcpShim(spec: { defs: readonly ToolDefinition[] }): string {
	const tools = JSON.stringify(
		spec.defs.map((def) => ({
			name: def.name,
			description: def.description,
			inputSchema: def.parameters,
		})),
	);
	return `${gatewayClientSource()}
const TOOLS = ${tools};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		void handle(line);
		newline = buffer.indexOf("\\n");
	}
});

function write(message) {
	process.stdout.write(JSON.stringify(message) + "\\n");
}

async function handle(line) {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof message !== "object" || message === null) return;
	// Only notifications carry no id, and only notifications/initialized is sent.
	if (message.id === undefined || message.id === null) return;
	switch (message.method) {
		case "initialize": {
			const params = message.params ?? {};
			write({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion:
						typeof params.protocolVersion === "string"
							? params.protocolVersion
							: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "my-agent-team", version: "1.0.0" },
				},
			});
			return;
		}
		case "ping":
			write({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		case "tools/list":
			write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
			return;
		case "tools/call": {
			const params = message.params ?? {};
			const name = typeof params.name === "string" ? params.name : "";
			if (!TOOLS.some((tool) => tool.name === name)) {
				write({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32602, message: "Unknown tool: " + name },
				});
				return;
			}
			try {
				const outcome = await callTeamTool(name, params.arguments ?? {});
				const result = { content: [{ type: "text", text: outcome.text }] };
				// MCP reports a refused tool call as a successful result too.
				if (!outcome.ok) result.isError = true;
				write({ jsonrpc: "2.0", id: message.id, result });
			} catch (error) {
				write({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						content: [
							{
								type: "text",
								text: error instanceof Error ? error.message : String(error),
							},
						],
						isError: true,
					},
				});
			}
			return;
		}
		default:
			write({
				jsonrpc: "2.0",
				id: message.id,
				error: {
					code: -32601,
					message: "Unsupported method: " + message.method,
				},
			});
	}
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
