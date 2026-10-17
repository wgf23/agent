import { describe, expect, it } from "vitest";
import { filterToolsByServers } from "../../src/mcp/scope.js";

const byServer = {
	github: ["mcp__github__list_issues", "mcp__github__create_issue"],
	docs: ["mcp__docs__search"],
};

describe("filterToolsByServers", () => {
	it("returns nothing when the bot enables no server", () => {
		expect(filterToolsByServers(byServer, [])).toEqual([]);
	});

	it("returns the tools of the enabled server only", () => {
		expect(filterToolsByServers(byServer, ["docs"])).toEqual([
			"mcp__docs__search",
		]);
	});

	it("concatenates several enabled servers in the configured order", () => {
		expect(filterToolsByServers(byServer, ["docs", "github"])).toEqual([
			"mcp__docs__search",
			"mcp__github__list_issues",
			"mcp__github__create_issue",
		]);
	});

	it("ignores a server name that no longer exists", () => {
		expect(filterToolsByServers(byServer, ["removed", "docs"])).toEqual([
			"mcp__docs__search",
		]);
	});

	it("handles a server that exposes no tools", () => {
		expect(filterToolsByServers({ quiet: [] }, ["quiet"])).toEqual([]);
	});

	it("does not leak tools from servers the bot did not enable", () => {
		const tools = filterToolsByServers(byServer, ["docs"]);
		expect(tools.some((name) => name.startsWith("mcp__github__"))).toBe(false);
	});
});
