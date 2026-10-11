import os from "node:os";
import { resolveConfig } from "../config/resolve.js";

export function runConfigCommand(): number {
	const resolved = resolveConfig({
		workspaceRoot: process.cwd(),
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider, apiKey, sources } = resolved.config;
	const rows: Array<[string, string]> = [
		["provider", `${provider.preset} (${sources.preset})`],
		["model", `${provider.model} (${sources.model})`],
		["thinking", `${provider.thinking} (${sources.thinking})`],
		["reasoning", `${provider.reasoningEffort} (${sources.reasoningEffort})`],
		["baseURL", `${provider.baseURL} (${sources.baseURL})`],
		["maxSteps", `${provider.maxSteps} (${sources.maxSteps})`],
		["apiKeyEnv", `${provider.apiKeyEnv} (${sources.apiKeyEnv})`],
		["apiKey", apiKey === undefined ? "missing" : "set"],
	];
	const width = Math.max(...rows.map(([label]) => label.length));
	for (const [label, value] of rows) {
		console.log(`${label.padEnd(width)}  ${value}`);
	}
	return 0;
}
