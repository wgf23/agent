export type BuiltinPresetName = "deepseek" | "openai";

export const DEFAULT_PRESET: BuiltinPresetName = "deepseek";

export interface Preset {
	name: BuiltinPresetName | "custom";
	baseURL: string;
	// The provider's Anthropic-compatible endpoint, when it has one. A claude
	// rob reaches the provider through it instead of a Claude login.
	anthropicBaseURL?: string;
	apiKeyEnv: string;
	defaultModel: string;
}

export const PRESETS: Record<BuiltinPresetName, Preset> = {
	deepseek: {
		name: "deepseek",
		baseURL: "https://api.deepseek.com",
		anthropicBaseURL: "https://api.deepseek.com/anthropic",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaultModel: "deepseek-flash",
	},
	openai: {
		name: "openai",
		baseURL: "https://api.openai.com/v1",
		apiKeyEnv: "OPENAI_API_KEY",
		defaultModel: "gpt-4o-mini",
	},
};

export interface CustomPresetInput {
	baseURL: string;
	apiKeyEnv: string;
	defaultModel: string;
}

export function customPreset(input: CustomPresetInput): Preset {
	return { name: "custom", ...input };
}

export type ResolveModelSpecResult =
	| { ok: true; preset: BuiltinPresetName; model: string }
	| { ok: false; error: string };

export function resolveModelSpec(spec: string): ResolveModelSpecResult {
	const slash = spec.indexOf("/");
	if (slash === -1) {
		if (spec.startsWith("deepseek")) {
			return { ok: true, preset: "deepseek", model: spec };
		}
		return { ok: false, error: unknownModelError(spec) };
	}

	const prefix = spec.slice(0, slash);
	const model = spec.slice(slash + 1);
	if (model === "" || (prefix !== "deepseek" && prefix !== "openai")) {
		return { ok: false, error: unknownModelError(spec) };
	}
	return { ok: true, preset: prefix, model };
}

function unknownModelError(spec: string): string {
	return `Unknown model "${spec}". Use "deepseek/<model>", "openai/<model>", or a model name starting with "deepseek".`;
}
