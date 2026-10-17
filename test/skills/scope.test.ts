import { describe, expect, it } from "vitest";
import type { Skill } from "../../src/skills/discover.js";
import {
	resolveBotSkills,
	skillScopeOf,
	visibleSkills,
} from "../../src/skills/scope.js";

const skill = (name: string): Skill => ({
	name,
	description: `${name} skill`,
	packageName: `pkg-${name}`,
	version: "1.0.0",
	dir: `/skills/${name}`,
});

const installed: Skill[] = [skill("alpha"), skill("beta"), skill("gamma")];

const names = (skills: readonly { name: string }[]) =>
	skills.map((skill) => skill.name);

// The truth table from design §1.2, one row per case. Rows 1 and 2 are the
// backward-compatible ones: an absent or never-confirmed list means every
// installed skill, exactly as before this feature.
describe("visibleSkills truth table", () => {
	it("row 1: an absent list allows every installed skill", () => {
		expect(names(visibleSkills(installed, {}))).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("row 2: an empty list that was never confirmed still allows everything", () => {
		expect(names(visibleSkills(installed, { skills: [] }))).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
		expect(
			names(visibleSkills(installed, { skills: [], skillsConfigured: false })),
		).toEqual(["alpha", "beta", "gamma"]);
	});

	it("row 3: a confirmed empty list allows nothing", () => {
		expect(
			visibleSkills(installed, { skills: [], skillsConfigured: true }),
		).toEqual([]);
	});

	it("row 4: a list allows exactly its names", () => {
		expect(names(visibleSkills(installed, { skills: ["beta"] }))).toEqual([
			"beta",
		]);
		expect(
			names(
				visibleSkills(installed, {
					skills: ["beta"],
					skillsConfigured: false,
				}),
			),
		).toEqual(["beta"]);
	});

	it("row 5: a confirmed list is still exactly its names", () => {
		expect(
			names(
				visibleSkills(installed, {
					skills: ["alpha", "gamma"],
					skillsConfigured: true,
				}),
			),
		).toEqual(["alpha", "gamma"]);
	});
});

describe("visibleSkills edge cases", () => {
	it("ignores names that are not installed instead of erroring", () => {
		expect(
			names(
				visibleSkills(installed, {
					skills: ["alpha", "not-installed"],
					skillsConfigured: true,
				}),
			),
		).toEqual(["alpha"]);
	});

	it("keeps the installed order, not the order of the allowlist", () => {
		expect(
			names(
				visibleSkills(installed, {
					skills: ["gamma", "alpha"],
					skillsConfigured: true,
				}),
			),
		).toEqual(["alpha", "gamma"]);
	});

	it("returns a fresh array so callers cannot mutate the input", () => {
		const copy = visibleSkills(installed, {});
		expect(copy).not.toBe(installed);
		copy.pop();
		expect(installed).toHaveLength(3);
	});
});

describe("resolveBotSkills", () => {
	it("reads the install directory through the injected discover", async () => {
		let calls = 0;
		const skills = await resolveBotSkills({ skills: ["beta"] }, async () => {
			calls += 1;
			return installed;
		});

		expect(names(skills)).toEqual(["beta"]);
		expect(calls).toBe(1);
	});

	it("still consults discover when nothing is configured", async () => {
		const skills = await resolveBotSkills({}, async () => installed);
		expect(names(skills)).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("skillScopeOf", () => {
	it("picks only the two scope fields from a bot config", () => {
		expect(
			skillScopeOf({
				name: "helper",
				role: "does things",
				skills: ["alpha"],
				skillsConfigured: true,
			} as never),
		).toEqual({ skills: ["alpha"], skillsConfigured: true });
	});

	it("leaves both undefined when the config carries neither", () => {
		expect(skillScopeOf({} as never)).toEqual({
			skills: undefined,
			skillsConfigured: undefined,
		});
	});
});
