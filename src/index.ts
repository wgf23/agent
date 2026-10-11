#!/usr/bin/env node
import { Command } from "commander";
import { runHeadless } from "./cli/run.js";

// The bundle ships to dist/, so package.json is not reliably adjacent at runtime.
const VERSION = "0.0.1";

interface RunOptions {
	model?: string;
	maxSteps?: string;
}

async function run(prompt: string, options: RunOptions): Promise<void> {
	const maxSteps =
		options.maxSteps === undefined
			? undefined
			: Number.parseInt(options.maxSteps, 10);
	process.exitCode = await runHeadless({
		prompt,
		model: options.model,
		maxSteps,
	});
}

const program = new Command();

program
	.name("my-agent")
	.description("A terminal coding agent powered by DeepSeek.")
	.argument("[prompt]", "prompt to run")
	.option("-m, --model <model>", "model to use")
	.option("--max-steps <steps>", "maximum agent steps", "25")
	.version(VERSION, "-V, --version")
	.action(async (prompt: string | undefined, options: RunOptions) => {
		if (!prompt) {
			console.log(`my-agent v${VERSION}`);
			console.log(
				'Pass a prompt to get started, for example: my-agent "list the files"',
			);
			return;
		}
		await run(prompt, options);
	});

program
	.command("run")
	.description("Run a prompt headlessly and stream the answer")
	.argument("<prompt>", "prompt to run")
	.option("-m, --model <model>", "model to use")
	.option("--max-steps <steps>", "maximum agent steps", "25")
	.action(async (prompt: string, options: RunOptions) => {
		await run(prompt, options);
	});

await program.parseAsync(process.argv);
