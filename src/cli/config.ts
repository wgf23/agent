import os from "node:os";
import { resolveConfig } from "../config/resolve.js";

export interface ConfigCommandOptions {
	workspaceRoot?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
}

export function runConfigCommand(options: ConfigCommandOptions = {}): number {
	const resolved = resolveConfig({
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
		env: options.env ?? process.env,
		homeDir: options.homeDir ?? os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider, apiKey, apiKeySource, sources } = resolved.config;
	const apiKeyLabel =
		apiKey === undefined ? "missing" : `set (${apiKeySource ?? "unknown"})`;
	const rows: Array<[string, string]> = [
		["provider", `${provider.preset} (${sources.preset})`],
		["model", `${provider.model} (${sources.model})`],
		["thinking", `${provider.thinking} (${sources.thinking})`],
		["reasoning", `${provider.reasoningEffort} (${sources.reasoningEffort})`],
		["baseURL", `${provider.baseURL} (${sources.baseURL})`],
		["maxSteps", `${provider.maxSteps} (${sources.maxSteps})`],
		["apiKeyEnv", `${provider.apiKeyEnv} (${sources.apiKeyEnv})`],
		["apiKey", apiKeyLabel],
	];
	const width = Math.max(...rows.map(([label]) => label.length));
	for (const [label, value] of rows) {
		console.log(`${label.padEnd(width)}  ${value}`);
	}
	return 0;
}
