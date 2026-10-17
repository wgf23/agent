import { describe, expect, it } from "vitest";
import { normalizeSkillScope } from "../../src/config/project-file.js";

describe("normalizeSkillScope", () => {
	// Direct tests for the rule itself, separate from the file round-trips:
	// those prove the behaviour end to end, these pin what the rule *is*.
	it("refuses a confirmation flag with no list", () => {
		expect(normalizeSkillScope({ skillsConfigured: true })).toEqual({
			ok: false,
			error: "skillsConfigured requires skills",
		});
		// The flag is meaningless without the list in either direction.
		expect(normalizeSkillScope({ skillsConfigured: false })).toEqual({
			ok: false,
			error: "skillsConfigured requires skills",
		});
	});

	it("confirms an empty list sent without a flag", () => {
		// Left alone this is truth table row 2 — every installed skill — so
		// "no skills" would read back as "all skills".
		expect(normalizeSkillScope({ skills: [] })).toEqual({
			ok: true,
			skills: [],
			skillsConfigured: true,
		});
	});

	it("confirms a non-empty list sent without a flag", () => {
		expect(normalizeSkillScope({ skills: ["a"] })).toEqual({
			ok: true,
			skills: ["a"],
			skillsConfigured: true,
		});
	});

	it("leaves both fields absent when neither is sent", () => {
		// Omission is the only way to say "leave the scope alone"; the result
		// carries no fields so the caller writes none.
		expect(normalizeSkillScope({})).toEqual({ ok: true });
	});

	it("keeps an explicit flag exactly as sent", () => {
		expect(
			normalizeSkillScope({ skills: [], skillsConfigured: false }),
		).toEqual({ ok: true, skills: [], skillsConfigured: false });
	});

	it("copies the list rather than aliasing the caller's array", () => {
		const skills = ["a"];
		const result = normalizeSkillScope({ skills });
		skills.push("b");
		expect(result).toEqual({
			ok: true,
			skills: ["a"],
			skillsConfigured: true,
		});
	});
});
