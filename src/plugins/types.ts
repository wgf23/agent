import type { Command } from "../commands/commands.js";
import type { Tool } from "../tools/types.js";

export interface PluginContext {
	workspaceRoot: string;
}

// A plugin is an in-process ESM module that contributes tools, slash commands,
// and extra system-prompt text. It runs with the agent's full privileges, so
// only load plugins you trust.
export interface MyAgentPlugin {
	name: string;
	tools?: Tool[];
	commands?: Command[];
	systemPrompt?: string;
	dispose?: () => Promise<void> | void;
}
