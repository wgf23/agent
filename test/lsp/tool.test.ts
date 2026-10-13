import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import type { LspServers } from "../../src/lsp/config.js";
import { startLspServers } from "../../src/lsp/manager.js";
import { executeTool } from "../../src/tools/registry.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { FAKE_LSP_SERVER } from "./helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-lsp-tool-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

function servers(env: Record<string, string> = {}): LspServers {
	return {
		typescript: {
			command: [process.execPath, FAKE_LSP_SERVER],
			extensions: [".ts", ".tsx"],
			env,
		},
	};
}

async function run(
	tool: Tool,
	args: unknown,
	workspaceRoot: string,
): Promise<Awaited<ReturnType<typeof executeTool>>> {
	return executeTool(tool, args, { workspaceRoot } satisfies ToolContext);
}

describe("diagnostics tool", () => {
	it("round-trips through a real server and formats the output", async () => {
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(
			path.join(workspace, "src", "app.ts"),
			"const x = 1;\n",
			"utf8",
		);
		const log = path.join(workspace, "log.jsonl");
		const lsp = startLspServers({
			servers: servers({ FAKE_LSP_LOG: log }),
			workspaceRoot: workspace,
			timeoutMs: 2000,
		});
		try {
			const tool = lsp.tools[0];
			const result = await run(tool, { path: "src/app.ts" }, workspace);

			expect(result).toEqual({
				ok: true,
				output:
					"src/app.ts:1:1 error Cannot find name 'x'.\n" +
					"src/app.ts:3:5 warning Unused variable 'y'.",
			});

			const received = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(received[0].method).toBe("initialize");
			const initParams = received[0].params as Record<string, unknown>;
			// typescript-language-server publishes nothing without workspaceFolders
			// and the publishDiagnostics capability, so lock both in.
			expect(initParams.workspaceFolders).toEqual([
				{
					uri: pathToFileURL(workspace).toString(),
					name: path.basename(workspace),
				},
			]);
			expect(initParams.capabilities).toEqual({
				workspace: { workspaceFolders: true },
				textDocument: { publishDiagnostics: { relatedInformation: true } },
			});
			expect(received[1]).toEqual({
				jsonrpc: "2.0",
				method: "initialized",
				params: {},
			});
			expect(received[2].method).toBe("textDocument/didOpen");
			// The language id is the canonical name, not the raw extension.
			const didOpen = received[2].params as {
				textDocument: { languageId: string };
			};
			expect(didOpen.textDocument.languageId).toBe("typescript");
		} finally {
			await lsp.dispose();
		}
	});

	it("filters by severity", async () => {
		await writeFile(path.join(workspace, "app.ts"), "const x = 1;\n", "utf8");
		const lsp = startLspServers({
			servers: servers(),
			workspaceRoot: workspace,
		});
		try {
			const result = await run(
				lsp.tools[0],
				{ path: "app.ts", severity: "warning" },
				workspace,
			);
			expect(result).toEqual({
				ok: true,
				output: "app.ts:3:5 warning Unused variable 'y'.",
			});
		} finally {
			await lsp.dispose();
		}
	});

	it("returns ok:false naming the configured extensions for an unknown one", async () => {
		const lsp = startLspServers({
			servers: servers(),
			workspaceRoot: workspace,
		});
		try {
			const result = await run(lsp.tools[0], { path: "app.js" }, workspace);
			expect(result).toEqual({
				ok: false,
				error:
					'diagnostics: no language server for ".js". Configured extensions: .ts, .tsx',
			});
		} finally {
			await lsp.dispose();
		}
	});

	it("returns a timeout error when the server never sends diagnostics", async () => {
		await writeFile(path.join(workspace, "app.ts"), "const x = 1;\n", "utf8");
		const lsp = startLspServers({
			servers: servers({ FAKE_LSP_SCENARIO: "silent" }),
			workspaceRoot: workspace,
			timeoutMs: 100,
		});
		try {
			const result = await run(lsp.tools[0], { path: "app.ts" }, workspace);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain("lsp typescript");
			expect(result.error).toContain("timed out waiting for diagnostics");
		} finally {
			await lsp.dispose();
		}
	});

	it("returns an error when the server exits early", async () => {
		await writeFile(path.join(workspace, "app.ts"), "const x = 1;\n", "utf8");
		const lsp = startLspServers({
			servers: servers({ FAKE_LSP_SCENARIO: "exit-early" }),
			workspaceRoot: workspace,
			timeoutMs: 2000,
		});
		try {
			const result = await run(lsp.tools[0], { path: "app.ts" }, workspace);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain("lsp typescript: server exited");
		} finally {
			await lsp.dispose();
		}
	});

	it("is advertised in the runAgent tool list when configured and absent when not", async () => {
		const absent = startLspServers({ servers: {}, workspaceRoot: workspace });
		expect(absent.tools).toEqual([]);
		await absent.dispose();

		const lsp = startLspServers({
			servers: servers(),
			workspaceRoot: workspace,
		});
		try {
			const provider = createMockProvider([
				[{ type: "finish", reason: "stop" }],
			]);
			await runAgent({
				provider,
				model: "deepseek-flash",
				workspaceRoot: workspace,
				prompt: "hi",
				extraTools: lsp.tools,
				onEvent: () => {},
			});
			expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
				"diagnostics",
			);
		} finally {
			await lsp.dispose();
		}
	});
});
