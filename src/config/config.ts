import os from "node:os";
import type { BuiltinPresetName } from "../providers/presets.js";
import { missingApiKeyMessage, resolveConfig } from "./resolve.js";

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
	const resolved = resolveConfig({
		cliModel:
			selection === undefined
				? undefined
				: `${selection.preset}/${selection.model}`,
		workspaceRoot: process.cwd(),
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) return { ok: false, error: resolved.error };

	const { provider, apiKey } = resolved.config;
	if (apiKey === undefined) {
		return { ok: false, error: missingApiKeyMessage(provider.apiKeyEnv) };
	}

	return {
		ok: true,
		config: {
			provider: {
				preset: provider.preset,
				model: provider.model,
				baseURL: provider.baseURL,
				apiKey,
			},
		},
	};
}
