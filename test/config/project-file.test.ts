import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addPermissionRule,
	readProjectConfig,
} from "../../src/config/project-file.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

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
