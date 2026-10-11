import { runAgent } from "../agent/agent.js";
import type { AgentDoneReason, AgentEvent } from "../agent/events.js";
import { loadConfig, type ModelSelection } from "../config/config.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { resolveModelSpec } from "../providers/presets.js";

export interface RunHeadlessOptions {
	prompt: string;
	model?: string;
	maxSteps?: number;
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

	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);

	let reasoningChars = 0;
	try {
		const result = await runAgent({
			provider,
			model: config.model,
			workspaceRoot: process.cwd(),
			prompt: options.prompt,
			maxSteps: options.maxSteps,
			signal: controller.signal,
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
							`[tool] ${event.name} ${event.ok ? "ok" : "blocked"}: ${event.summary}\n`,
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
