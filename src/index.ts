#!/usr/bin/env node
import { Command } from "commander";
import { runConfigCommand } from "./cli/config.js";
import { runHeadless } from "./cli/run.js";
import { runTui } from "./tui/index.js";

// The bundle ships to dist/, so package.json is not reliably adjacent at runtime.
const VERSION = "0.0.1";

interface RunOptions {
	model?: string;
	maxSteps?: string;
	yes?: boolean;
}

function parseMaxSteps(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number.parseInt(value, 10);
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

await program.parseAsync(process.argv);
