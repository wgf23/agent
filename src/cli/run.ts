import { runAgent } from "../agent/agent.js";
import type { AgentDoneReason, AgentEvent } from "../agent/events.js";
import { loadConfig, type ModelSelection } from "../config/config.js";
import { readProjectConfig } from "../config/project-file.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { resolveModelSpec } from "../providers/presets.js";

export interface RunHeadlessOptions {
	prompt: string;
	model?: string;
	maxSteps?: number;
	yesAll?: boolean;
}

export function exitCodeForReason(reason: AgentDoneReason): number {
	return reason === "finished" ? 0 : 1;
}

export async function runHeadless(
	options: RunHeadlessOptions,
): Promise<number> {
	let selection: ModelSelection | undefined;
	if (options.model !== undefined) {
		const resolved = resolveModelSpec(options.model);
		if (!resolved.ok) {
			console.error(resolved.error);
			return 1;
		}
		selection = { preset: resolved.preset, model: resolved.model };
	}

	const loaded = loadConfig(selection);
	if (!loaded.ok) {
		console.error(loaded.error);
		return 1;
	}

	const config = loaded.config.provider;
	const provider = createOpenAICompatibleProvider({
		id: config.preset,
		baseURL: config.baseURL,
		apiKey: config.apiKey,
	});

	const workspaceRoot = process.cwd();
	const project = await readProjectConfig(workspaceRoot);
	if (!project.ok) {
		console.error(project.error);
		return 1;
	}
	const yesAll = options.yesAll ?? false;
	const rules = {
		...defaultRules(),
		...(project.config.permissions ?? {}),
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

	let reasoningChars = 0;
	try {
		const result = await runAgent({
			provider,
			model: config.model,
			workspaceRoot,
			prompt: options.prompt,
			maxSteps: options.maxSteps,
			signal: controller.signal,
			authorize,
			onEvent: (event: AgentEvent) => {
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
