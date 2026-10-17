import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	projectFilePath,
	readProjectConfig,
	updateRob,
} from "../../src/config/project-file.js";
import type { Skill } from "../../src/skills/discover.js";
import { resolveBotSkills, skillScopeOf } from "../../src/skills/scope.js";

// C12 (design §12 item 9): a bot that has confirmed its skill list keeps that
// confirmation across a backend switch. The switch rewrites role/model/backend
// in the project file; the scope must ride along untouched in both directions,
// or a bot would silently regain every installed skill.
const CLI_BACKEND = {
	kind: "cli" as const,
	command: "pi",
	provider: "deepseek",
	model: "deepseek-v4-flash",
};

const skill = (name: string): Skill => ({
	name,
	description: `${name} skill`,
	packageName: `pkg-${name}`,
	version: "1.0.0",
	dir: `/skills/${name}`,
});

const installed: Skill[] = [skill("alpha"), skill("beta"), skill("gamma")];
const names = (skills: readonly { name: string }[]) =>
	skills.map((entry) => entry.name);

let workspace: string;

const writeRobs = (robs: unknown[]) =>
	writeFile(
		projectFilePath(workspace),
		`${JSON.stringify({ robs }, null, 2)}\n`,
		"utf8",
	);

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "my-agent-skills-switch-"));
	await writeRobs([
		{
			name: "helper",
			role: "does things",
			skills: ["alpha"],
			skillsConfigured: true,
			mcp: ["fs"],
		},
	]);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

async function botOnDisk() {
	const result = await readProjectConfig(workspace);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	const rob = result.config.robs?.find((entry) => entry.name === "helper");
	expect(rob).toBeDefined();
	if (rob === undefined) throw new Error("helper is missing");
	return rob;
}

const visible = (rob: Parameters<typeof skillScopeOf>[0]) =>
	resolveBotSkills(skillScopeOf(rob), async () => installed);

describe("a confirmed skill scope survives a backend switch", () => {
	it("keeps skills, skillsConfigured and mcp when the backend becomes cli", async () => {
		const saved = await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
			backend: CLI_BACKEND,
		});
		expect(saved).toEqual({ ok: true });

		const rob = await botOnDisk();
		expect(rob.backend).toEqual(CLI_BACKEND);
		expect(rob.skills).toEqual(["alpha"]);
		expect(rob.skillsConfigured).toBe(true);
		// MCP is a separate opt-in and must not be collateral damage either.
		expect(rob.mcp).toEqual(["fs"]);

		// What the runtime hands this bot, on the cli side of the switch.
		expect(names(await visible(rob))).toEqual(["alpha"]);
	});

	it("still applies after switching back to native", async () => {
		await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
			backend: CLI_BACKEND,
		});
		// Switching back: native is the absent backend, so the field is dropped
		// rather than stored as {kind:"native"}.
		const back = await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
		});
		expect(back).toEqual({ ok: true });

		const rob = await botOnDisk();
		expect(rob.backend).toBeUndefined();
		expect(rob.skills).toEqual(["alpha"]);
		expect(rob.skillsConfigured).toBe(true);

		expect(names(await visible(rob))).toEqual(["alpha"]);
	});

	it("does not resurrect an empty confirmed list as every skill", async () => {
		// Truth-table row 3, the case that looks like "nothing configured": an
		// explicitly emptied list must stay empty through the switch.
		await writeRobs([
			{
				name: "helper",
				role: "does things",
				skills: [],
				skillsConfigured: true,
			},
		]);

		await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
			backend: CLI_BACKEND,
		});
		const onCli = await botOnDisk();
		expect(onCli.skills).toEqual([]);
		expect(onCli.skillsConfigured).toBe(true);
		expect(names(await visible(onCli))).toEqual([]);

		await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
		});
		const onNative = await botOnDisk();
		expect(onNative.skillsConfigured).toBe(true);
		expect(names(await visible(onNative))).toEqual([]);
	});

	it("leaves an unconfigured bot unconfigured", async () => {
		// The complement: a bot that never set a scope must not acquire one just
		// because its backend changed.
		await writeRobs([{ name: "helper", role: "does things" }]);

		await updateRob(workspace, "helper", {
			name: "helper",
			role: "does things",
			backend: CLI_BACKEND,
		});
		const rob = await botOnDisk();
		expect(rob.skills).toBeUndefined();
		expect(rob.skillsConfigured).toBeUndefined();
		expect(names(await visible(rob))).toEqual(["alpha", "beta", "gamma"]);

		// And the file carries no scope keys, rather than `skills: []`.
		const raw = JSON.parse(
			await readFile(projectFilePath(workspace), "utf8"),
		) as {
			robs: Record<string, unknown>[];
		};
		const entry = raw.robs[0] as Record<string, unknown>;
		expect("skills" in entry).toBe(false);
		expect("skillsConfigured" in entry).toBe(false);
	});
});
