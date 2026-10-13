import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "../commands/commands.js";
import { tools as builtinTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import type { MyAgentPlugin } from "./types.js";

export interface LoadedPlugins {
	tools: Tool[];
	commands: Command[];
	systemPrompt: string;
	errors: string[];
	dispose: () => Promise<void>;
}

// Loads every spec in order. A spec starting with "." or "/" is a path resolved
// against the workspace root; anything else is a bare module specifier left to
// the runtime. One plugin's failure becomes an error entry and never stops the
// others.
export async function loadPlugins(
	specs: string[],
	workspaceRoot: string,
): Promise<LoadedPlugins> {
	const tools: Tool[] = [];
	const commands: Command[] = [];
	const prompts: string[] = [];
	const errors: string[] = [];
	const disposers: Array<() => Promise<void> | void> = [];

	const builtinNames = new Set(builtinTools.map((tool) => tool.name));
	const toolOwners = new Map<string, string>();

	for (const spec of specs) {
		const imported = await importPlugin(spec, workspaceRoot);
		if (!imported.ok) {
			errors.push(`plugin ${spec}: ${imported.error}`);
			continue;
		}

		const validated = validatePlugin(imported.plugin);
		if (!validated.ok) {
			errors.push(`plugin ${spec}: ${validated.error}`);
			continue;
		}
		const plugin = validated.plugin;

		const collision = collidingTool(plugin, builtinNames, toolOwners);
		if (collision !== undefined) {
			errors.push(`plugin ${spec}: ${collision}`);
			continue;
		}

		for (const tool of plugin.tools ?? []) {
			tools.push(tool);
			toolOwners.set(tool.name, plugin.name);
		}
		if (plugin.commands !== undefined) commands.push(...plugin.commands);
		if (
			plugin.systemPrompt !== undefined &&
			plugin.systemPrompt.trim() !== ""
		) {
			prompts.push(plugin.systemPrompt.trim());
		}
		if (plugin.dispose !== undefined) disposers.push(plugin.dispose);
	}

	return {
		tools,
		commands,
		systemPrompt: prompts.join("\n\n"),
		errors,
		dispose: async () => {
			await Promise.all(disposers.map((dispose) => Promise.resolve(dispose())));
		},
	};
}

async function importPlugin(
	spec: string,
	workspaceRoot: string,
): Promise<{ ok: true; plugin: MyAgentPlugin } | { ok: false; error: string }> {
	const target =
		spec.startsWith(".") || spec.startsWith("/")
			? pathToFileURL(path.resolve(workspaceRoot, spec)).href
			: spec;
	try {
		const namespace = (await import(target)) as Record<string, unknown>;
		return { ok: true, plugin: extractPlugin(namespace) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

// A plugin module exports either the plugin object directly or as its default.
function extractPlugin(namespace: Record<string, unknown>): MyAgentPlugin {
	return namespace.default !== undefined
		? (namespace.default as MyAgentPlugin)
		: (namespace as unknown as MyAgentPlugin);
}

function validatePlugin(
	value: unknown,
): { ok: true; plugin: MyAgentPlugin } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "does not export a plugin object." };
	}
	if (typeof value.name !== "string" || value.name.trim() === "") {
		return { ok: false, error: 'missing a non-empty "name".' };
	}

	const tools = value.tools;
	if (tools !== undefined) {
		if (!Array.isArray(tools)) {
			return { ok: false, error: '"tools" must be an array.' };
		}
		for (const [index, tool] of tools.entries()) {
			if (
				!isRecord(tool) ||
				typeof tool.name !== "string" ||
				tool.name.trim() === "" ||
				typeof tool.execute !== "function"
			) {
				return {
					ok: false,
					error: `tool at index ${index} must be an object with a "name" and an "execute".`,
				};
			}
		}
	}

	const commands = value.commands;
	if (commands !== undefined) {
		if (!Array.isArray(commands)) {
			return { ok: false, error: '"commands" must be an array.' };
		}
		for (const [index, command] of commands.entries()) {
			if (
				!isRecord(command) ||
				typeof command.name !== "string" ||
				command.name.trim() === "" ||
				typeof command.body !== "string"
			) {
				return {
					ok: false,
					error: `command at index ${index} must have a "name" and a "body".`,
				};
			}
		}
	}

	if (
		value.systemPrompt !== undefined &&
		typeof value.systemPrompt !== "string"
	) {
		return { ok: false, error: '"systemPrompt" must be a string.' };
	}
	if (value.dispose !== undefined && typeof value.dispose !== "function") {
		return { ok: false, error: '"dispose" must be a function.' };
	}

	return { ok: true, plugin: value as unknown as MyAgentPlugin };
}

function collidingTool(
	plugin: MyAgentPlugin,
	builtinNames: ReadonlySet<string>,
	toolOwners: ReadonlyMap<string, string>,
): string | undefined {
	for (const tool of plugin.tools ?? []) {
		if (builtinNames.has(tool.name)) {
			return `tool "${tool.name}" collides with the built-in tool "${tool.name}".`;
		}
		const owner = toolOwners.get(tool.name);
		if (owner !== undefined) {
			return `tool "${tool.name}" collides with the tool "${tool.name}" from plugin "${owner}".`;
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
