import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";

export interface InitCommandOptions {
	workspaceRoot?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
	force?: boolean;
	// Test seam: a double replaces the network provider.
	provider?: Provider;
}

const SYSTEM_PROMPT =
	"You write concise, accurate AGENTS.md files for coding-agent workspaces. Reply with only the AGENTS.md contents, no preamble.";

interface PackageSummary {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface WorkspaceContext {
	packageSummary: PackageSummary | undefined;
	readme: string | undefined;
	files: string[];
}

export async function runInitCommand(
	options: InitCommandOptions = {},
): Promise<number> {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");

	const resolved = resolveConfig({ workspaceRoot, env, homeDir });
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider: settings, apiKey } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		return 1;
	}

	if (existsSync(agentsMdPath) && !options.force) {
		console.error(
			`AGENTS.md already exists at ${agentsMdPath}. Pass --force to overwrite it.`,
		);
		return 1;
	}

	const provider =
		options.provider ??
		createOpenAICompatibleProvider({
			id: settings.preset,
			baseURL: settings.baseURL,
			apiKey,
			apiKeyEnv: settings.apiKeyEnv,
		});

	const prompt = buildPrompt(await gatherContext(workspaceRoot));

	let text = "";
	for await (const event of provider.stream({
		model: settings.model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		],
		tools: [],
	})) {
		if (event.type === "text_delta") text += event.text;
	}

	await writeFile(agentsMdPath, text, "utf8");
	console.log(agentsMdPath);
	return 0;
}

async function gatherContext(workspaceRoot: string): Promise<WorkspaceContext> {
	const [packageRaw, readme, files] = await Promise.all([
		readOptional(path.join(workspaceRoot, "package.json")),
		readOptional(path.join(workspaceRoot, "README.md")),
		listTopLevel(workspaceRoot),
	]);
	return {
		packageSummary:
			packageRaw === undefined ? undefined : summarizePackage(packageRaw),
		readme,
		files,
	};
}

async function readOptional(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

async function listTopLevel(workspaceRoot: string): Promise<string[]> {
	const entries = await readdir(workspaceRoot);
	return entries.sort();
}

function summarizePackage(raw: string): PackageSummary | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	return {
		name: typeof parsed.name === "string" ? parsed.name : undefined,
		scripts: stringMap(parsed.scripts),
		dependencies: stringMap(parsed.dependencies),
		devDependencies: stringMap(parsed.devDependencies),
	};
}

function buildPrompt(context: WorkspaceContext): string {
	const lines = ["Write a concise AGENTS.md for this workspace."];
	if (context.packageSummary !== undefined) {
		lines.push(`package.json:\n${JSON.stringify(context.packageSummary)}`);
	}
	if (context.readme !== undefined) {
		lines.push(`README.md:\n${context.readme}`);
	}
	lines.push(`Top-level files:\n${context.files.join(", ")}`);
	return lines.join("\n\n");
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
