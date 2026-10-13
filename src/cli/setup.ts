import os from "node:os";
import { createInterface } from "node:readline";
import OpenAI from "openai";
import { readCredentials, writeCredential } from "../config/credentials.js";
import { writeGlobalProviderSettings } from "../config/global-file.js";
import { resolveConfig } from "../config/resolve.js";
import { friendlyProviderError } from "../providers/errors.js";
import {
	type BuiltinPresetName,
	DEFAULT_PRESET,
	PRESETS,
} from "../providers/presets.js";

export type MissingKeyDecision = "none" | "setup" | "error";

export function missingKeyDecision(
	apiKey: string | undefined,
	isTty: boolean,
): MissingKeyDecision {
	if (apiKey !== undefined) return "none";
	return isTty ? "setup" : "error";
}

export interface SetupIo {
	ask(prompt: string): Promise<string>;
	askHidden(prompt: string): Promise<string>;
	print(line: string): void;
}

export interface SetupVerifyInput {
	baseURL: string;
	model: string;
	apiKeyEnv: string;
	apiKey: string;
}

export type SetupVerifyResult = { ok: true } | { ok: false; error: string };

export type SetupVerify = (
	input: SetupVerifyInput,
) => Promise<SetupVerifyResult>;

export interface SetupCurrentProvider {
	preset: string;
	model: string;
	baseURL: string;
	apiKeyEnv: string;
}

export interface RunSetupWizardOptions {
	io: SetupIo;
	homeDir: string;
	env: Record<string, string | undefined>;
	verify: SetupVerify;
	currentProvider?: SetupCurrentProvider;
}

class SetupAbortError extends Error {
	constructor() {
		super("Setup aborted.");
		this.name = "SetupAbortError";
	}
}

export async function runSetupCommand(): Promise<number> {
	const homeDir = os.homedir();
	const resolved = resolveConfig({
		workspaceRoot: process.cwd(),
		env: process.env,
		homeDir,
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { io, close } = createSetupIo();
	try {
		return await runSetupWizard({
			io,
			homeDir,
			env: process.env,
			verify: verifyApiKey,
			currentProvider: {
				preset: resolved.config.provider.preset,
				model: resolved.config.provider.model,
				baseURL: resolved.config.provider.baseURL,
				apiKeyEnv: resolved.config.provider.apiKeyEnv,
			},
		});
	} finally {
		close();
	}
}

export async function runSetupWizard(
	options: RunSetupWizardOptions,
): Promise<number> {
	const { io } = options;
	try {
		const choice = await askProviderChoice(
			io,
			defaultPresetName(options.currentProvider),
		);

		let preset: BuiltinPresetName;
		let model: string;
		let baseURL: string;
		let apiKeyEnv: string;
		let custom = false;

		if (choice === "custom") {
			custom = true;
			baseURL = await askRequired(io, "Base URL: ", "A base URL is required.");
			apiKeyEnv =
				(await io.ask("API key env var (DEEPSEEK_API_KEY): ")).trim() ||
				"DEEPSEEK_API_KEY";
			model = await askRequired(io, "Model: ", "A model is required.");
			// resolveConfig only accepts the built-in presets, so a custom endpoint
			// is stored as the built-in preset whose model rules accept the model.
			preset = model.startsWith("deepseek") ? "deepseek" : "openai";
		} else {
			preset = choice;
			baseURL = PRESETS[preset].baseURL;
			apiKeyEnv = PRESETS[preset].apiKeyEnv;
			const answer = (
				await io.ask(`Model (${PRESETS[preset].defaultModel}): `)
			).trim();
			model = answer === "" ? PRESETS[preset].defaultModel : answer;
		}

		const credentials = readCredentials(options.homeDir);
		if (!credentials.ok) {
			io.print(credentials.error);
			return 1;
		}
		const envKey = options.env[apiKeyEnv];
		const storedKey = credentials.keys[apiKeyEnv];
		const existing = envKey ?? storedKey;

		let newKey: string | undefined;
		if (existing !== undefined) {
			const via =
				envKey !== undefined
					? `the environment variable ${apiKeyEnv}`
					: `${apiKeyEnv} in the credentials file`;
			io.print(`A key is already configured via ${via}.`);
			const answer = (
				await io.askHidden(
					"Enter a new key to replace it, or press Enter to keep it: ",
				)
			).trim();
			if (answer !== "") newKey = answer;
		} else {
			let answer = (await io.askHidden(`API key for ${apiKeyEnv}: `)).trim();
			if (answer === "") {
				io.print("No key entered.");
				answer = (await io.askHidden(`API key for ${apiKeyEnv}: `)).trim();
				if (answer === "") {
					io.print("No key entered. Setup aborted.");
					return 1;
				}
			}
			newKey = answer;
		}

		if (newKey !== undefined) {
			const verified = await options.verify({
				baseURL,
				model,
				apiKeyEnv,
				apiKey: newKey,
			});
			if (!verified.ok) {
				io.print(verified.error);
				const answer = (await io.ask("Save anyway? [y/N] "))
					.trim()
					.toLowerCase();
				if (answer !== "y" && answer !== "yes") {
					io.print("Nothing was saved.");
					return 1;
				}
			}
			const stored = await writeCredential(options.homeDir, apiKeyEnv, newKey);
			if (!stored.ok) {
				io.print(stored.error);
				return 1;
			}
			io.print(`Stored key for ${apiKeyEnv} in ${stored.path}.`);
		} else {
			io.print(`Keeping the existing key for ${apiKeyEnv}.`);
		}

		const baseline = options.currentProvider ?? {
			preset: DEFAULT_PRESET,
			model: PRESETS[DEFAULT_PRESET].defaultModel,
			baseURL: PRESETS[DEFAULT_PRESET].baseURL,
			apiKeyEnv: PRESETS[DEFAULT_PRESET].apiKeyEnv,
		};
		const changed =
			baseline.preset !== preset ||
			baseline.model !== model ||
			baseline.baseURL !== baseURL ||
			baseline.apiKeyEnv !== apiKeyEnv;
		if (changed) {
			const written = await writeGlobalProviderSettings(
				options.homeDir,
				custom ? { preset, model, baseURL, apiKeyEnv } : { preset, model },
			);
			if (!written.ok) {
				io.print(written.error);
				return 1;
			}
		}

		io.print(`Configured ${preset} / ${model}.`);
		if (custom) {
			io.print(`Endpoint ${baseURL}, key env ${apiKeyEnv}.`);
		}
		io.print(
			'Run "my-agent" to start. Run "my-agent run ..." for headless mode.',
		);
		return 0;
	} catch (error) {
		if (error instanceof SetupAbortError) return 1;
		throw error;
	}
}

function defaultPresetName(
	current: SetupCurrentProvider | undefined,
): BuiltinPresetName {
	if (current?.preset === "deepseek" || current?.preset === "openai") {
		return current.preset;
	}
	return DEFAULT_PRESET;
}

async function askProviderChoice(
	io: SetupIo,
	defaultPreset: BuiltinPresetName,
): Promise<BuiltinPresetName | "custom"> {
	for (;;) {
		const answer = (
			await io.ask(`Provider [deepseek/openai/custom] (${defaultPreset}): `)
		)
			.trim()
			.toLowerCase();
		if (answer === "") return defaultPreset;
		if (answer === "deepseek" || answer === "openai" || answer === "custom") {
			return answer;
		}
		io.print(
			`Unknown provider "${answer}". Choose deepseek, openai, or custom.`,
		);
	}
}

async function askRequired(
	io: SetupIo,
	prompt: string,
	emptyMessage: string,
): Promise<string> {
	for (;;) {
		const answer = (await io.ask(prompt)).trim();
		if (answer !== "") return answer;
		io.print(emptyMessage);
	}
}

export function createSetupIo(): { io: SetupIo; close: () => void } {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const tty = Boolean(stdin.isTTY);
	const piped = tty ? undefined : createPipedReader();

	const io: SetupIo = {
		ask: async (prompt) => {
			if (tty) return readTtyLine(prompt, false);
			stdout.write(`${prompt}\n`);
			return piped?.read() ?? "";
		},
		askHidden: async (prompt) => {
			if (tty) return readTtyLine(prompt, true);
			stdout.write(`${prompt}\n`);
			stdout.write(
				"Warning: input is visible because stdin is not a terminal.\n",
			);
			return piped?.read() ?? "";
		},
		print: (line) => {
			stdout.write(`${line}\n`);
		},
	};

	return { io, close: () => piped?.close() };
}

export async function verifyApiKey(
	input: SetupVerifyInput,
): Promise<SetupVerifyResult> {
	const client = new OpenAI({
		baseURL: input.baseURL,
		apiKey: input.apiKey,
		maxRetries: 0,
	});
	try {
		await client.models.list();
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: friendlyProviderError(error, {
				baseURL: input.baseURL,
				apiKeyEnv: input.apiKeyEnv,
				debug: process.env.MY_AGENT_DEBUG !== undefined,
			}),
		};
	}
}

function readTtyLine(prompt: string, mask: boolean): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		stdout.write(prompt);

		const wasRaw = stdin.isRaw ?? false;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		let value = "";
		const finish = (): void => {
			stdin.setRawMode(wasRaw);
			stdin.pause();
			stdin.off("data", onData);
		};
		const onData = (chunk: string): void => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					stdout.write("\n");
					resolve(value);
					return;
				}
				if (char === "\u0003") {
					finish();
					stdout.write("\n");
					reject(new SetupAbortError());
					return;
				}
				if (char === "\u007f" || char === "\b") {
					if (value.length > 0) {
						value = value.slice(0, -1);
						stdout.write("\b \b");
					}
					continue;
				}
				if (char >= " ") {
					value += char;
					stdout.write(mask ? "*" : char);
				}
			}
		};
		stdin.on("data", onData);
	});
}

function createPipedReader(): {
	read: () => Promise<string>;
	close: () => void;
} {
	const rl = createInterface({ input: process.stdin, terminal: false });
	const lines: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	let closed = false;

	rl.on("line", (line) => {
		const waiter = waiters.shift();
		if (waiter !== undefined) waiter(line);
		else lines.push(line);
	});
	rl.on("close", () => {
		closed = true;
		for (const waiter of waiters.splice(0)) waiter("");
	});

	return {
		read: () => {
			const line = lines.shift();
			if (line !== undefined) return Promise.resolve(line);
			if (closed) return Promise.resolve("");
			return new Promise((resolve) => waiters.push(resolve));
		},
		close: () => rl.close(),
	};
}
