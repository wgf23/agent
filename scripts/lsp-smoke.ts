import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLspServers } from "../src/lsp/manager.js";
import { executeTool } from "../src/tools/registry.js";

const binary =
	process.env.TYPESCRIPT_LANGUAGE_SERVER ?? "typescript-language-server";

// A real server needs a TypeScript install to drive tsserver. Prefer the
// pinned 5.9 workspace when present, and fall back to whatever
// typescript-language-server resolves on its own otherwise.
const tsserverPath = process.env.MY_AGENT_TSSERVER_PATH;
const pinned = "/tmp/lsp-ws/node_modules/typescript/lib/tsserver.js";

if (spawnSync(binary, ["--version"], { stdio: "ignore" }).error) {
	console.log(`skipped: ${binary} not found on PATH`);
	process.exit(0);
}

const dir = await mkdtemp(path.join(tmpdir(), "lsp-smoke-"));
try {
	await mkdir(path.join(dir, "src"), { recursive: true });
	await writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					strict: true,
					target: "ES2022",
					module: "commonjs",
					noEmit: true,
				},
				include: ["src"],
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(
		path.join(dir, "src", "app.ts"),
		'const x: number = "no";\n',
		"utf8",
	);

	const initialization: Record<string, unknown> = {};
	if (tsserverPath !== undefined && existsSync(tsserverPath)) {
		initialization.tsserver = { path: tsserverPath };
	} else if (existsSync(pinned)) {
		initialization.tsserver = { path: pinned };
	}

	const lsp = startLspServers({
		servers: {
			typescript: {
				command: [binary, "--stdio"],
				extensions: [".ts"],
				initialization,
			},
		},
		workspaceRoot: dir,
		timeoutMs: 30000,
	});

	const result = await executeTool(
		lsp.tools[0],
		{ path: "src/app.ts" },
		{ workspaceRoot: dir },
	);
	console.log(JSON.stringify(result, null, 2));
	await lsp.dispose();

	if (!result.ok || result.output.includes("no diagnostics")) {
		process.exitCode = 1;
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
