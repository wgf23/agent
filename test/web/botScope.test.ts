import { describe, expect, it } from "vitest";
import type { McpServerInfo, SkillInfo } from "../../shared/protocol.js";
import {
	mcpDraft,
	mcpSelection,
	skillDefaultDraft,
	skillDraft,
	skillSelection,
} from "../../web/src/botScope.js";

const installed: SkillInfo[] = [
	{
		name: "blueprint",
		packageName: "@acme/blueprint",
		version: "1.2.0",
		description: "writes specs",
	},
	{
		name: "charts",
		packageName: "@acme/charts",
		version: "0.4.1",
		description: "draws charts",
	},
];

const servers: McpServerInfo[] = [
	{ name: "github", command: "npx", argsCount: 2, envKeys: ["GITHUB_TOKEN"] },
	{ name: "docs", command: "node", argsCount: 0, envKeys: [] },
];

describe("skillSelection", () => {
	it("reads an unconfigured bot as all installed", () => {
		expect(skillSelection(installed, {})).toEqual({
			selected: ["blueprint", "charts"],
			isDefault: true,
		});
	});

	it("reads an empty list without the flag as all installed", () => {
		// Truth table row 2: a bare [] was never confirmed, so it is not
		// "ticked nothing" -- reading it that way would silently widen scope.
		expect(skillSelection(installed, { skills: [] })).toEqual({
			selected: ["blueprint", "charts"],
			isDefault: true,
		});
		expect(
			skillSelection(installed, { skills: [], skillsConfigured: false }),
		).toEqual({ selected: ["blueprint", "charts"], isDefault: true });
	});

	it("reads an empty confirmed list as nothing ticked", () => {
		expect(
			skillSelection(installed, { skills: [], skillsConfigured: true }),
		).toEqual({ selected: [], isDefault: false });
	});

	it("keeps a confirmed subset and follows the installed order", () => {
		expect(
			skillSelection(installed, {
				skills: ["charts"],
				skillsConfigured: true,
			}),
		).toEqual({ selected: ["charts"], isDefault: false });
		expect(
			skillSelection(installed, {
				skills: ["charts", "blueprint"],
				skillsConfigured: true,
			}),
		).toEqual({ selected: ["blueprint", "charts"], isDefault: false });
	});

	it("ignores names that are no longer installed", () => {
		expect(
			skillSelection(installed, {
				skills: ["blueprint", "gone"],
				skillsConfigured: true,
			}),
		).toEqual({ selected: ["blueprint"], isDefault: false });
	});
});

describe("skillDraft", () => {
	it("sends the list with the confirmation flag", () => {
		expect(skillDraft(["charts"], installed)).toEqual({
			skills: ["charts"],
			skillsConfigured: true,
		});
	});

	it("sends the pair even when nothing is ticked", () => {
		// [] + true is "ticked nothing", which is not the default.
		expect(skillDraft([], installed)).toEqual({
			skills: [],
			skillsConfigured: true,
		});
	});

	it("drops names the server no longer lists", () => {
		expect(skillDraft(["gone", "blueprint"], installed)).toEqual({
			skills: ["blueprint"],
			skillsConfigured: true,
		});
	});

	it("returns to the default through the one legal shape", () => {
		// A bare [] would read back as "all installed" only because the flag
		// is absent; the explicit false says so on purpose.
		expect(skillDefaultDraft()).toEqual({
			skills: [],
			skillsConfigured: false,
		});
	});
});

describe("mcpSelection", () => {
	it("reads an unconfigured bot as nothing enabled", () => {
		expect(mcpSelection(servers, {})).toEqual([]);
	});

	it("keeps the enabled subset in server order", () => {
		expect(mcpSelection(servers, { mcp: ["docs", "github"] })).toEqual([
			"github",
			"docs",
		]);
	});

	it("ignores servers this serve no longer defines", () => {
		expect(mcpSelection(servers, { mcp: ["gone", "docs"] })).toEqual(["docs"]);
	});
});

describe("mcpDraft", () => {
	it("sends a plain list with no flag", () => {
		expect(mcpDraft(["docs"], servers)).toEqual({ mcp: ["docs"] });
	});

	it("sends an empty list when everything is unticked", () => {
		// Absent means none for mcp, so [] is meaningful without a flag.
		expect(mcpDraft([], servers)).toEqual({ mcp: [] });
	});

	it("drops names the serve no longer defines", () => {
		expect(mcpDraft(["gone", "github"], servers)).toEqual({ mcp: ["github"] });
	});
});
