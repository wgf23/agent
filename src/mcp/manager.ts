import type { McpServers } from "../config/resolve.js";
import { tools as builtinTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import {
	type McpClient,
	type McpClientOptions,
	StdioMcpClient,
} from "./client.js";
import { redactMcpServer, scanServerToolText } from "./redact.js";
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
			const infos = parseToolList(await client.listTools());
			// Three steps, in this order, each owning its own question:
			//   1. scan   -- is any of this secret, and what is safe to send?
			//                It only reads `infos`; it never names a tool.
			//   2. map    -- what are these tools called? Only here do names
			//                enter the shared `existingNames` set.
			//   3. send   -- `toolDefinition` turns a Tool into a provider
			//                request, and is where a value would finally leak.
			// The scan has to run first: mapping ends by adding names to a set
			// shared across servers, so a server refused afterwards would leave
			// its names behind and the next good server would fail as a
			// collision. A name is never rewritten -- it is how the tool is
			// called -- so a name that matches means the whole server goes, and
			// that decision cannot wait for a name to exist.
			const scan = scanServerToolText({ infos, env: config.env ?? {} });
			if (scan.reject) {
				// A tool name is how the tool is called, so it cannot be
				// redacted; the whole server goes instead. The client stays in
				// `clients` — this refuses visibility, not the process.
				// The variable name is not a secret, and naming it is what
				// separates "refused on purpose" from "the server crashed" or
				// "the config is wrong". The tool name is not repeated: it is
				// attacker-controlled and adds nothing the key does not.
				// Two shapes of refusal. A match names the variable; a pointer
				// that leaves the schema matches nothing, so saying "env ?"
				// would point at a variable that does not exist.
				const where = scan.rejectWhere ?? "tool schema";
				let reason: string;
				if (scan.rejectKey !== undefined) {
					reason = `${where} repeats the value of env "${scan.rejectKey}"`;
				} else if (scan.rejectKind === "malformed") {
					reason = `${where} is malformed`;
				} else if (scan.rejectKind === "external-ref") {
					reason = `${where} points outside the schema`;
				} else {
					// Named branch by branch rather than defaulting the last
					// case: a fallback would silently hand a future rejectKind
					// this explanation, and telling the user the wrong reason
					// to look for is worse than telling them none.
					reason = `${where} was refused`;
				}
				notices.push(
					redactMcpServer(
						`mcp ${name}: refused by security policy — ${reason}`,
						config.env ?? {},
					),
				);
				continue;
			}
			const mapped = mapServerTools({
				server: name,
				client,
				infos,
				existingNames,
			});
			if (mapped.error !== undefined) throw new Error(mapped.error);
			// The scan ran over the same infos in the same order, so the two
			// arrays line up today. Assert it rather than relying on it: once
			// mapServerTools starts filtering entries, an unchecked index would
			// hand one tool another's text and nothing would turn red.
			if (scan.tools.length !== mapped.tools.length) {
				throw new Error(
					`mcp ${name}: tool scan and mapping disagree on length`,
				);
			}
			const safeTools: Tool[] = mapped.tools.map((tool, index) => {
				const safe = scan.tools[index];
				// The length check above makes this unreachable. It throws rather
				// than falling back to `tool`, because a fallback would send the
				// unredacted text and look exactly like the success path.
				if (safe === undefined) {
					throw new Error(`mcp ${name}: missing scan result for ${tool.name}`);
				}
				return {
					...tool,
					description: safe.description,
					// `parameters` is what reaches the provider, and MCP tools
					// carry no `schema`, so the registry passes it through
					// untouched. The scan has already redacted the prose inside
					// it and refused any contract position that matched. This is
					// also the only place either is computed: doing it again
					// here would leave two copies to keep in step.
					parameters: safe.parameters,
				};
			});
			tools.push(...safeTools);
			toolsByServer[name] = safeTools;
			servers.push({
				name,
				toolCount: safeTools.length,
				// Depth: the scan above already proved these carry no value, so
				// this is a no-op until an edit makes it not one.
				tools: safeTools.map((tool) =>
					redactMcpServer(tool.name, config.env ?? {}),
				),
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
