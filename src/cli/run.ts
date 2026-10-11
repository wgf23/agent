import os from "node:os";
import { runAgent } from "../agent/agent.js";
import type { AgentDoneReason, AgentEvent } from "../agent/events.js";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";

export interface RunHeadlessOptions {
	prompt: string;
	model?: string;
	maxSteps?: number;
	yesAll?: boolean;
	onEvent?: (event: AgentEvent) => void;
}

export function exitCodeForReason(reason: AgentDoneReason): number {
	return reason === "finished" ? 0 : 1;
}

export async function runHeadless(
	options: RunHeadlessOptions,
): Promise<number> {
	const workspaceRoot = process.cwd();
	const resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot,
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider: settings, apiKey, permissions } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		return 1;
	}

	const provider = createOpenAICompatibleProvider({
		id: settings.preset,
		baseURL: settings.baseURL,
		apiKey,
		apiKeyEnv: settings.apiKeyEnv,
	});

	const yesAll = options.yesAll ?? false;
	const rules = {
		...defaultRules(),
		...permissions,
	};
	const authorize = createAuthorizer({
		workspaceRoot,
		rules,
		approval: headlessApproval({
			yesAll,
			log: (line) => process.stderr.write(line),
		}),
		yesAll,
	});

	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);

	// DeepSeek's thinking controls do not apply to other OpenAI-compatible
	// endpoints, so only forward them when the deepseek preset is active.
	const deepseek = settings.preset === "deepseek";

	let reasoningChars = 0;
	try {
		const result = await runAgent({
			provider,
			model: settings.model,
			workspaceRoot,
			prompt: options.prompt,
			maxSteps: settings.maxSteps,
			thinking: deepseek ? settings.thinking : undefined,
			reasoningEffort: deepseek ? settings.reasoningEffort : undefined,
			signal: controller.signal,
			authorize,
			onEvent: (event: AgentEvent) => {
				options.onEvent?.(event);
				switch (event.type) {
					case "text_delta":
						process.stdout.write(event.text);
						break;
					case "reasoning_delta":
						reasoningChars += event.text.length;
						break;
					case "tool_finished":
						process.stderr.write(
							`[tool] ${event.name} ${event.status}: ${event.summary}\n`,
						);
						break;
					case "error":
						process.stderr.write(`[error] ${event.message}\n`);
						break;
					case "done":
						process.stderr.write(
							`[done] reason=${event.reason} steps=${event.steps}\n`,
						);
						break;
					default:
						break;
				}
			},
		});

		if (reasoningChars > 0) {
			process.stderr.write(`[reasoning] ${reasoningChars} chars\n`);
		}
		process.stderr.write(
			`[usage] input=${result.usage.inputTokens} output=${result.usage.outputTokens} cache_hit=${result.usage.cacheHitTokens} cache_miss=${result.usage.cacheMissTokens} reasoning=${result.usage.reasoningTokens}\n`,
		);
		return exitCodeForReason(result.reason);
	} finally {
		process.off("SIGINT", onSigint);
	}
}
