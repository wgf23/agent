#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { runConfigCommand } from "./cli/config.js";
import { runHeadless } from "./cli/run.js";
import { runSetupCommand } from "./cli/setup.js";
import { runSkillAdd, runSkillList, runSkillRemove } from "./cli/skill.js";
import { runTeamCommand } from "./cli/team.js";
import { runTui } from "./tui/index.js";

// src/ and dist/ both sit one level below package.json, so this resolves from
// either the tsx source run or the built bundle.
const { version: VERSION } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

interface RunOptions {
	model?: string;
	maxSteps?: string;
	yes?: boolean;
}

interface TeamOptions {
	dispatch: string[];
	waitMs?: string;
	yes?: boolean;
}

function parseMaxSteps(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number.parseInt(value, 10);
}

function parseWaitMs(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number.parseInt(value, 10);
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

async function run(prompt: string, options: RunOptions): Promise<void> {
	process.exitCode = await runHeadless({
		prompt,
		model: options.model,
		maxSteps: parseMaxSteps(options.maxSteps),
		yesAll: options.yes,
	});
}

const program = new Command();

program
	.name("my-agent")
	.description("A terminal coding agent powered by DeepSeek.")
	// Without positional options the root's -m/--max-steps/--yes swallow the same
	// flags when they follow the `run` subcommand.
	.enablePositionalOptions()
	.argument("[prompt]", "prompt to run")
	.option("-m, --model <model>", "model to use")
	.option("--max-steps <steps>", "maximum agent steps")
	.option("--yes", "auto-approve every tool call")
	.version(VERSION, "-V, --version")
	.action(async (prompt: string | undefined, options: RunOptions) => {
		if (!prompt) {
			await runTui({
				workspaceRoot: process.cwd(),
				model: options.model,
				maxSteps: parseMaxSteps(options.maxSteps),
			});
			return;
		}
		await run(prompt, options);
	});

program
	.command("run")
	.description("Run a prompt headlessly and stream the answer")
	.argument("<prompt>", "prompt to run")
	.option("-m, --model <model>", "model to use")
	.option("--max-steps <steps>", "maximum agent steps")
	.option("--yes", "auto-approve every tool call")
	.action(async (prompt: string, options: RunOptions) => {
		await run(prompt, options);
	});

program
	.command("config")
	.description(
		"Print the resolved configuration and where each value came from",
	)
	.action(() => {
		process.exitCode = runConfigCommand();
	});

program
	.command("setup")
	.description("Store an API key and choose the provider, model, and endpoint")
	.action(async () => {
		process.exitCode = await runSetupCommand();
	});

program
	.command("team")
	.description("Run the configured robs headlessly")
	.option(
		"--dispatch <name=text>",
		"dispatch a task to a rob (repeatable)",
		collect,
		[],
	)
	.option("--wait-ms <ms>", "maximum time to wait for the team to go idle")
	.option("--yes", "auto-approve every tool call")
	.action(async (options: TeamOptions) => {
		process.exitCode = await runTeamCommand({
			dispatch: options.dispatch,
			waitMs: parseWaitMs(options.waitMs),
			yesAll: options.yes,
		});
	});

const skill = program
	.command("skill")
	.description("Install, list, and remove skills from npm");

skill
	.command("add")
	.description("Install a skill package from npm or a local path")
	.argument("<spec>", "npm package spec or local directory")
	.action(async (spec: string) => {
		process.exitCode = await runSkillAdd(spec);
	});

skill
	.command("list")
	.description("List installed skills")
	.action(async () => {
		process.exitCode = await runSkillList();
	});

skill
	.command("remove")
	.description("Remove the installed skill with this name")
	.argument("<name>", "skill name")
	.action(async (name: string) => {
		process.exitCode = await runSkillRemove(name);
	});

await program.parseAsync(process.argv);
