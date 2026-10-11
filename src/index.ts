#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config/config.js";

// The bundle ships to dist/, so package.json is not reliably adjacent at runtime.
const VERSION = "0.0.1";

const program = new Command();

program
	.name("my-agent")
	.description("A terminal coding agent powered by DeepSeek.")
	.argument("[prompt]", "prompt to run")
	.option("-m, --model <model>", "model to use")
	.version(VERSION, "-V, --version")
	.action((prompt: string | undefined) => {
		if (!prompt) {
			console.log(`my-agent v${VERSION}`);
			console.log(
				'Pass a prompt to get started, for example: my-agent "list the files"',
			);
			return;
		}

		const result = loadConfig();
		if (!result.ok) {
			console.error(result.error);
			process.exitCode = 1;
			return;
		}

		console.log("Agent not implemented yet (Phase 3).");
	});

program.parse();
