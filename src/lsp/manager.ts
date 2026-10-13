import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { resolveInWorkspace } from "../util/paths.js";
import { truncateOutput } from "../util/truncate.js";
import { StdioLspClient } from "./client.js";
import type { LspServerConfig, LspServers } from "./config.js";
import {
	diagnosticsSchema,
	filterDiagnostics,
	formatDiagnostics,
	type Severity,
} from "./tool.js";

export interface StartLspServersInput {
	servers: LspServers;
	workspaceRoot: string;
	timeoutMs?: number;
}

export interface StartLspServersResult {
	tools: Tool[];
	dispose: () => Promise<void>;
}

// Builds one read-only `diagnostics` tool per run. Servers start lazily on the
// first matching file and are reused afterwards; an empty or absent server map
// yields no tool, so LSP is off. Mirrors connectMcpServers, but with no
// startup notices because nothing runs until a file asks for it.
export function startLspServers(
	input: StartLspServersInput,
): StartLspServersResult {
	const servers = Object.entries(input.servers);
	if (servers.length === 0) {
		return { tools: [], dispose: async () => {} };
	}

	const clients = new Map<string, StdioLspClient>();
	for (const [name, config] of servers) {
		clients.set(
			name,
			new StdioLspClient({
				name,
				command: config.command,
				env: config.env,
				initializationOptions: config.initialization,
				workspaceRoot: input.workspaceRoot,
				timeoutMs: input.timeoutMs,
			}),
		);
	}

	const configuredExtensions = servers.flatMap(
		([, config]) => config.extensions,
	);

	const tool: Tool<typeof diagnosticsSchema> = {
		name: "diagnostics",
		description:
			"Run the configured language server for a file and return its diagnostics as `<path>:<line>:<col> <severity> <message>` lines.",
		readOnly: true,
		schema: diagnosticsSchema,
		async execute(args, ctx) {
			return runDiagnostics({
				args,
				ctx,
				servers,
				clients,
				configuredExtensions,
				workspaceRoot: input.workspaceRoot,
			});
		},
	};

	return {
		tools: [tool],
		dispose: async () => {
			await Promise.all(
				[...clients.values()].map((client) => client.dispose()),
			);
		},
	};
}

async function runDiagnostics(input: {
	args: { path: string; severity?: Severity };
	ctx: ToolContext;
	servers: Array<[string, LspServerConfig]>;
	clients: Map<string, StdioLspClient>;
	configuredExtensions: string[];
	workspaceRoot: string;
}): Promise<ToolResult> {
	const { args, ctx, servers, clients, configuredExtensions, workspaceRoot } =
		input;

	if (ctx.signal?.aborted) {
		return { ok: false, error: "diagnostics: request aborted" };
	}

	const extension = path.extname(args.path).toLowerCase();
	const match = servers.find(([, config]) =>
		config.extensions.some((entry) => entry.toLowerCase() === extension),
	);
	if (match === undefined) {
		return {
			ok: false,
			error: `diagnostics: no language server for "${extension || args.path}". Configured extensions: ${configuredExtensions.join(", ")}`,
		};
	}
	const [name] = match;

	let target: string;
	try {
		target = resolveInWorkspace(workspaceRoot, args.path);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}

	let text: string;
	try {
		text = await readFile(target, "utf8");
	} catch {
		return { ok: false, error: `diagnostics: file not found: ${args.path}` };
	}

	const client = clients.get(name);
	if (client === undefined) {
		return { ok: false, error: `diagnostics: no server named "${name}"` };
	}

	try {
		await client.ensureStarted();
		const uri = pathToFileURL(target).toString();
		const diagnostics = await client.requestDiagnostics(
			uri,
			languageIdFor(extension),
			text,
		);
		const filtered = filterDiagnostics(diagnostics, args.severity);
		return {
			ok: true,
			output: truncateOutput(formatDiagnostics(args.path, filtered)).text,
		};
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

// LSP language ids are canonical names, not the file extension. Passing "ts"
// makes typescript-language-server reject the didOpen with "Invalid
// languageId", so map the common extensions and fall back to the bare
// extension for anything else.
const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".json": "json",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

function languageIdFor(extension: string): string {
	return LANGUAGE_IDS[extension] ?? extension.slice(1);
}
