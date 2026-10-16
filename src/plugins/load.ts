import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tools as builtinTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import {
	ARGUMENTS_TOKEN,
	BUILTIN_COMMAND_NAMES,
	type MyAgentPlugin,
	type PluginCommand,
} from "./types.js";

export interface LoadedPlugins {
	tools: Tool[];
	commands: PluginCommand[];
	extraInstructions: string;
	errors: string[];
	dispose: () => Promise<void>;
}

// Loads every spec in order. A spec starting with "." or "/" (or a Windows
// drive letter) is a path resolved against the workspace root; anything else is
// a bare package name resolved from the workspace's node_modules. A spec listed
// more than once loads once. One plugin's failure becomes an error entry and
// never stops the others.
export async function loadPlugins(
	specs: string[],
	workspaceRoot: string,
	extraInstructions?: string,
): Promise<LoadedPlugins> {
	const tools: Tool[] = [];
	const commands: PluginCommand[] = [];
	const prompts: string[] = [];
	const errors: string[] = [];
	const disposers: Array<{
		name: string;
		dispose: () => Promise<void> | void;
	}> = [];

	const builtinNames = new Set(builtinTools.map((tool) => tool.name));
	const toolOwners = new Map<string, string>();
	const builtinCommandNames = new Set(BUILTIN_COMMAND_NAMES);
	const commandOwners = new Map<string, string>();

	for (const spec of new Set(specs)) {
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
		const commandCollision = collidingCommand(
			plugin,
			builtinCommandNames,
			commandOwners,
		);
		if (commandCollision !== undefined) {
			errors.push(`plugin ${spec}: ${commandCollision}`);
			continue;
		}

		for (const tool of plugin.tools ?? []) {
			tools.push(tool);
			toolOwners.set(tool.name, plugin.name);
		}
		for (const command of plugin.commands ?? []) {
			commands.push(command);
			commandOwners.set(command.name, plugin.name);
		}
		if (
			plugin.systemPrompt !== undefined &&
			plugin.systemPrompt.trim() !== ""
		) {
			prompts.push(plugin.systemPrompt.trim());
		}
		if (plugin.dispose !== undefined) {
			disposers.push({ name: plugin.name, dispose: plugin.dispose });
		}
	}

	const sections: string[] = [];
	if (extraInstructions !== undefined && extraInstructions.trim() !== "") {
		sections.push(extraInstructions.trim());
	}
	sections.push(...prompts);

	return {
		tools,
		commands,
		extraInstructions: sections.join("\n\n"),
		errors,
		dispose: async () => {
			const results = await Promise.allSettled(
				disposers.map((entry) => Promise.resolve().then(() => entry.dispose())),
			);
			for (const [index, result] of results.entries()) {
				if (result.status === "rejected") {
					errors.push(
						`plugin ${disposers[index].name}: dispose failed: ${errorMessage(result.reason)}`,
					);
				}
			}
		},
	};
}

// Expands a submitted "/name args" line against the loaded plugin commands.
// The arguments substitute into the body's $ARGUMENTS token; a body without one
// appends them. An unknown name or a non-command line yields null so the caller
// falls back to its built-in handling.
export function expandPluginCommand(
	text: string,
	commands: readonly PluginCommand[],
): string | null {
	const input = text.trim();
	if (!input.startsWith("/")) return null;

	const whitespace = input.search(/\s/);
	const token = whitespace === -1 ? input : input.slice(0, whitespace);
	const name = token.slice(1);
	if (name === "") return null;

	const args = whitespace === -1 ? "" : input.slice(whitespace).trim();
	const command = commands.find((entry) => entry.name === name);
	if (command === undefined) return null;

	if (command.body.includes(ARGUMENTS_TOKEN)) {
		return command.body.split(ARGUMENTS_TOKEN).join(args);
	}
	return args === "" ? command.body : `${command.body.trimEnd()} ${args}`;
}

async function importPlugin(
	spec: string,
	workspaceRoot: string,
): Promise<{ ok: true; plugin: MyAgentPlugin } | { ok: false; error: string }> {
	const target = resolvePluginTarget(spec, workspaceRoot);
	if (!target.ok) return target;
	try {
		const namespace = (await import(target.url)) as Record<string, unknown>;
		return { ok: true, plugin: extractPlugin(namespace) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function resolvePluginTarget(
	spec: string,
	workspaceRoot: string,
): { ok: true; url: string } | { ok: false; error: string } {
	if (isAbsoluteSpecifier(spec)) {
		return { ok: true, url: pathToFileURL(spec).href };
	}
	if (spec.startsWith(".")) {
		const resolved = path.resolve(workspaceRoot, spec);
		if (escapesWorkspace(workspaceRoot, resolved)) {
			return { ok: false, error: "spec escapes the workspace root." };
		}
		return { ok: true, url: pathToFileURL(resolved).href };
	}
	// A bare package name resolves from the workspace's own node_modules so a
	// plugin installed in the workspace loads even from a global install.
	try {
		const require = createRequire(path.join(workspaceRoot, "package.json"));
		return { ok: true, url: pathToFileURL(require.resolve(spec)).href };
	} catch (error) {
		return {
			ok: false,
			error: `could not resolve from the workspace: ${errorMessage(error)}`,
		};
	}
}

function isAbsoluteSpecifier(spec: string): boolean {
	return path.isAbsolute(spec) || /^[a-zA-Z]:[\\/]/.test(spec);
}

function escapesWorkspace(workspaceRoot: string, target: string): boolean {
	const rel = path.relative(path.resolve(workspaceRoot), target);
	return (
		rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
	);
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
			if (
				typeof tool.description !== "string" ||
				tool.description.trim() === ""
			) {
				return {
					ok: false,
					error: `tool at index ${index} must have a string "description".`,
				};
			}
			if (tool.readOnly !== undefined && typeof tool.readOnly !== "boolean") {
				return {
					ok: false,
					error: `tool at index ${index} "readOnly" must be a boolean.`,
				};
			}
			if (tool.readOnly === undefined) tool.readOnly = false;
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
			if (
				typeof command.description !== "string" ||
				command.description.trim() === ""
			) {
				return {
					ok: false,
					error: `command at index ${index} must have a string "description".`,
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

function collidingCommand(
	plugin: MyAgentPlugin,
	builtinNames: ReadonlySet<string>,
	owners: ReadonlyMap<string, string>,
): string | undefined {
	for (const command of plugin.commands ?? []) {
		if (builtinNames.has(command.name)) {
			return `command "${command.name}" collides with the built-in command "${command.name}".`;
		}
		const owner = owners.get(command.name);
		if (owner !== undefined) {
			return `command "${command.name}" collides with the command "${command.name}" from plugin "${owner}".`;
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
