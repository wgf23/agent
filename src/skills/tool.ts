import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { discoverSkills, SKILL_FILENAME } from "./discover.js";
import { SKILL_NAME_PATTERN } from "./frontmatter.js";
import { resolveInside, SkillPathError } from "./paths.js";

const schema = z
	.object({
		name: z.string().describe("Name of an installed skill."),
	})
	.strict();

export const loadSkillTool: Tool<typeof schema> = {
	name: "load_skill",
	description:
		"Load the full instructions of an installed skill by name. Returns the skill's SKILL.md.",
	readOnly: true,
	schema,
	async execute(args) {
		// Reject traversal-shaped names before any path work; installed names are
		// always lowercase kebab-case.
		if (!SKILL_NAME_PATTERN.test(args.name)) {
			return { ok: false, error: `Unknown skill: ${args.name}` };
		}

		const skills = await discoverSkills();
		const skill = skills.find((candidate) => candidate.name === args.name);
		if (skill === undefined) {
			return { ok: false, error: `Unknown skill: ${args.name}` };
		}

		try {
			const file = resolveInside(skill.dir, SKILL_FILENAME);
			return { ok: true, output: await readFile(file, "utf8") };
		} catch (error) {
			if (error instanceof SkillPathError) {
				return { ok: false, error: `Unsafe skill path for: ${args.name}` };
			}
			return { ok: false, error: errorMessage(error) };
		}
	},
};
