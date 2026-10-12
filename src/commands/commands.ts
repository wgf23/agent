export interface Command {
	name: string;
	description: string;
	body: string;
}

export const ARGUMENTS_TOKEN = "$ARGUMENTS";

// Slash commands the TUI already owns. A custom command that reuses one of
// these names is skipped so it can never shadow a built-in.
export const BUILTIN_COMMAND_NAMES: readonly string[] = [
	"help",
	"clear",
	"compact",
	"model",
	"allow-all",
	"quit",
];

// Expands a submitted "/name args" line against the loaded commands. The
// arguments substitute into the body's $ARGUMENTS token; a body without one
// appends them. An unknown name or a non-command line yields null so the caller
// falls back to its built-in handling.
export function expandCommand(
	text: string,
	commands: readonly Command[],
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
