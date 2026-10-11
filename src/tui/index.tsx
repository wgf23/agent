import { render } from "ink";
import { loadConfig, type ModelSelection } from "../config/config.js";
import { readProjectConfig } from "../config/project-file.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { resolveModelSpec } from "../providers/presets.js";
import { App } from "./App.js";

export interface RunTuiOptions {
	workspaceRoot: string;
	model?: string;
	maxSteps?: number;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
	let selection: ModelSelection | undefined;
	if (options.model !== undefined) {
		const resolved = resolveModelSpec(options.model);
		if (!resolved.ok) {
			console.error(resolved.error);
			process.exitCode = 1;
			return;
		}
		selection = { preset: resolved.preset, model: resolved.model };
	}

	const loaded = loadConfig(selection);
	if (!loaded.ok) {
		console.error(loaded.error);
		process.exitCode = 1;
		return;
	}

	const config = loaded.config.provider;
	const provider = createOpenAICompatibleProvider({
		id: config.preset,
		baseURL: config.baseURL,
		apiKey: config.apiKey,
	});

	const project = await readProjectConfig(options.workspaceRoot);
	if (!project.ok) {
		console.error(project.error);
		process.exitCode = 1;
		return;
	}

	const rules = {
		...defaultRules(),
		...(project.config.permissions ?? {}),
	};
	const authorize = createAuthorizer({
		workspaceRoot: options.workspaceRoot,
		rules,
		approval: headlessApproval({ yesAll: false }),
		yesAll: false,
	});

	const instance = render(
		<App
			provider={provider}
			authorize={authorize}
			model={config.model}
			workspaceRoot={options.workspaceRoot}
			maxSteps={options.maxSteps}
		/>,
	);
	await instance.waitUntilExit();
}
