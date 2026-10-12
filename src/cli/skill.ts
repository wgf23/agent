import { discoverSkills, type Skill } from "../skills/discover.js";
import { addSkill, removeSkill } from "../skills/install.js";

const COLUMNS = ["name", "package", "version", "description", "path"];

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
	process.stdout.write(formatSkillList(await discoverSkills()));
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

export function formatSkillList(skills: readonly Skill[]): string {
	if (skills.length === 0) return "No skills installed.\n";

	const rows = skills.map((skill) => [
		skill.name,
		skill.packageName,
		skill.version,
		skill.description,
		skill.dir,
	]);
	const widths = COLUMNS.map((label, index) =>
		Math.max(label.length, ...rows.map((row) => row[index].length)),
	);
	const lines = [COLUMNS, ...rows].map((row) =>
		row
			.map((cell, index) =>
				index === row.length - 1 ? cell : cell.padEnd(widths[index]),
			)
			.join("  ")
			.trimEnd(),
	);
	return `${lines.join("\n")}\n`;
}
