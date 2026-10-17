import type { McpServers } from "../config/resolve.js";
import { tools as builtinTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import {
	type McpClient,
	type McpClientOptions,
	StdioMcpClient,
} from "./client.js";
import { redactMcpServer } from "./redact.js";
import { mapServerTools, parseToolList } from "./tools.js";

export interface McpServerSummary {
	name: string;
	toolCount: number;
	// The mapped tool names, so a panel can show what enabling this server
	// would actually add. Names only: env values never leave the connection.
	tools: string[];
}

export interface ConnectMcpServersResult {
	tools: Tool[];
	// The same tools grouped by the server that provided them. A bot's tool
	// list is a selection over this, so grouping has to come from here: the
	// names are sanitised and a server cannot be recovered from them.
	toolsByServer: Record<string, Tool[]>;
	notices: string[];
	servers: McpServerSummary[];
	dispose: () => Promise<void>;
}

export interface ConnectMcpServersInput {
	servers: McpServers;
	workspaceRoot: string;
	timeoutMs?: number;
	// Test seam: defaults to `new StdioMcpClient(options)`. Only tests supply
	// it, to drive a failure the real client cannot produce.
	createClient?: (options: McpClientOptions) => McpClient;
}

// Starts every configured server, initializes it, and maps its tools. One
// server's failure becomes a notice and never stops the others.
export async function connectMcpServers(
	input: ConnectMcpServersInput,
): Promise<ConnectMcpServersResult> {
	// Each client keeps its own env so a dispose error can be redacted with the
	// values that server was started with: the array is the only place the two
	// are still paired.
	const createClient =
		input.createClient ?? ((options) => new StdioMcpClient(options));
	const clients: Array<{
		client: McpClient;
		name: string;
		env: Readonly<Record<string, string>>;
	}> = [];
	const tools: Tool[] = [];
	const toolsByServer: Record<string, Tool[]> = {};
	const notices: string[] = [];
	const servers: McpServerSummary[] = [];
	const existingNames = new Set(builtinTools.map((tool) => tool.name));

	for (const [name, config] of Object.entries(input.servers)) {
		const client = createClient({
			name,
			command: config.command,
			env: config.env,
			workspaceRoot: input.workspaceRoot,
			timeoutMs: input.timeoutMs,
		});
		const entry = { client, name, env: config.env ?? {} };
		clients.push(entry);
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
			toolsByServer[name] = mapped.tools;
			servers.push({
				name,
				toolCount: mapped.tools.length,
				tools: mapped.tools.map((tool) => tool.name),
			});
		} catch (error) {
			// A spawn or handshake error can quote the environment it was
			// given, so the text passes through this server's own env values
			// before it reaches a notice the UI shows.
			notices.push(
				redactMcpServer(
					`mcp ${name}: ${errorDetail(name, error)}`,
					config.env ?? {},
				),
			);
		}
	}

	return {
		tools,
		toolsByServer,
		notices,
		servers,
		// Unlike every other path here, dispose runs after the result object has
		// been handed out, so it appends to the same live `notices` array rather
		// than returning a fresh one: a caller that wants shutdown failures must
		// read that array again afterwards. Errors are recorded instead of
		// thrown, since callers already treat a failed dispose as non-fatal.
		dispose: async () => {
			await Promise.all(
				clients.map(async (entry) => {
					try {
						await entry.client.dispose();
					} catch (error) {
						// StdioMcpClient.dispose() cannot throw (it only kills
						// and awaits exit), so only a test-supplied client
						// reaches this branch. It stays because C15 asks for
						// every path that can surface server text to redact, and
						// a future dispose that does report something must not do
						// it raw.
						notices.push(
							redactMcpServer(
								`mcp ${entry.name}: ${errorDetail(entry.name, error)}`,
								entry.env,
							),
						);
					}
				}),
			);
		},
	};
}

// The lines a run prints to stderr for a connection: one per failed server and
// one summary per connected server. The TUI transcript keeps its own format.
export function mcpStderrLines(
	connection: Pick<ConnectMcpServersResult, "notices" | "servers">,
): string[] {
	return [
		...connection.notices,
		...connection.servers.map(
			(server) => `[mcp] ${server.name}: ${server.toolCount} tools`,
		),
	];
}

// Client errors already carry the "mcp <server>: " prefix; mapping errors do
// not. Strip the duplicate so a notice always reads "mcp <server>: <detail>".
function errorDetail(name: string, error: unknown): string {
	const message = errorMessage(error);
	const prefix = `mcp ${name}: `;
	return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
