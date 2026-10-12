import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/agent.js";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";
import {
	discoverSkills,
	listPackageDirs,
	loadSkillPackage,
} from "../../src/skills/discover.js";
import { parseFrontmatter } from "../../src/skills/frontmatter.js";
import { skillsRoot } from "../../src/skills/paths.js";
import { execute } from "../../src/tools/registry.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const validFixture = fileURLToPath(
	new URL("../fixtures/skill-valid", import.meta.url),
);

const VALID_SKILL_MD = `---
name: fixture-greeting
description: A greeting skill for tests.
---
Read the user's name and greet them warmly.

One step per sentence.
`;

let root: string;
let validBody: string;
const previousSkillsDir = process.env.MY_AGENT_SKILLS_DIR;

beforeAll(async () => {
	validBody = await readFile(path.join(validFixture, "SKILL.md"), "utf8");
});

beforeEach(async () => {
	root = await makeWorkspace("my-agent-skills-");
	process.env.MY_AGENT_SKILLS_DIR = root;
});

afterEach(async () => {
	await removeWorkspace(root);
	if (previousSkillsDir === undefined) {
		delete process.env.MY_AGENT_SKILLS_DIR;
	} else {
		process.env.MY_AGENT_SKILLS_DIR = previousSkillsDir;
	}
});

async function installPackage(
	name: string,
	files: Record<string, string>,
): Promise<string> {
	const dir = path.join(root, "node_modules", name);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(dir, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	return dir;
}

describe("skillsRoot", () => {
	it("defaults to ~/.config/my-agent/skills", () => {
		expect(skillsRoot({}, "/home/example")).toBe(
			"/home/example/.config/my-agent/skills",
		);
	});

	it("honors the MY_AGENT_SKILLS_DIR override", () => {
		expect(
			skillsRoot(
				{ MY_AGENT_SKILLS_DIR: "/tmp/custom-skills" },
				"/home/example",
			),
		).toBe("/tmp/custom-skills");
	});
});

describe("parseFrontmatter", () => {
	it("parses the name and a description containing a colon", () => {
		const result = parseFrontmatter(
			"---\nname: my-skill\ndescription: Do: it\n---\nbody\n",
		);
		expect(result).toEqual({
			ok: true,
			frontmatter: { name: "my-skill", description: "Do: it" },
			body: "body\n",
		});
	});

	it("rejects a missing description", () => {
		const result = parseFrontmatter("---\nname: my-skill\n---\nbody\n");
		expect(result).toEqual({
			ok: false,
			error: 'frontmatter is missing "description"',
		});
	});
});

describe("discoverSkills", () => {
	it("skips packages that do not declare the my-agent-skill field", async () => {
		const dir = await installPackage("plain", {
			"package.json": '{"name":"plain","version":"1.0.0"}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const skills = await discoverSkills();
		expect(skills).toEqual([]);
		expect(await listPackageDirs(root)).toContain(dir);
	});

	it("finds a package that declares a valid skill", async () => {
		const dir = await installPackage("fixture-valid-skill", {
			"package.json":
				'{"name":"fixture-valid-skill","version":"1.2.3","my-agent-skill":"."}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const skills = await discoverSkills();
		expect(skills).toEqual([
			{
				name: "fixture-greeting",
				description: "A greeting skill for tests.",
				packageName: "fixture-valid-skill",
				version: "1.2.3",
				dir: realpathSync(dir),
			},
		]);
	});
});

describe("loadSkillPackage validation", () => {
	it("names the package when the field is missing", async () => {
		const dir = await installPackage("fixture-invalid-skill", {
			"package.json": '{"name":"fixture-invalid-skill","version":"0.0.1"}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const result = await loadSkillPackage(dir);
		expect(result).toEqual({
			ok: false,
			error:
				'Package "fixture-invalid-skill" does not declare a "my-agent-skill" field.',
		});
	});

	it("names the package when SKILL.md is missing", async () => {
		const dir = await installPackage("fixture-no-skill", {
			"package.json":
				'{"name":"fixture-no-skill","version":"0.0.1","my-agent-skill":"."}',
		});

		const result = await loadSkillPackage(dir);
		expect(result).toEqual({
			ok: false,
			error: 'Package "fixture-no-skill" has no SKILL.md at ".".',
		});
	});

	it("names the package when frontmatter is invalid", async () => {
		const dir = await installPackage("fixture-bad-frontmatter", {
			"package.json":
				'{"name":"fixture-bad-frontmatter","version":"0.0.1","my-agent-skill":"."}',
			"SKILL.md": "# no frontmatter\n",
		});

		const result = await loadSkillPackage(dir);
		expect(result).toEqual({
			ok: false,
			error:
				'Package "fixture-bad-frontmatter" has an invalid SKILL.md: missing YAML frontmatter',
		});
	});

	it("rejects a field that escapes the package directory", async () => {
		const dir = await installPackage("fixture-escaping", {
			"package.json":
				'{"name":"fixture-escaping","version":"0.0.1","my-agent-skill":".."}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const result = await loadSkillPackage(dir);
		expect(result).toEqual({
			ok: false,
			error:
				'Package "fixture-escaping" points "my-agent-skill" outside the package.',
		});
	});
});

describe("load_skill", () => {
	beforeEach(async () => {
		await installPackage("fixture-valid-skill", {
			"package.json":
				'{"name":"fixture-valid-skill","version":"1.2.3","my-agent-skill":"."}',
			"SKILL.md": VALID_SKILL_MD,
		});
	});

	it("returns the exact SKILL.md body of an installed skill", async () => {
		const result = await execute(
			"load_skill",
			{ name: "fixture-greeting" },
			{ workspaceRoot: root },
		);
		expect(result).toEqual({ ok: true, output: validBody });
	});

	it("rejects an unknown skill name without throwing", async () => {
		const result = await execute(
			"load_skill",
			{ name: "nope" },
			{ workspaceRoot: root },
		);
		expect(result).toEqual({ ok: false, error: "Unknown skill: nope" });
	});

	it("rejects a traversal name without throwing", async () => {
		const result = await execute(
			"load_skill",
			{ name: "../../etc/passwd" },
			{ workspaceRoot: root },
		);
		expect(result).toEqual({
			ok: false,
			error: "Unknown skill: ../../etc/passwd",
		});
	});
});

describe("buildSystemPrompt skills section", () => {
	it("omits the section when no skills are installed", async () => {
		const prompt = await buildSystemPrompt({
			workspaceRoot: root,
			platform: "linux",
			date: "2026-10-12",
		});
		expect(prompt).not.toContain("## Skills");
	});

	it("lists each installed skill as name and description", async () => {
		await installPackage("fixture-valid-skill", {
			"package.json":
				'{"name":"fixture-valid-skill","version":"1.2.3","my-agent-skill":"."}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const prompt = await buildSystemPrompt({
			workspaceRoot: root,
			platform: "linux",
			date: "2026-10-12",
		});
		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("- fixture-greeting: A greeting skill for tests.");
	});
});

describe("runAgent with skills", () => {
	it("advertises the Skills section and returns a load_skill result", async () => {
		await installPackage("fixture-valid-skill", {
			"package.json":
				'{"name":"fixture-valid-skill","version":"1.2.3","my-agent-skill":"."}',
			"SKILL.md": VALID_SKILL_MD,
		});

		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "load_skill",
					args: { name: "fixture-greeting" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runAgent({
			provider,
			model: "deepseek-flash",
			workspaceRoot: root,
			prompt: "greet me",
			onEvent: () => {},
		});

		const system = provider.requests[0].messages[0];
		if (system.role !== "system") throw new Error("expected a system message");
		expect(system.content).toContain("## Skills");
		expect(system.content).toContain(
			"- fixture-greeting: A greeting skill for tests.",
		);
		expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
			"load_skill",
		);

		const toolMessages = provider.requests[1].messages.filter(
			(message) => message.role === "tool",
		);
		expect(toolMessages).toContainEqual({
			role: "tool",
			toolCallId: "call_1",
			content: validBody,
			isError: false,
		});
		expect(result.reason).toBe("finished");
	});
});
