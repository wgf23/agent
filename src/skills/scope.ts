import { discoverSkills, type Skill } from "./discover.js";

export interface SkillScopeConfig {
	skills?: readonly string[] | undefined;
	skillsConfigured?: boolean | undefined;
}

/** The bot's own skill config for scoping: the two optional fields that decide
 *  what it can load. Structural so both a RobConfig and a test literal fit. */
export interface SkillScopeSource {
	readonly skills?: readonly string[] | undefined;
	readonly skillsConfigured?: boolean | undefined;
}

/** Skills a bot may see and load.
 *
 *  An absent list means "not configured", and so does an empty list that was
 *  never confirmed: both fall back to every installed skill, which is exactly
 *  today's behaviour. Only a confirmed list — `skillsConfigured: true`, even
 *  when empty — narrows the set. Names that are not installed are ignored
 *  rather than reported, and the installed order is preserved.
 */
export function visibleSkills<T extends { name: string }>(
	installed: readonly T[],
	cfg: SkillScopeConfig,
): T[] {
	if (cfg.skills === undefined) return [...installed];
	if (cfg.skillsConfigured !== true && cfg.skills.length === 0) {
		return [...installed];
	}
	const allowed = new Set(cfg.skills);
	return installed.filter((skill) => allowed.has(skill.name));
}

/** `visibleSkills` with the install directory read for you; `discover` is
 *  injectable so tests never touch the real skills root. */
export async function resolveBotSkills(
	cfg: SkillScopeConfig,
	discover: () => Promise<Skill[]> = () => discoverSkills(),
): Promise<Skill[]> {
	return visibleSkills(await discover(), cfg);
}

/** The subset of a bot's config the scope reads. Kept here so callers pass a
 *  RobConfig-shaped object without importing the whole schema. */
export function skillScopeOf(source: SkillScopeSource): SkillScopeConfig {
	return {
		skills: source.skills,
		skillsConfigured: source.skillsConfigured,
	};
}
