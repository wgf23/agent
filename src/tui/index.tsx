import os from "node:os";
import { render } from "ink";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { createAuthorizer } from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { Team } from "../rob/team.js";
import { robToolRules } from "../rob/tools.js";
import { App } from "./App.js";
import { createApprovalBridge } from "./approval.js";
import { TeamApp } from "./team/App.js";

export interface RunTuiOptions {
	workspaceRoot: string;
	model?: string;
	maxSteps?: number;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
	const resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot: options.workspaceRoot,
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		process.exitCode = 1;
		return;
	}

	const { provider: settings, apiKey, permissions, robs } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		process.exitCode = 1;
		return;
	}

	const provider = createOpenAICompatibleProvider({
		id: settings.preset,
		baseURL: settings.baseURL,
		apiKey,
		apiKeyEnv: settings.apiKeyEnv,
	});

	if (robs.length > 0) {
		const team = new Team({
			robs,
			defaultModel: settings.model,
			providerFactory: () => provider,
			workspaceRoot: options.workspaceRoot,
			authorizerFactory: (rob) =>
				createAuthorizer({
					workspaceRoot: options.workspaceRoot,
					rules: {
						...defaultRules(),
						...robToolRules(),
						...permissions,
						...rob.permissions,
					},
					approval: rob.approval,
					yesAll: false,
				}),
		});
		const instance = render(
			<TeamApp team={team} robs={robs} model={settings.model} />,
		);
		await instance.waitUntilExit();
		return;
	}

	const rules = {
		...defaultRules(),
		...permissions,
	};
	const approval = createApprovalBridge();
	const authorize = createAuthorizer({
		workspaceRoot: options.workspaceRoot,
		rules,
		approval: approval.request,
		yesAll: false,
	});

	// DeepSeek's thinking controls do not apply to other OpenAI-compatible
	// endpoints, so only forward them when the deepseek preset is active.
	const deepseek = settings.preset === "deepseek";

	const instance = render(
		<App
			provider={provider}
			authorize={authorize}
			approval={approval}
			model={settings.model}
			workspaceRoot={options.workspaceRoot}
			maxSteps={settings.maxSteps}
			thinking={deepseek ? settings.thinking : undefined}
			reasoningEffort={deepseek ? settings.reasoningEffort : undefined}
			baseURL={settings.baseURL}
			apiKeyEnv={settings.apiKeyEnv}
		/>,
	);
	await instance.waitUntilExit();
}
