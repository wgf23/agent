import { discoverSkills } from "../skills/discover.js";
import { addSkill, removeSkill } from "../skills/install.js";

export async function runSkillAdd(spec: string): Promise<number> {
	const result = await addSkill(spec);
	if (!result.ok) {
		console.error(result.error);
		return 1;
	}
	const { name, packageName, version } = result.skill;
	console.log(`Installed skill "${name}" (${packageName}@${version}).`);
	return 0;
}

export async function runSkillList(): Promise<number> {
	const skills = await discoverSkills();
	if (skills.length === 0) {
		console.log("No skills installed.");
		return 0;
	}
	for (const skill of skills) {
		console.log(
			`${skill.name}\t${skill.packageName}\t${skill.version}\t${skill.description}\t${skill.dir}`,
		);
	}
	return 0;
}

export async function runSkillRemove(name: string): Promise<number> {
	const result = await removeSkill(name);
	if (!result.ok) {
		console.error(result.error);
		return 1;
	}
	console.log(`Removed skill "${name}" (${result.skill.packageName}).`);
	return 0;
}
