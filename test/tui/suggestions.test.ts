import { describe, expect, it } from "vitest";
import {
	COMMANDS,
	commandSuggestions,
	isMenuOpen,
	MENU_CLOSED,
	MENU_NEUTRAL,
	moveMenu,
	robSuggestions,
	teamSuggestions,
} from "../../src/tui/suggestions.js";

describe("commandSuggestions", () => {
	it("matches commands by prefix", () => {
		expect(commandSuggestions("/mo").map((item) => item.value)).toEqual([
			"/model",
		]);
		expect(commandSuggestions("/").map((item) => item.value)).toEqual(
			COMMANDS.map((command) => command.name),
		);
	});

	it("only reads a single leading line", () => {
		expect(commandSuggestions("hello\n/clear")).toEqual([]);
		expect(commandSuggestions("hi")).toEqual([]);
	});

	it("closes the menu once a space starts the arguments", () => {
		expect(commandSuggestions("/model now")).toEqual([]);
	});

	it("hides when nothing matches", () => {
		expect(commandSuggestions("/zzz")).toEqual([]);
	});

	it("caps the list at six", () => {
		const names = Array.from({ length: 8 }, (_, index) => `rob${index}`);
		expect(robSuggestions("@", names)).toHaveLength(6);
	});
});

describe("robSuggestions", () => {
	it("matches rob names by prefix", () => {
		expect(
			robSuggestions("@pl", ["planner", "worker"]).map((item) => item.value),
		).toEqual(["@planner"]);
		expect(
			robSuggestions("@", ["planner", "worker"]).map((item) => item.value),
		).toEqual(["@planner", "@worker"]);
	});

	it("hides once a space starts the message", () => {
		expect(robSuggestions("@planner hi", ["planner"])).toEqual([]);
	});
});

describe("teamSuggestions", () => {
	it("matches the team command set by prefix", () => {
		expect(teamSuggestions("/", ["planner"]).map((item) => item.value)).toEqual(
			["/help", "/dm", "/sub", "/quit"],
		);
		expect(
			teamSuggestions("/d", ["planner"]).map((item) => item.value),
		).toEqual(["/dm"]);
	});

	it("matches rob names for the @ trigger", () => {
		expect(
			teamSuggestions("@pl", ["planner", "worker"]).map((item) => item.value),
		).toEqual(["@planner"]);
	});

	it("does not offer commands team mode cannot run", () => {
		const names = teamSuggestions("/", []).map((item) => item.value);
		expect(names).not.toContain("/clear");
		expect(names).not.toContain("/model");
	});
});

describe("menu state", () => {
	it("is open only with matches and no dismissal", () => {
		expect(isMenuOpen(MENU_NEUTRAL, commandSuggestions("/"))).toBe(true);
		expect(isMenuOpen(MENU_CLOSED, commandSuggestions("/"))).toBe(false);
		expect(isMenuOpen(MENU_NEUTRAL, [])).toBe(false);
	});

	it("moves the selection with wrap-around", () => {
		const list = commandSuggestions("/");
		let menu = MENU_NEUTRAL;
		menu = moveMenu(menu, list, 1);
		expect(menu.index).toBe(1);
		menu = moveMenu(menu, list, -1);
		expect(menu.index).toBe(0);
		menu = moveMenu(menu, list, -1);
		expect(menu.index).toBe(list.length - 1);
	});
});
