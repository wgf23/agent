import type { McpServers } from "../config/resolve.js";
import { tools as builtinTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { type McpClient, StdioMcpClient } from "./client.js";
import { mapServerTools, parseToolList } from "./tools.js";

export interface McpServerSummary {
	name: string;
	toolCount: number;
}

export interface ConnectMcpServersResult {
	tools: Tool[];
	notices: string[];
	servers: McpServerSummary[];
	dispose: () => Promise<void>;
}

export interface ConnectMcpServersInput {
	servers: McpServers;
	workspaceRoot: string;
	timeoutMs?: number;
}

// Starts every configured server, initializes it, and maps its tools. One
// server's failure becomes a notice and never stops the others.
export async function connectMcpServers(
	input: ConnectMcpServersInput,
): Promise<ConnectMcpServersResult> {
	const clients: McpClient[] = [];
	const tools: Tool[] = [];
	const notices: string[] = [];
	const servers: McpServerSummary[] = [];
	const existingNames = new Set(builtinTools.map((tool) => tool.name));

	for (const [name, config] of Object.entries(input.servers)) {
		const client = new StdioMcpClient({
			name,
			command: config.command,
			env: config.env,
			workspaceRoot: input.workspaceRoot,
			timeoutMs: input.timeoutMs,
		});
		clients.push(client);
		try {
			await client.initialize();
			const mapped = mapServerTools({
				server: name,
				client,
				infos: parseToolList(await client.listTools()),
				existingNames,
			});
			if (mapped.error !== undefined) throw new Error(mapped.error);
			tools.push(...mapped.tools);
			servers.push({ name, toolCount: mapped.tools.length });
		} catch (error) {
			notices.push(`mcp ${name}: ${errorDetail(name, error)}`);
		}
	}

	return {
		tools,
		notices,
		servers,
		dispose: async () => {
			await Promise.all(clients.map((client) => client.dispose()));
		},
	};
}

// Client errors already carry the "mcp <server>: " prefix; mapping errors do
// not. Strip the duplicate so a notice always reads "mcp <server>: <detail>".
function errorDetail(name: string, error: unknown): string {
	const message = errorMessage(error);
	const prefix = `mcp ${name}: `;
	return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
