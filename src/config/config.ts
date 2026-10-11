import {
	type BuiltinPresetName,
	DEFAULT_PRESET,
	PRESETS,
} from "../providers/presets.js";

export interface ProviderConfig {
	preset: BuiltinPresetName;
	model: string;
	baseURL: string;
	apiKey: string;
}

export interface ResolvedConfig {
	provider: ProviderConfig;
}

export type ConfigResult =
	| { ok: true; config: ResolvedConfig }
	| { ok: false; error: string };

export interface ModelSelection {
	preset: BuiltinPresetName;
	model: string;
}

export function loadConfig(selection?: ModelSelection): ConfigResult {
	const chosen: ModelSelection = selection ?? {
		preset: DEFAULT_PRESET,
		model: PRESETS[DEFAULT_PRESET].defaultModel,
	};
	const preset = PRESETS[chosen.preset];

	const apiKey = process.env[preset.apiKeyEnv];
	if (!apiKey) {
		return {
			ok: false,
			error: `Missing ${preset.apiKeyEnv}. Set it in your environment and try again.`,
		};
	}

	return {
		ok: true,
		config: {
			provider: {
				preset: chosen.preset,
				model: chosen.model,
				baseURL: preset.baseURL,
				apiKey,
			},
		},
	};
}
