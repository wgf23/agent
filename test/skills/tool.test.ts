import { describe, expect, it } from "vitest";
import type { Skill } from "../../src/skills/discover.js";
import { createLoadSkillTool } from "../../src/skills/tool.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctx: ToolContext = { workspaceRoot: "/workspace" };

const installed: Skill[] = [
	{
		name: "alpha",
		description: "first",
		packageName: "pkg-alpha",
		version: "1.0.0",
		dir: "/skills/alpha",
	},
	{
		name: "beta",
		description: "second",
		packageName: "pkg-beta",
		version: "1.0.0",
		dir: "/skills/beta",
	},
];

/** Spies that record calls, so a scope violation can be proven to touch
 *  neither the install directory nor the file. */
function spies() {
	const calls = { discover: 0, read: [] as string[] };
	return {
		calls,
		discover: async () => {
			calls.discover += 1;
			return installed;
		},
		read: async (dir: string) => {
			calls.read.push(dir);
			return `body of ${dir}`;
		},
	};
}

describe("createLoadSkillTool", () => {
	it("loads an allowlisted skill", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: ["alpha"],
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "alpha" }, ctx);

		expect(result).toEqual({ ok: true, output: "body of /skills/alpha" });
		expect(spy.calls.discover).toBe(1);
		expect(spy.calls.read).toEqual(["/skills/alpha"]);
	});

	it("refuses an out-of-scope skill without touching discover or read", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: ["alpha"],
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "beta" }, ctx);

		expect(result).toEqual({ ok: false, error: "Unknown skill: beta" });
		// The ordering contract: a scoped bot must not be able to tell an
		// existing-but-forbidden skill from one that does not exist.
		expect(spy.calls.discover).toBe(0);
		expect(spy.calls.read).toEqual([]);
	});

	it("refuses every skill under an empty allowlist, again with no IO", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: [],
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "alpha" }, ctx);

		expect(result).toEqual({ ok: false, error: "Unknown skill: alpha" });
		expect(spy.calls.discover).toBe(0);
		expect(spy.calls.read).toEqual([]);
	});

	it("answers an unscoped tool from the full installed set", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: null,
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "beta" }, ctx);

		expect(result).toEqual({ ok: true, output: "body of /skills/beta" });
	});

	it("rejects a traversal-shaped name before any scope or IO work", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: null,
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "../etc/passwd" }, ctx);

		expect(result).toEqual({
			ok: false,
			error: "Unknown skill: ../etc/passwd",
		});
		expect(spy.calls.discover).toBe(0);
		expect(spy.calls.read).toEqual([]);
	});

	it("reports an allowlisted name that is not installed", async () => {
		const spy = spies();
		const tool = createLoadSkillTool({
			allowed: ["alpha", "gone"],
			discover: spy.discover,
			read: spy.read,
		});

		const result = await tool.execute({ name: "gone" }, ctx);

		expect(result).toEqual({ ok: false, error: "Unknown skill: gone" });
		expect(spy.calls.read).toEqual([]);
	});

	it("surfaces a read failure without claiming the skill loaded", async () => {
		const tool = createLoadSkillTool({
			allowed: null,
			discover: async () => installed,
			read: async () => {
				throw new Error("permission denied");
			},
		});

		const result = await tool.execute({ name: "alpha" }, ctx);

		expect(result).toEqual({ ok: false, error: "permission denied" });
	});

	it("keeps every instance read-only and named load_skill", () => {
		const tool = createLoadSkillTool({ allowed: [] });
		expect(tool.name).toBe("load_skill");
		expect(tool.readOnly).toBe(true);
	});
});
