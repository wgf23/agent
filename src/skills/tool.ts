import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { PathEscapeError, resolveInWorkspace } from "../util/paths.js";
import { discoverSkills, SKILL_FILENAME, type Skill } from "./discover.js";
import { SKILL_NAME_PATTERN } from "./frontmatter.js";

const schema = z
	.object({
		name: z.string().describe("Name of an installed skill."),
	})
	.strict();

export interface LoadSkillToolOptions {
	/** null = no scoping (every installed skill); an array = allowlist. */
	allowed: readonly string[] | null;
	/** Defaults to discoverSkills; tests inject a spy to prove zero calls. */
	discover?: () => Promise<Skill[]>;
	/** Defaults to reading RESOLVED(dir)/SKILL.md; tests inject a spy. */
	read?: (dir: string) => Promise<string>;
}

async function readSkillFile(dir: string): Promise<string> {
	return readFile(resolveInWorkspace(dir, SKILL_FILENAME), "utf8");
}

/** Builds a `load_skill` tool bounded to one allowlist. A bot gets its own
 *  instance through extraTools, which shadows the registry's unscoped one.
 *
 *  The order of checks is a contract: an out-of-scope name must be refused
 *  before any filesystem work, so a bot cannot even learn that a skill exists
 *  by timing or error text.
 */
export function createLoadSkillTool(
	options: LoadSkillToolOptions,
): Tool<typeof schema> {
	const discover = options.discover ?? (() => discoverSkills());
	const read = options.read ?? readSkillFile;
	const { allowed } = options;

	return {
		name: "load_skill",
		description:
			"Load the full instructions of an installed skill by name. Returns the skill's SKILL.md.",
		readOnly: true,
		schema,
		async execute(args) {
			// 1. Reject traversal-shaped names before any path work; installed
			//    names are always lowercase kebab-case.
			if (!SKILL_NAME_PATTERN.test(args.name)) {
				return { ok: false, error: `Unknown skill: ${args.name}` };
			}

			// 2. An out-of-scope name is refused here, before discover/read, so
			//    a scoped bot gets the same answer as for a skill that does not
			//    exist.
			if (allowed !== null && !allowed.includes(args.name)) {
				return { ok: false, error: `Unknown skill: ${args.name}` };
			}

			// 3. Resolve the installed skill, then 4. read it.
			const skills = await discover();
			const skill = skills.find((candidate) => candidate.name === args.name);
			if (skill === undefined) {
				return { ok: false, error: `Unknown skill: ${args.name}` };
			}

			try {
				return { ok: true, output: await read(skill.dir) };
			} catch (error) {
				if (error instanceof PathEscapeError) {
					return { ok: false, error: `Unsafe skill path for: ${args.name}` };
				}
				return { ok: false, error: errorMessage(error) };
			}
		},
	};
}

/** The unscoped instance: cli run, tui, and the solo workspace chat.
 *  Registered in tools/registry.ts and left there on purpose. */
export const loadSkillTool: Tool<typeof schema> = createLoadSkillTool({
	allowed: null,
});
