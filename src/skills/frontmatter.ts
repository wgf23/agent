export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface SkillFrontmatter {
	name: string;
	description: string;
}

export type FrontmatterResult =
	| { ok: true; frontmatter: SkillFrontmatter; body: string }
	| { ok: false; error: string };

// Parses the minimal YAML subset the SKILL.md convention needs: a leading
// `---` fence, `key: value` lines, and a closing fence. A full YAML parser
// would be a new dependency for two scalar fields.
export function parseFrontmatter(text: string): FrontmatterResult {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines[0]?.trim() !== "---") {
		return { ok: false, error: "missing YAML frontmatter" };
	}

	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			end = index;
			break;
		}
	}
	if (end === -1) {
		return { ok: false, error: "frontmatter is missing its closing ---" };
	}

	const fields: Record<string, string> = {};
	for (let index = 1; index < end; index += 1) {
		const line = lines[index];
		if (line.trim() === "") continue;
		const colon = line.indexOf(":");
		if (colon < 1) {
			return { ok: false, error: `invalid frontmatter line: ${line.trim()}` };
		}
		const key = line.slice(0, colon).trim();
		fields[key] = stripQuotes(line.slice(colon + 1).trim());
	}

	const name = fields.name;
	if (name === undefined || name === "") {
		return { ok: false, error: 'frontmatter is missing "name"' };
	}
	if (!SKILL_NAME_PATTERN.test(name)) {
		return {
			ok: false,
			error: '"name" must be lowercase kebab-case',
		};
	}

	const description = fields.description;
	if (description === undefined || description.trim() === "") {
		return { ok: false, error: 'frontmatter is missing "description"' };
	}

	return {
		ok: true,
		frontmatter: { name, description },
		body: lines.slice(end + 1).join("\n"),
	};
}

function stripQuotes(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}
