import type { Tool } from "../tools/types.js";

export interface PluginContext {
	workspaceRoot: string;
}

export interface PluginCommand {
	name: string;
	description: string;
	body: string;
}

export const ARGUMENTS_TOKEN = "$ARGUMENTS";

// Slash commands the TUI already owns. A plugin command that reuses one of
// these names is skipped so it can never shadow a built-in.
export const BUILTIN_COMMAND_NAMES: readonly string[] = [
	"help",
	"clear",
	"compact",
	"model",
	"allow-all",
	"quit",
	"image",
];

// A plugin is an in-process ESM module that contributes tools, slash commands,
// and extra system-prompt text. It runs with the agent's full privileges, so
// only load plugins you trust.
export interface MyAgentPlugin {
	name: string;
	tools?: Tool[];
	commands?: PluginCommand[];
	systemPrompt?: string;
	dispose?: () => Promise<void> | void;
}
