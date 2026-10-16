import type { HooksConfig } from "../hooks/hooks.js";
import type {
	Message,
	Provider,
	ReasoningEffort,
	ThinkingSetting,
} from "../providers/types.js";
import { runAgent } from "./agent.js";
import type { Authorize } from "./authorize.js";
import type { AgentEvent } from "./events.js";

export type SubagentRunner = (
	task: string,
	signal?: AbortSignal,
) => Promise<string>;

export interface SubagentOptions {
	provider: Provider;
	model: string;
	workspaceRoot: string;
	authorize: Authorize;
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	hooks?: HooksConfig;
	// Every sub-agent event is offered to the caller, so its usage can be
	// counted into the parent's totals the way Rob.runSubagent does.
	onEvent?: (event: AgentEvent) => void;
}

// A sub-agent inherits the parent's provider, model, workspace, authorize,
// and thinking, and receives the standard tools only, so it cannot recurse.
export function createSubagentRunner(options: SubagentOptions): SubagentRunner {
	return async (task, signal) => {
		const parts: string[] = [];
		const result = await runAgent({
			provider: options.provider,
			model: options.model,
			workspaceRoot: options.workspaceRoot,
			prompt: task,
			history: [],
			signal,
			authorize: options.authorize,
			thinking: options.thinking,
			reasoningEffort: options.reasoningEffort,
			hooks: options.hooks,
			onEvent: (event) => {
				if (event.type === "text_delta") parts.push(event.text);
				options.onEvent?.(event);
			},
		});
		if (parts.length > 0) return parts.join("");
		return lastAssistantText(result.messages) ?? "";
	};
}

function lastAssistantText(messages: readonly Message[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		return text;
	}
	return null;
}
