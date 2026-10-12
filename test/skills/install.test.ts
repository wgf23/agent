import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runSkillAdd,
	runSkillList,
	runSkillRemove,
} from "../../src/cli/skill.js";
import { discoverSkills } from "../../src/skills/discover.js";
import { addSkill, removeSkill } from "../../src/skills/install.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const validFixture = fileURLToPath(
	new URL("../fixtures/skill-valid", import.meta.url),
);
const invalidFixture = fileURLToPath(
	new URL("../fixtures/skill-invalid", import.meta.url),
);

let root: string;
const previousSkillsDir = process.env.MY_AGENT_SKILLS_DIR;

beforeEach(async () => {
	root = await makeWorkspace("my-agent-skills-install-");
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

async function captureConsole(
	fn: () => Promise<number>,
): Promise<{ code: number; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const logSpy = vi
		.spyOn(console, "log")
		.mockImplementation((...args) => out.push(args.map(String).join(" ")));
	const errSpy = vi
		.spyOn(console, "error")
		.mockImplementation((...args) => err.push(args.map(String).join(" ")));
	try {
		const code = await fn();
		return { code, out, err };
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
	}
}

describe("skill add", () => {
	it("installs a local skill package and reports it", async () => {
		const { code, out } = await captureConsole(() => runSkillAdd(validFixture));

		expect(code).toBe(0);
		expect(out).toEqual([
			'Installed skill "fixture-greeting" (fixture-valid-skill@1.2.3).',
		]);

		const skills = await discoverSkills();
		expect(skills).toEqual([
			{
				name: "fixture-greeting",
				description: "A greeting skill for tests.",
				packageName: "fixture-valid-skill",
				version: "1.2.3",
				dir: realpathSync(validFixture),
			},
		]);

		const prefix = JSON.parse(
			await readFile(path.join(root, "package.json"), "utf8"),
		) as {
			name?: string;
			private?: boolean;
			dependencies?: Record<string, string>;
		};
		expect(prefix.name).toBe("my-agent-skills");
		expect(prefix.private).toBe(true);
		expect(prefix.dependencies).toHaveProperty("fixture-valid-skill");
	});

	it("rejects an invalid package and installs nothing", async () => {
		const result = await addSkill(invalidFixture);
		expect(result).toEqual({
			ok: false,
			error:
				'Package "fixture-invalid-skill" does not declare a "my-agent-skill" field.',
		});

		expect(await discoverSkills()).toEqual([]);
		await expect(
			readFile(
				path.join(
					root,
					"node_modules",
					"fixture-invalid-skill",
					"package.json",
				),
				"utf8",
			),
		).rejects.toThrow();
	});

	it("prints a friendly error and exits non-zero for an invalid package", async () => {
		const { code, err } = await captureConsole(() =>
			runSkillAdd(invalidFixture),
		);

		expect(code).toBe(1);
		expect(err).toEqual([
			'Package "fixture-invalid-skill" does not declare a "my-agent-skill" field.',
		]);
	});

	it("reports an npm failure and installs nothing", async () => {
		const missing = path.join(root, "does-not-exist");
		const result = await addSkill(missing);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected add to fail");
		expect(result.error).toContain("Failed to install");
		expect(await discoverSkills()).toEqual([]);
	});
});

describe("skill list", () => {
	it("prints nothing but a notice when no skills are installed", async () => {
		const { code, out } = await captureConsole(() => runSkillList());

		expect(code).toBe(0);
		expect(out).toEqual(["No skills installed."]);
	});

	it("prints one row per installed skill", async () => {
		await runSkillAdd(validFixture);

		const { code, out } = await captureConsole(() => runSkillList());

		expect(code).toBe(0);
		expect(out).toEqual([
			`fixture-greeting\tfixture-valid-skill\t1.2.3\tA greeting skill for tests.\t${realpathSync(validFixture)}`,
		]);
	});
});

describe("skill remove", () => {
	it("removes the owning package and reports it", async () => {
		await runSkillAdd(validFixture);

		const { code, out } = await captureConsole(() =>
			runSkillRemove("fixture-greeting"),
		);
		expect(code).toBe(0);
		expect(out).toEqual([
			'Removed skill "fixture-greeting" (fixture-valid-skill).',
		]);
		expect(await discoverSkills()).toEqual([]);
	});

	it("reports an unknown skill name and exits non-zero", async () => {
		const { code, err } = await captureConsole(() => runSkillRemove("missing"));

		expect(code).toBe(1);
		expect(err).toEqual(["Unknown skill: missing"]);
	});

	it("removeSkill returns the removed skill", async () => {
		await addSkill(validFixture);

		const result = await removeSkill("fixture-greeting");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected remove to succeed");
		expect(result.skill.packageName).toBe("fixture-valid-skill");
	});
});
