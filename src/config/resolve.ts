import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
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
import { errorMessage } from "../util/errors.js";
import { projectFilePath } from "./project-file.js";

export type ConfigSource = "cli" | "env" | "project" | "global" | "default";

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
	sources: ProviderSources;
	permissions: PermissionRules;
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
	return `Missing ${apiKeyEnv}. Set it in your environment and try again.`;
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
			apiKey: input.env[apiKeyEnv.value],
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
		},
	};
}

interface Layer {
	provider: ProviderOptions;
	permissions?: PermissionRules;
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

	return { ok: true, layer: { provider: provider.data, permissions } };
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
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
}
