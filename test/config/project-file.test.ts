import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addPermissionRule,
	addRob,
	readProjectConfig,
	removeRob,
	updateRob,
} from "../../src/config/project-file.js";
import type { Skill } from "../../src/skills/discover.js";
import { visibleSkills } from "../../src/skills/scope.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

// Two installed skills, so a stored scope can be read back through the same
// truth table the runtime uses.
const installed: Skill[] = ["alpha", "beta"].map((name) => ({
	name,
	description: `${name} skill`,
	packageName: `pkg-${name}`,
	version: "1.0.0",
	dir: `/skills/${name}`,
}));

let workspace: string;

// The full acceptance path: what the writer stored, run back through the
// schema the reader uses. A field the reader drops is a bug even when the
// on-disk JSON looks right, so every write shape asserts through this.
async function readBackScope(robName: string) {
	const result = await readProjectConfig(workspace);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	const rob = result.config.robs?.find((entry) => entry.name === robName);
	expect(rob).toBeDefined();
	if (rob === undefined) throw new Error(`missing rob ${robName}`);
	return { raw: rob, visible: visibleSkills(installed, rob) };
}

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-project-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

describe("readProjectConfig", () => {
	it("returns an empty object when the file does not exist", async () => {
		expect(await readProjectConfig(workspace)).toEqual({
			ok: true,
			config: {},
		});
	});

	it("returns an error result for invalid JSON instead of throwing", async () => {
		await writeFile(join(workspace, "my-agent.json"), "{ not json", "utf8");

		const result = await readProjectConfig(workspace);

		expect(result.ok).toBe(false);
	});

	it("returns an error result for a permissions value of the wrong shape", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			JSON.stringify({ permissions: { bash: { "git *": "allow" } } }),
			"utf8",
		);

		const result = await readProjectConfig(workspace);

		expect(result.ok).toBe(false);
	});

	it("rejects a room whose member is not a rob in the same file", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			JSON.stringify({
				robs: [{ name: "planner", role: "plan" }],
				rooms: [{ name: "ship-it", members: ["planner", "ghost"] }],
			}),
			"utf8",
		);

		const result = await readProjectConfig(workspace);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Invalid rooms");
	});

	it("accepts a coordinator that is a member", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			JSON.stringify({
				robs: [
					{ name: "planner", role: "plan" },
					{ name: "builder", role: "build" },
				],
				rooms: [
					{
						name: "ship-it",
						members: ["planner", "builder"],
						coordinator: "planner",
					},
				],
			}),
			"utf8",
		);

		const result = await readProjectConfig(workspace);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.rooms).toEqual([
			{
				name: "ship-it",
				members: ["planner", "builder"],
				coordinator: "planner",
			},
		]);
	});

	it("rejects a coordinator that is not a member", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			JSON.stringify({
				robs: [
					{ name: "planner", role: "plan" },
					{ name: "builder", role: "build" },
				],
				rooms: [
					{
						name: "ship-it",
						members: ["planner", "builder"],
						coordinator: "reviewer",
					},
				],
			}),
			"utf8",
		);

		const result = await readProjectConfig(workspace);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(
			"The coordinator must be a member of the room.",
		);
	});
});

describe("addPermissionRule", () => {
	it("keeps unrelated keys and existing rules, appending the new rule", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					provider: { model: "deepseek-flash" },
					permissions: { bash: [{ pattern: "git *", action: "allow" }] },
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await addPermissionRule(workspace, "bash", "npm *", "allow");

		expect(result).toEqual({ ok: true });
		const written = await readFile(join(workspace, "my-agent.json"), "utf8");
		expect(written).toBe(`{
  "provider": {
    "model": "deepseek-flash"
  },
  "permissions": {
    "bash": [
      {
        "pattern": "git *",
        "action": "allow"
      },
      {
        "pattern": "npm *",
        "action": "allow"
      }
    ]
  }
}
`);
	});

	it("creates the file when it is missing", async () => {
		await addPermissionRule(workspace, "write_file", "docs/x.md", "allow");

		const written = await readFile(join(workspace, "my-agent.json"), "utf8");
		expect(written).toBe(`{
  "permissions": {
    "write_file": [
      {
        "pattern": "docs/x.md",
        "action": "allow"
      }
    ]
  }
}
`);
	});

	it("serializes concurrent writes so neither rule is lost", async () => {
		await Promise.all([
			addPermissionRule(workspace, "write_file", "a.txt", "allow"),
			addPermissionRule(workspace, "bash", "npm *", "allow"),
		]);

		const written = await readFile(join(workspace, "my-agent.json"), "utf8");
		expect(JSON.parse(written)).toEqual({
			permissions: {
				write_file: [{ pattern: "a.txt", action: "allow" }],
				bash: [{ pattern: "npm *", action: "allow" }],
			},
		});
	});

	it("returns an error result when the existing file is invalid", async () => {
		await writeFile(join(workspace, "my-agent.json"), "{ not json", "utf8");

		const result = await addPermissionRule(
			workspace,
			"write_file",
			"docs/x.md",
			"allow",
		);

		expect(result.ok).toBe(false);
	});
});

describe("addRob skill scope", () => {
	// Creating a bot is the second write path, so it must enforce the same
	// invariant the update path does; guarding only one leaves a way to
	// persist the scope-widening shape.
	it("confirms a bare skill list so a new bot does not grant every skill", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [] })}\n`,
			"utf8",
		);

		const result = await addRob(workspace, {
			name: "newbot",
			role: "x",
			skills: [],
		});

		expect(result).toEqual({ ok: true });
		// The point of the flag: this reads back as "no skills", not as the
		// truth table row that hands over everything installed.
		const { raw, visible } = await readBackScope("newbot");
		expect(raw.skills).toEqual([]);
		expect(raw.skillsConfigured).toBe(true);
		expect(visible).toEqual([]);
	});

	it("refuses a skillsConfigured flag without a list", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [] })}\n`,
			"utf8",
		);

		const result = await addRob(workspace, {
			name: "newbot",
			role: "x",
			skillsConfigured: true,
		});

		expect(result).toEqual({
			ok: false,
			error: "skillsConfigured requires skills",
		});
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs).toEqual([]);
	});

	it("refuses a flag with no list before creating the file at all", async () => {
		// No my-agent.json yet: the refusal must come from validation, not
		// from reading an existing file, so nothing is created.
		const result = await addRob(workspace, {
			name: "newbot",
			role: "x",
			skillsConfigured: true,
		});

		expect(result).toEqual({
			ok: false,
			error: "skillsConfigured requires skills",
		});
		await expect(
			readFile(join(workspace, "my-agent.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("leaves a bot with no skill fields unscoped", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [] })}\n`,
			"utf8",
		);

		await addRob(workspace, { name: "newbot", role: "x" });

		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0].skills).toBeUndefined();
		expect(written.robs[0].skillsConfigured).toBeUndefined();
	});
});

describe("updateRob", () => {
	it("changes the role and keeps the wake, permissions, and unknown keys", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					permissions: { bash: [{ pattern: "git *", action: "allow" }] },
					custom: { keep: true },
					robs: [
						{
							name: "atlas",
							role: "old role",
							model: "deepseek-flash",
							wake: { everyMs: 5000, prompt: "tick" },
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "new role",
			model: "deepseek-chat",
		});

		expect(result).toEqual({ ok: true });
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0]).toEqual({
			name: "atlas",
			role: "new role",
			model: "deepseek-chat",
			wake: { everyMs: 5000, prompt: "tick" },
		});
		expect(written.permissions).toEqual({
			bash: [{ pattern: "git *", action: "allow" }],
		});
		expect(written.custom).toEqual({ keep: true });
	});

	it("drops the model and backend when the replacement omits them", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					robs: [
						{
							name: "atlas",
							role: "old",
							model: "deepseek-flash",
							backend: { kind: "native" },
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "new",
		});

		expect(result).toEqual({ ok: true });
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0]).toEqual({ name: "atlas", role: "new" });
	});

	it("fails with a specific message when the name is absent", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		expect(
			await updateRob(workspace, "ghost", { name: "ghost", role: "y" }),
		).toEqual({ ok: false, error: "Unknown rob: ghost" });
	});

	it("rejects a next that fails the rob schema", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		const result = await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			backend: { kind: "cli", command: "codex" },
		});

		expect(result.ok).toBe(false);
	});

	it("keeps the stored skill and MCP scope when the replacement omits both", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					robs: [
						{
							name: "atlas",
							role: "old",
							skills: ["alpha"],
							skillsConfigured: true,
							mcp: ["github"],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "new",
		});

		expect(result).toEqual({ ok: true });
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		// Editing only the role must not silently widen or narrow the bot's
		// scope — the panel sends these fields only when it actually changed
		// them.
		expect(written.robs[0]).toEqual({
			name: "atlas",
			role: "new",
			skills: ["alpha"],
			skillsConfigured: true,
			mcp: ["github"],
		});
	});

	it("writes a confirmed empty skill list, which is not the same as absent", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skills: [],
			skillsConfigured: true,
		});

		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0].skills).toEqual([]);
		expect(written.robs[0].skillsConfigured).toBe(true);
	});

	it("refuses a skillsConfigured flag without a skills list", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		const result = await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skillsConfigured: true,
		});

		// The flag qualifies a list; on its own it means nothing, and guessing
		// would let a scope widen or narrow on a malformed request.
		expect(result).toEqual({
			ok: false,
			error: "skillsConfigured requires skills",
		});
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0]).toEqual({ name: "atlas", role: "x" });
	});

	it("confirms an empty skill list so it reads back as the empty set", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		// "No skills" must not persist as a bare [] — that is truth table row
		// 2, which resolves to every installed skill. Writing the flag beside
		// it is what makes the stored file mean what it says.
		await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skills: [],
		});

		const { raw, visible } = await readBackScope("atlas");
		expect(raw.skills).toEqual([]);
		expect(raw.skillsConfigured).toBe(true);
		expect(visible).toEqual([]);
	});

	it("confirms a non-empty skill list on write", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skills: ["alpha"],
		});

		// Reads back through the schema, not just JSON.parse: a field the
		// reader drops is a bug even when the file looks right.
		const { raw, visible } = await readBackScope("atlas");
		expect(raw.skills).toEqual(["alpha"]);
		expect(raw.skillsConfigured).toBe(true);
		expect(visible).toEqual([installed[0]]);
	});

	it("keeps an explicit skillsConfigured:false as the way back to the default", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					robs: [
						{ name: "atlas", role: "x", skills: [], skillsConfigured: true },
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		// Clearing the confirmation is how a bot returns to "all installed";
		// the stored pair then matches truth table row 2 on purpose.
		await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skills: [],
			skillsConfigured: false,
		});

		const { raw, visible } = await readBackScope("atlas");
		expect(raw.skillsConfigured).toBe(false);
		expect(visible).toHaveLength(2);
	});

	it("round-trips a skill whitelist and MCP selection through the file", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		await updateRob(workspace, "atlas", {
			name: "atlas",
			role: "x",
			skills: ["alpha", "beta"],
			skillsConfigured: true,
			mcp: ["docs"],
		});

		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs[0].skills).toEqual(["alpha", "beta"]);
		expect(written.robs[0].mcp).toEqual(["docs"]);
	});
});

describe("removeRob", () => {
	it("drops exactly one entry and keeps the others and unknown keys", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					custom: 1,
					robs: [
						{ name: "atlas", role: "a" },
						{
							name: "worker",
							role: "w",
							wake: { everyMs: 1000, prompt: "tick" },
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await removeRob(workspace, "atlas");

		expect(result).toEqual({ ok: true });
		const written = JSON.parse(
			await readFile(join(workspace, "my-agent.json"), "utf8"),
		);
		expect(written.robs).toEqual([
			{ name: "worker", role: "w", wake: { everyMs: 1000, prompt: "tick" } },
		]);
		expect(written.custom).toBe(1);
	});

	it("fails with a specific message when the name is absent", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify({ robs: [{ name: "atlas", role: "x" }] })}\n`,
			"utf8",
		);

		expect(await removeRob(workspace, "ghost")).toEqual({
			ok: false,
			error: "Unknown rob: ghost",
		});
	});

	it("fails when the file is missing", async () => {
		expect(await removeRob(workspace, "ghost")).toEqual({
			ok: false,
			error: "Unknown rob: ghost",
		});
	});
});
