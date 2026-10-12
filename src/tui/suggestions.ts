export const MAX_SUGGESTIONS = 6;

export interface Suggestion {
	value: string;
	label: string;
	hint?: string;
}

export interface CommandSpec {
	name: string;
	hint: string;
}

// The command list is the single source for both /help and the menu.
export const COMMANDS: readonly CommandSpec[] = [
	{ name: "/help", hint: "list the commands" },
	{ name: "/clear", hint: "clear the transcript" },
	{ name: "/model", hint: "show the current model" },
	{ name: "/quit", hint: "exit my-agent" },
];

export interface MenuState {
	dismissed: boolean;
	index: number;
}

// Neutral: input changed, so the menu may reopen. Openness also needs matches.
export const MENU_NEUTRAL: MenuState = { dismissed: false, index: 0 };
// Closed: Esc, submit, history recall, or an approval dialog suppress the menu.
export const MENU_CLOSED: MenuState = { dismissed: true, index: 0 };

// A menu only applies to a single-line prefix token. A space moves into
// arguments and a newline ends the line, so both close the menu.
function leadingQuery(input: string, prefix: string): string | null {
	if (input.includes("\n")) return null;
	if (!input.startsWith(prefix)) return null;
	if (input.includes(" ")) return null;
	return input.slice(prefix.length).toLowerCase();
}

export function commandSuggestions(input: string): Suggestion[] {
	const query = leadingQuery(input, "/");
	if (query === null) return [];
	return COMMANDS.filter((command) =>
		command.name.slice(1).toLowerCase().startsWith(query),
	)
		.slice(0, MAX_SUGGESTIONS)
		.map((command) => ({
			value: command.name,
			label: command.name,
			hint: command.hint,
		}));
}

export function robSuggestions(
	input: string,
	names: readonly string[],
): Suggestion[] {
	const query = leadingQuery(input, "@");
	if (query === null) return [];
	return names
		.filter((name) => name.toLowerCase().startsWith(query))
		.slice(0, MAX_SUGGESTIONS)
		.map((name) => ({ value: `@${name}`, label: `@${name}` }));
}

export function isMenuOpen(
	menu: MenuState,
	suggestions: readonly Suggestion[],
): boolean {
	return !menu.dismissed && suggestions.length > 0;
}

export function moveMenu(
	menu: MenuState,
	suggestions: readonly Suggestion[],
	delta: 1 | -1,
): MenuState {
	if (suggestions.length === 0) return MENU_CLOSED;
	const count = suggestions.length;
	return {
		dismissed: false,
		index: (((menu.index + delta) % count) + count) % count,
	};
}
