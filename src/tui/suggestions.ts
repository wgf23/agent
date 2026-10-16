export const MAX_SUGGESTIONS = 6;

export interface Suggestion {
	value: string;
	label: string;
	hint?: string;
	// Start index in the input of the token this suggestion replaces. Command
	// and rob-name completion own the whole line, so their anchor is 0.
	anchor: number;
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
	{ name: "/allow-all", hint: "auto-approve every tool call" },
	{ name: "/compact", hint: "summarize the older messages" },
];

// Team mode runs these commands; /clear and /model have no team handler.
export const TEAM_COMMANDS: readonly CommandSpec[] = [
	{ name: "/help", hint: "list the commands" },
	{ name: "/dm", hint: "open direct messages" },
	{ name: "/sub", hint: "open sub-agents" },
	{ name: "/room", hint: "create, select, or update a room" },
	{ name: "/rooms", hint: "list the rooms" },
	{ name: "/quit", hint: "exit my-agent" },
	{ name: "/allow-all", hint: "auto-approve every tool call" },
];

// Plugin commands, appended after the built-ins. commandSuggestions reads this
// through its default parameter so the reducer's menu accept/navigation and the
// input's live menu share one list.
let customCommandSpecs: readonly CommandSpec[] = [];

export function setCustomCommands(commands: readonly CommandSpec[]): void {
	customCommandSpecs = commands;
}

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

export function commandSuggestions(
	input: string,
	commands: readonly CommandSpec[] = [...COMMANDS, ...customCommandSpecs],
): Suggestion[] {
	const query = leadingQuery(input, "/");
	if (query === null) return [];
	// The command set is small and static, so it is not capped like names;
	// a command missing from the menu is a command nobody finds.
	return commands
		.filter((command) => command.name.slice(1).toLowerCase().startsWith(query))
		.map((command) => ({
			value: command.name,
			label: command.name,
			hint: command.hint,
			anchor: 0,
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
		.map((name) => ({ value: `@${name}`, label: `@${name}`, anchor: 0 }));
}

export function isMenuOpen(
	menu: MenuState,
	suggestions: readonly Suggestion[],
): boolean {
	return !menu.dismissed && suggestions.length > 0;
}

// Team mode filters its own command set, and falls back to rob names for the
// @ trigger.
export function teamSuggestions(
	input: string,
	names: readonly string[],
): Suggestion[] {
	if (input.startsWith("@")) return robSuggestions(input, names);
	return commandSuggestions(input, TEAM_COMMANDS);
}

// The reducers own committed accept, and the input component mirrors this same
// value into its local ref so an Enter in the next tick already sees the line.
// Accept replaces the token at the suggestion's anchor, not the whole line, so a
// mention typed mid-sentence survives.
export function acceptMenu(
	text: string,
	menu: MenuState,
	suggestions: readonly Suggestion[],
): string | null {
	if (!isMenuOpen(menu, suggestions)) return null;
	const index = Math.max(0, Math.min(menu.index, suggestions.length - 1));
	const choice = suggestions[index];
	if (choice === undefined) return null;
	const end = tokenEnd(text, choice.anchor);
	return `${text.slice(0, choice.anchor)}${choice.value} ${text.slice(end)}`;
}

// The completed token runs from its anchor to the next whitespace or line end.
// A command token has no whitespace, so anchor 0 still replaces the whole line.
function tokenEnd(text: string, anchor: number): number {
	const boundary = /[ \t\n]/.exec(text.slice(anchor));
	return boundary === null ? text.length : anchor + boundary.index;
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
