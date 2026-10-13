import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION,
} from "../agent/compact.js";
import { type HooksConfig, hooksSchema } from "../hooks/hooks.js";
import { type LspServers, parseLspServers } from "../lsp/config.js";
import {
	type PermissionRules,
	permissionRulesSchema,
} from "../permissions/rules.js";
import {
	type BuiltinPresetName,
	DEFAULT_PRESET,
	PRESETS,
	resolveModelSpec,
} from "../providers/presets.js";
import type { ReasoningEffort, ThinkingSetting } from "../providers/types.js";
import type { RobConfig } from "../rob/types.js";
import { DEFAULT_SANDBOX, type SandboxSettings } from "../sandbox/index.js";
import { errorMessage } from "../util/errors.js";
import { readCredentials } from "./credentials.js";
import { parseRobs, projectFilePath } from "./project-file.js";

export type ConfigSource =
	| "cli"
	| "env"
	| "project"
	| "global"
	| "default"
	| "credentials";

export const GLOBAL_CONFIG_DIR = ".config/my-agent";
export const GLOBAL_CONFIG_NAME = "config.json";

export const providerOptionsSchema = z.object({
	preset: z.string().min(1).optional(),
	model: z.string().min(1).optional(),
	thinking: z.enum(["enabled", "disabled"]).optional(),
	reasoningEffort: z.enum(["none", "low", "high", "max"]).optional(),
	baseURL: z.string().min(1).optional(),
	apiKeyEnv: z.string().min(1).optional(),
	maxSteps: z.number().int().positive().optional(),
});
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

export const compactionOptionsSchema = z.object({
	auto: z.boolean().optional(),
	thresholdTokens: z.number().int().positive().optional(),
	keepRecentTokens: z.number().int().positive().optional(),
});
export type CompactionOptions = z.infer<typeof compactionOptionsSchema>;

export const sandboxOptionsSchema = z.object({
	mode: z.enum(["auto", "require", "off"]).optional(),
	network: z.boolean().optional(),
	writablePaths: z.array(z.string().min(1)).optional(),
});
export type SandboxOptions = z.infer<typeof sandboxOptionsSchema>;

export const searchProviderSchema = z.enum(["brave", "tavily", "searxng"]);
export type SearchProvider = z.infer<typeof searchProviderSchema>;

export const searchOptionsSchema = z.object({
	provider: searchProviderSchema.optional(),
	apiKeyEnv: z.string().min(1).optional(),
	baseURL: z.string().min(1).optional(),
});
export type SearchOptions = z.infer<typeof searchOptionsSchema>;

export interface SearchSettings {
	provider: SearchProvider;
	apiKeyEnv: string;
	baseURL: string | undefined;
}

// The apiKeyEnv and baseURL defaults follow the provider, so a project that
// only sets "provider" still resolves to the right key variable and endpoint.
const SEARCH_PROVIDER_DEFAULTS: Record<
	SearchProvider,
	{ apiKeyEnv: string; baseURL: string | undefined }
> = {
	brave: {
		apiKeyEnv: "BRAVE_API_KEY",
		baseURL: "https://api.search.brave.com/res/v1/web/search",
	},
	tavily: {
		apiKeyEnv: "TAVILY_API_KEY",
		baseURL: "https://api.tavily.com/search",
	},
	searxng: { apiKeyEnv: "", baseURL: undefined },
};

export const DEFAULT_SEARCH: SearchSettings = {
	provider: "brave",
	...SEARCH_PROVIDER_DEFAULTS.brave,
};

export const embeddingsOptionsSchema = z.object({
	baseURL: z.string().min(1),
	model: z.string().min(1),
	apiKeyEnv: z.string().min(1),
	dimensions: z.number().int().positive().optional(),
});
export type EmbeddingsOptions = z.infer<typeof embeddingsOptionsSchema>;

export interface EmbeddingsSettings {
	baseURL: string;
	model: string;
	apiKeyEnv: string;
	dimensions: number | undefined;
}

export const mcpServerSchema = z.object({
	command: z.array(z.string().min(1)).min(1),
	env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServers = Record<string, McpServerConfig>;

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

// Accepts only the stdio shape. A remote config (url/transport/type) is a
// friendly error rather than a schema rejection so the message names the limit.
export function parseMcpServers(
	value: unknown,
	filePath: string,
): { ok: true; servers: McpServers } | { ok: false; error: string } {
	const invalid = (detail: string): { ok: false; error: string } => ({
		ok: false,
		error: `Invalid mcp in ${filePath}: ${detail}`,
	});
	if (value === undefined) return { ok: true, servers: {} };
	if (!isRecord(value))
		return invalid("expected an object with a servers map.");
	if (value.servers === undefined) return { ok: true, servers: {} };
	if (!isRecord(value.servers)) return invalid('"servers" must be an object.');
	const servers: McpServers = {};
	for (const [name, entry] of Object.entries(value.servers)) {
		if (!MCP_SERVER_NAME.test(name)) {
			return invalid(
				`server name "${name}" is invalid. Use letters, digits, "_" and "-".`,
			);
		}
		if (!isRecord(entry)) return invalid(`server "${name}" must be an object.`);
		if ("url" in entry || "transport" in entry || "type" in entry) {
			return invalid(
				`only stdio command servers are supported for now (server "${name}").`,
			);
		}
		const command = entry.command;
		if (
			!Array.isArray(command) ||
			command.length === 0 ||
			!command.every((part) => typeof part === "string" && part.length > 0)
		) {
			return invalid(
				`server "${name}": "command" must be a non-empty array of strings.`,
			);
		}
		const parsed = mcpServerSchema.safeParse(entry);
		if (!parsed.success) {
			return invalid(`server "${name}": ${z.prettifyError(parsed.error)}`);
		}
		servers[name] = parsed.data;
	}
	return { ok: true, servers };
}

export interface ProviderSettings {
	preset: BuiltinPresetName;
	model: string;
	thinking: ThinkingSetting;
	reasoningEffort: ReasoningEffort;
	baseURL: string;
	apiKeyEnv: string;
	maxSteps: number;
}

export interface ProviderSources {
	preset: ConfigSource;
	model: ConfigSource;
	thinking: ConfigSource;
	reasoningEffort: ConfigSource;
	baseURL: ConfigSource;
	apiKeyEnv: ConfigSource;
	maxSteps: ConfigSource;
}

export interface ResolvedConfig {
	provider: ProviderSettings;
	apiKey: string | undefined;
	apiKeySource?: "env" | "credentials";
	sources: ProviderSources;
	permissions: PermissionRules;
	robs: RobConfig[];
	hooks: HooksConfig;
	compaction: CompactionSettings;
	sandbox: SandboxSettings;
	search: SearchSettings;
	embeddings: EmbeddingsSettings | undefined;
	mcpServers: McpServers;
	lspServers: LspServers;
}

export type ResolveConfigResult =
	| { ok: true; config: ResolvedConfig }
	| { ok: false; error: string };

export interface ResolveConfigInput {
	cliModel?: string;
	cliMaxSteps?: number;
	workspaceRoot: string;
	env: Record<string, string | undefined>;
	homeDir: string;
}

export const DEFAULT_MAX_STEPS = 25;

export function globalConfigPath(homeDir: string): string {
	return path.join(homeDir, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_NAME);
}

export function missingApiKeyMessage(apiKeyEnv: string): string {
	return `Missing ${apiKeyEnv}. Run "my-agent setup" to store a key, or set the ${apiKeyEnv} environment variable.`;
}

export function resolveConfig(input: ResolveConfigInput): ResolveConfigResult {
	const globalPath = globalConfigPath(input.homeDir);
	const projectPath = projectFilePath(input.workspaceRoot);

	const global = loadLayer(globalPath, "global", projectPath);
	if (!global.ok) return global;
	const project = loadLayer(projectPath, "project", projectPath);
	if (!project.ok) return project;

	const cli = parseSelection(input.cliModel, "--model");
	if (!cli.ok) return cli;
	const envModel = input.env.MY_AGENT_MODEL;
	const fromEnv = parseSelection(envModel, "MY_AGENT_MODEL");
	if (!fromEnv.ok) return fromEnv;

	const presetField = pick<string>(
		[
			{ value: cli.selection?.preset, source: "cli" },
			{ value: fromEnv.selection?.preset, source: "env" },
			{ value: project.layer.provider.preset, source: "project" },
			{ value: global.layer.provider.preset, source: "global" },
		],
		{ value: DEFAULT_PRESET, source: "default" },
	);
	if (!isBuiltinPreset(presetField.value)) {
		return {
			ok: false,
			error: `Unknown preset "${presetField.value}" in ${describe(presetField.source, "preset", globalPath, projectPath)}. Use "deepseek" or "openai".`,
		};
	}
	const preset = presetField.value;

	const modelField = pick(
		[
			{ value: cli.selection?.model, source: "cli" },
			{ value: fromEnv.selection?.model, source: "env" },
			{ value: project.layer.provider.model, source: "project" },
			{ value: global.layer.provider.model, source: "global" },
		],
		{ value: PRESETS[preset].defaultModel, source: "default" },
	);
	const model = normalizeModelForPreset(preset, modelField.value);
	if (model === undefined) {
		return {
			ok: false,
			error: `Model "${modelField.value}" does not belong to preset "${preset}". Model from ${describe(modelField.source, "model", globalPath, projectPath)}, preset from ${describe(presetField.source, "preset", globalPath, projectPath)}.`,
		};
	}

	const baseURL = pick<string>(
		[
			{ value: project.layer.provider.baseURL, source: "project" },
			{ value: global.layer.provider.baseURL, source: "global" },
		],
		{ value: PRESETS[preset].baseURL, source: "default" },
	);
	const apiKeyEnv = pick<string>(
		[
			{ value: project.layer.provider.apiKeyEnv, source: "project" },
			{ value: global.layer.provider.apiKeyEnv, source: "global" },
		],
		{ value: PRESETS[preset].apiKeyEnv, source: "default" },
	);

	let apiKey: string | undefined;
	let apiKeySource: "env" | "credentials" | undefined;
	const envApiKey = input.env[apiKeyEnv.value];
	if (envApiKey !== undefined) {
		apiKey = envApiKey;
		apiKeySource = "env";
	} else {
		const credentials = readCredentials(input.homeDir);
		if (!credentials.ok) return credentials;
		const storedApiKey = credentials.keys[apiKeyEnv.value];
		if (storedApiKey !== undefined) {
			apiKey = storedApiKey;
			apiKeySource = "credentials";
		}
	}
	const thinking = pick<ThinkingSetting>(
		[
			{ value: project.layer.provider.thinking, source: "project" },
			{ value: global.layer.provider.thinking, source: "global" },
		],
		{ value: "enabled", source: "default" },
	);
	const reasoningEffort = pick<ReasoningEffort>(
		[
			{ value: project.layer.provider.reasoningEffort, source: "project" },
			{ value: global.layer.provider.reasoningEffort, source: "global" },
		],
		{ value: "high", source: "default" },
	);
	const maxSteps = pick<number>(
		[
			{ value: input.cliMaxSteps, source: "cli" },
			{ value: project.layer.provider.maxSteps, source: "project" },
			{ value: global.layer.provider.maxSteps, source: "global" },
		],
		{ value: DEFAULT_MAX_STEPS, source: "default" },
	);

	const compaction = resolveCompaction(
		project.layer.compaction,
		global.layer.compaction,
	);
	const sandbox = resolveSandbox(project.layer.sandbox, global.layer.sandbox);
	const search = resolveSearch(project.layer.search, global.layer.search);
	const embeddings = resolveEmbeddings(
		project.layer.embeddings,
		global.layer.embeddings,
	);
	// Project servers win over global servers of the same name; other names from
	// both layers stay.
	const mcpServers: McpServers = {
		...(global.layer.mcp ?? {}),
		...(project.layer.mcp ?? {}),
	};
	// Project servers win over global servers of the same name; a server marked
	// disabled in either layer drops out so a project can turn off a global one.
	const lspServers: LspServers = Object.fromEntries(
		Object.entries({
			...(global.layer.lsp ?? {}),
			...(project.layer.lsp ?? {}),
		}).filter(([, config]) => config.disabled !== true),
	);

	return {
		ok: true,
		config: {
			provider: {
				preset,
				model,
				thinking: thinking.value,
				reasoningEffort: reasoningEffort.value,
				baseURL: baseURL.value,
				apiKeyEnv: apiKeyEnv.value,
				maxSteps: maxSteps.value,
			},
			apiKey,
			apiKeySource,
			sources: {
				preset: presetField.source,
				model: modelField.source,
				thinking: thinking.source,
				reasoningEffort: reasoningEffort.source,
				baseURL: baseURL.source,
				apiKeyEnv: apiKeyEnv.source,
				maxSteps: maxSteps.source,
			},
			permissions: project.layer.permissions ?? {},
			robs: (project.layer.robs ?? []).map((rob) => ({
				...rob,
				model: rob.model ?? model,
			})),
			hooks: project.layer.hooks ?? {},
			compaction,
			sandbox,
			search,
			embeddings,
			mcpServers,
			lspServers,
		},
	};
}

export interface ProviderSelectionInput {
	preset: string;
	model: string;
	baseURL?: string;
	apiKeyEnv?: string;
}

export type ProviderSelectionResult =
	| { ok: true; preset: BuiltinPresetName; model: string }
	| { ok: false; error: string };

// Validates a provider choice before it is written. It reuses the exact preset
// and model rules resolveConfig applies, so a selection accepted here resolves
// to the same provider afterwards. Only malformed files are fatal to
// resolveConfig; this function is the friendly gate for user input.
export function validateProviderSelection(
	input: ProviderSelectionInput,
): ProviderSelectionResult {
	if (!isBuiltinPreset(input.preset)) {
		return {
			ok: false,
			error: `Unknown preset "${input.preset}". Use "deepseek" or "openai".`,
		};
	}
	const model = normalizeModelForPreset(input.preset, input.model);
	if (model === undefined) {
		return {
			ok: false,
			error: `Model "${input.model}" does not belong to preset "${input.preset}".`,
		};
	}
	if (input.baseURL !== undefined && input.baseURL.trim() === "") {
		return { ok: false, error: "Base URL must not be empty." };
	}
	if (input.apiKeyEnv !== undefined && input.apiKeyEnv.trim() === "") {
		return { ok: false, error: "API key env var must not be empty." };
	}
	return { ok: true, preset: input.preset, model };
}

interface Layer {
	provider: ProviderOptions;
	permissions?: PermissionRules;
	robs?: RobConfig[];
	hooks?: HooksConfig;
	compaction?: CompactionOptions;
	sandbox?: SandboxOptions;
	search?: SearchOptions;
	embeddings?: EmbeddingsOptions;
	mcp?: McpServers;
	lsp?: LspServers;
}

function loadLayer(
	filePath: string,
	role: "global" | "project",
	projectPath: string,
): { ok: true; layer: Layer } | { ok: false; error: string } {
	const read = readRaw(filePath);
	if (!read.ok) return read;
	const raw = read.raw;
	if (!isRecord(raw)) {
		return { ok: false, error: `Invalid ${filePath}: expected a JSON object.` };
	}

	const providerRaw = isRecord(raw.provider) ? raw.provider : undefined;
	if (
		"apiKey" in raw ||
		(providerRaw !== undefined && "apiKey" in providerRaw)
	) {
		return {
			ok: false,
			error: `Config files cannot set "apiKey". Set the API key in an environment variable instead (for example DEEPSEEK_API_KEY), then point "apiKeyEnv" at it. Offending file: ${filePath}.`,
		};
	}

	if (role === "global" && "permissions" in raw) {
		return {
			ok: false,
			error: `The global config ${filePath} cannot set permissions. Put permission rules in ${projectPath} instead.`,
		};
	}

	if (role === "global" && "robs" in raw) {
		return {
			ok: false,
			error: `The global config ${filePath} cannot set robs. Put the robs array in ${projectPath} instead.`,
		};
	}

	if (role === "global" && "backend" in raw) {
		return {
			ok: false,
			error: `The global config ${filePath} cannot set backend. Put a rob's backend in ${projectPath} instead.`,
		};
	}

	const provider = providerOptionsSchema.safeParse(raw.provider ?? {});
	if (!provider.success) {
		return {
			ok: false,
			error: `Invalid provider settings in ${filePath}: ${z.prettifyError(provider.error)}`,
		};
	}

	let permissions: PermissionRules | undefined;
	if (role === "project" && raw.permissions !== undefined) {
		const parsed = permissionRulesSchema.safeParse(raw.permissions);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid permissions in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		permissions = parsed.data;
	}

	let robs: RobConfig[] | undefined;
	if (role === "project" && raw.robs !== undefined) {
		const parsed = parseRobs(raw.robs);
		if (!parsed.ok) {
			return {
				ok: false,
				error: `Invalid robs in ${filePath}: ${parsed.error}`,
			};
		}
		robs = parsed.robs;
	}

	let hooks: HooksConfig | undefined;
	if (role === "project" && raw.hooks !== undefined) {
		const parsed = hooksSchema.safeParse(raw.hooks);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid hooks in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		hooks = parsed.data;
	}

	let compaction: CompactionOptions | undefined;
	if (raw.compaction !== undefined) {
		const parsed = compactionOptionsSchema.safeParse(raw.compaction);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid compaction in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		compaction = parsed.data;
	}

	let sandbox: SandboxOptions | undefined;
	if (raw.sandbox !== undefined) {
		const parsed = sandboxOptionsSchema.safeParse(raw.sandbox);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid sandbox in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		sandbox = parsed.data;
	}

	let search: SearchOptions | undefined;
	if (raw.search !== undefined) {
		const parsed = searchOptionsSchema.safeParse(raw.search);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid search in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		search = parsed.data;
	}

	let embeddings: EmbeddingsOptions | undefined;
	if (raw.embeddings !== undefined) {
		const parsed = embeddingsOptionsSchema.safeParse(raw.embeddings);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid embeddings in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		embeddings = parsed.data;
	}

	let mcp: McpServers | undefined;
	if (raw.mcp !== undefined) {
		const parsed = parseMcpServers(raw.mcp, filePath);
		if (!parsed.ok) return parsed;
		mcp = parsed.servers;
	}

	let lsp: LspServers | undefined;
	if (raw.lsp !== undefined) {
		const parsed = parseLspServers(raw.lsp, filePath);
		if (!parsed.ok) return parsed;
		lsp = parsed.servers;
	}

	return {
		ok: true,
		layer: {
			provider: provider.data,
			permissions,
			robs,
			hooks,
			compaction,
			sandbox,
			search,
			embeddings,
			mcp,
			lsp,
		},
	};
}

function readRaw(
	filePath: string,
): { ok: true; raw: unknown } | { ok: false; error: string } {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: true, raw: {} };
		return {
			ok: false,
			error: `Failed to read ${filePath}: ${errorMessage(error)}`,
		};
	}
	try {
		return { ok: true, raw: JSON.parse(text) };
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
		};
	}
}

interface Sourced<T> {
	value: T;
	source: ConfigSource;
}

function pick<T>(
	candidates: Array<{ value: T | undefined; source: ConfigSource }>,
	fallback: Sourced<T>,
): Sourced<T> {
	for (const candidate of candidates) {
		if (candidate.value !== undefined) {
			return { value: candidate.value, source: candidate.source };
		}
	}
	return fallback;
}

function resolveCompaction(
	project: CompactionOptions | undefined,
	global: CompactionOptions | undefined,
): CompactionSettings {
	return {
		auto: project?.auto ?? global?.auto ?? DEFAULT_COMPACTION.auto,
		thresholdTokens:
			project?.thresholdTokens ??
			global?.thresholdTokens ??
			DEFAULT_COMPACTION.thresholdTokens,
		keepRecentTokens:
			project?.keepRecentTokens ??
			global?.keepRecentTokens ??
			DEFAULT_COMPACTION.keepRecentTokens,
	};
}

function resolveSandbox(
	project: SandboxOptions | undefined,
	global: SandboxOptions | undefined,
): SandboxSettings {
	return {
		mode: project?.mode ?? global?.mode ?? DEFAULT_SANDBOX.mode,
		network: project?.network ?? global?.network ?? DEFAULT_SANDBOX.network,
		writablePaths:
			project?.writablePaths ??
			global?.writablePaths ??
			DEFAULT_SANDBOX.writablePaths,
	};
}

function resolveSearch(
	project: SearchOptions | undefined,
	global: SearchOptions | undefined,
): SearchSettings {
	const provider = project?.provider ?? global?.provider ?? "brave";
	const defaults = SEARCH_PROVIDER_DEFAULTS[provider];
	return {
		provider,
		apiKeyEnv: project?.apiKeyEnv ?? global?.apiKeyEnv ?? defaults.apiKeyEnv,
		baseURL: project?.baseURL ?? global?.baseURL ?? defaults.baseURL,
	};
}

// The schema requires baseURL, model, and apiKeyEnv in each block, so a block
// is complete and the per-field merge simply lets the project layer override the
// global one. Absent in both layers means no embeddings and no tool.
function resolveEmbeddings(
	project: EmbeddingsOptions | undefined,
	global: EmbeddingsOptions | undefined,
): EmbeddingsSettings | undefined {
	const baseURL = project?.baseURL ?? global?.baseURL;
	const model = project?.model ?? global?.model;
	const apiKeyEnv = project?.apiKeyEnv ?? global?.apiKeyEnv;
	if (baseURL === undefined || model === undefined || apiKeyEnv === undefined) {
		return undefined;
	}
	return {
		baseURL,
		model,
		apiKeyEnv,
		dimensions: project?.dimensions ?? global?.dimensions,
	};
}

interface Selection {
	preset: BuiltinPresetName;
	model: string;
}

function parseSelection(
	spec: string | undefined,
	label: string,
): { ok: true; selection?: Selection } | { ok: false; error: string } {
	if (spec === undefined) return { ok: true };
	const resolved = resolveModelSpec(spec);
	if (!resolved.ok) return { ok: false, error: `${label}: ${resolved.error}` };
	return {
		ok: true,
		selection: { preset: resolved.preset, model: resolved.model },
	};
}

function normalizeModelForPreset(
	preset: BuiltinPresetName,
	model: string,
): string | undefined {
	const slash = model.indexOf("/");
	if (slash !== -1) {
		if (model.slice(0, slash) !== preset) return undefined;
		const rest = model.slice(slash + 1);
		return rest === "" ? undefined : rest;
	}
	if (preset === "deepseek")
		return model.startsWith("deepseek") ? model : undefined;
	return model.startsWith("deepseek") ? undefined : model;
}

function isBuiltinPreset(value: string): value is BuiltinPresetName {
	return value === "deepseek" || value === "openai";
}

function describe(
	source: ConfigSource,
	field: "preset" | "model",
	globalPath: string,
	projectPath: string,
): string {
	switch (source) {
		case "cli":
			return "--model";
		case "env":
			return "MY_AGENT_MODEL";
		case "project":
			return projectPath;
		case "global":
			return globalPath;
		case "default":
			return `the built-in ${field} default`;
		case "credentials":
			return "credentials.json";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
}
