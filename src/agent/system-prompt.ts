import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverSkills, type Skill } from "../skills/discover.js";

export interface SystemPromptOptions {
	workspaceRoot: string;
	platform: string;
	date: string;
	agentsMd?: string;
	extraInstructions?: string;
	skills?: Skill[];
}

export async function buildSystemPrompt(
	options: SystemPromptOptions,
): Promise<string> {
	const agentsMd =
		options.agentsMd ?? (await readAgentsMd(options.workspaceRoot));

	const sections = [
		"You are my-agent, a terminal coding agent.",
		[
			"## Guidance",
			"- Read files before editing them.",
			"- Use the tools to inspect the workspace instead of guessing at file contents.",
			"- Keep answers concise.",
		].join("\n"),
		[
			"## Environment",
			`- cwd: ${options.workspaceRoot}`,
			`- platform: ${options.platform}`,
			`- date: ${options.date}`,
		].join("\n"),
	];

	if (
		options.extraInstructions !== undefined &&
		options.extraInstructions.trim() !== ""
	) {
		sections.push(options.extraInstructions.trim());
	}

	const skills = options.skills ?? (await discoverSkills());
	if (skills.length > 0) {
		sections.push(
			[
				"## Skills",
				...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
			].join("\n"),
		);
	}

	if (agentsMd !== undefined && agentsMd.trim() !== "") {
		sections.push(`## AGENTS.md\n\n${agentsMd.trim()}`);
	}

	return sections.join("\n\n");
}

async function readAgentsMd(
	workspaceRoot: string,
): Promise<string | undefined> {
	try {
		return await readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8");
	} catch {
		return undefined;
	}
}
