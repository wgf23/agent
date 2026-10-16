#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_PORT } from "../shared/protocol.js";
import { runAgentsInstall, runAgentsList } from "./cli/agents.js";
import { runConfigCommand } from "./cli/config.js";
import { runInitCommand } from "./cli/init.js";
import { type OutputFormat, runHeadless } from "./cli/run.js";
import {
	runSessionsForkCommand,
	runSessionsListCommand,
} from "./cli/sessions.js";
import { runSetupCommand } from "./cli/setup.js";
import { runSkillAdd, runSkillList, runSkillRemove } from "./cli/skill.js";
import { runTeamCommand } from "./cli/team.js";
import { runServe } from "./serve/server.js";
import { runTui } from "./tui/index.js";
import { MAX_IMAGES_PER_MESSAGE } from "./util/image.js";

// src/ and dist/ both sit one level below package.json, so this resolves from
// either the tsx source run or the built bundle.
const { version: VERSION } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

interface RunOptions {
	model?: string;
	maxSteps?: string;
	maxCost?: string;
	yes?: boolean;
	continue?: boolean;
	session?: string;
	outputFormat?: string;
	image?: string[];
}

interface TeamOptions {
	dispatch: string[];
	waitMs?: string;
	yes?: boolean;
}

interface ServeOptions {
	port?: string;
	host?: string;
	open?: boolean;
	model?: string;
	maxSteps?: string;
}

interface ForkOptions {
	at?: number;
}

function parseMaxSteps(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number.parseInt(value, 10);
}

function parseMaxCost(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const cost = Number(value);
	return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function parseOutputFormat(value: string | undefined): OutputFormat {
	return value === "json" ? "json" : "text";
}

function parseInteger(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`Expected an integer, got: ${value}`);
	}
	return parsed;
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port >= 0 && port <= 65535
		? port
		: undefined;
}

function parseWaitMs(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number.parseInt(value, 10);
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function collectImage(value: string, previous: string[]): string[] {
	if (previous.length >= MAX_IMAGES_PER_MESSAGE) {
		throw new InvalidArgumentError(
			`at most ${MAX_IMAGES_PER_MESSAGE} images per message`,
		);
	}
	return [...previous, value];
}

async function run(prompt: string, options: RunOptions): Promise<void> {
	process.exitCode = await runHeadless({
		prompt,
		imagePaths: options.image,
		model: options.model,
		maxSteps: parseMaxSteps(options.maxSteps),
		maxCost: parseMaxCost(options.maxCost),
		yesAll: options.yes,
		continueSession: options.continue,
		sessionId: options.session,
		outputFormat: parseOutputFormat(options.outputFormat),
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
	.option("--max-cost <usd>", "stop when the accumulated cost exceeds this")
	.option("--yes", "auto-approve every tool call")
	.option("--continue", "resume the latest session for this workspace")
	.option("--session <id>", "resume a specific session by id")
	.option("--output-format <format>", "output format: text or json", "text")
	.option(
		"--image <path>",
		"attach an image to the prompt (repeatable)",
		collectImage,
		[],
	)
	.version(VERSION, "-V, --version")
	.action(async (prompt: string | undefined, options: RunOptions) => {
		if (!prompt) {
			await runTui({
				workspaceRoot: process.cwd(),
				model: options.model,
				maxSteps: parseMaxSteps(options.maxSteps),
				maxCost: parseMaxCost(options.maxCost),
				continueSession: options.continue,
				sessionId: options.session,
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
	.option("--max-cost <usd>", "stop when the accumulated cost exceeds this")
	.option("--yes", "auto-approve every tool call")
	.option("--continue", "resume the latest session for this workspace")
	.option("--session <id>", "resume a specific session by id")
	.option("--output-format <format>", "output format: text or json", "text")
	.option(
		"--image <path>",
		"attach an image to the prompt (repeatable)",
		collectImage,
		[],
	)
	.action(async (prompt: string, options: RunOptions) => {
		await run(prompt, options);
	});

const sessions = program
	.command("sessions")
	.description("Inspect saved sessions");

sessions
	.command("list")
	.description("List saved sessions for the current workspace")
	.action(async () => {
		process.exitCode = await runSessionsListCommand();
	});

sessions
	.command("fork")
	.description("Fork a saved session into a new one")
	.argument("<id>", "session id to fork")
	.option("--at <n>", "keep only the first n messages", parseInteger)
	.action(async (id: string, options: ForkOptions) => {
		process.exitCode = await runSessionsForkCommand({
			id,
			at: options.at,
		});
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
	.command("serve")
	.description("Start the local web UI in a browser")
	.option("-p, --port <port>", "port to listen on", String(DEFAULT_PORT))
	.option("--host <host>", "host to bind to", "127.0.0.1")
	.option("--open", "open the browser after the server starts")
	.option("-m, --model <model>", "model to use")
	.option("--max-steps <steps>", "maximum agent steps")
	.action(async (options: ServeOptions) => {
		await runServe({
			workspaceRoot: process.cwd(),
			model: options.model,
			maxSteps: parseMaxSteps(options.maxSteps),
			port: parsePort(options.port),
			host: options.host,
			open: options.open,
			webDist: fileURLToPath(new URL("../web/dist", import.meta.url)),
			consolidate: true,
		});
	});

program
	.command("setup")
	.description("Store an API key and choose the provider, model, and endpoint")
	.action(async () => {
		process.exitCode = await runSetupCommand();
	});

program
	.command("init")
	.description("Draft an AGENTS.md for the current workspace")
	.option("-f, --force", "overwrite an existing AGENTS.md")
	.action(async (options: { force?: boolean }) => {
		process.exitCode = await runInitCommand({ force: options.force });
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

const agents = program
	.command("agents")
	.description("Install and list external agent CLIs")
	.action(async () => {
		process.exitCode = await runAgentsList();
	});

agents
	.command("list")
	.description("List the recognized agent CLIs and whether they are installed")
	.action(async () => {
		process.exitCode = await runAgentsList();
	});

agents
	.command("install")
	.description("Install an external agent CLI from npm")
	.argument("<id>", "agent id (pi, opencode, claude, codex, or gemini)")
	.option("--yes", "skip the confirmation prompt")
	.action(async (id: string, options: { yes?: boolean }) => {
		process.exitCode = await runAgentsInstall(id, { yes: options.yes });
	});

await program.parseAsync(process.argv);
