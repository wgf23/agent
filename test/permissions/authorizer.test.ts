import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAuthorizer,
	headlessApproval,
} from "../../src/permissions/authorizer.js";
import {
	defaultRules,
	type PermissionRules,
} from "../../src/permissions/rules.js";
import { bashTool } from "../../src/tools/bash.js";
import { readFileTool } from "../../src/tools/read_file.js";
import { writeFileTool } from "../../src/tools/write_file.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-authorizer-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

const readCall = { id: "call_1", name: "read_file", args: { path: "a.txt" } };
const writeCall = {
	id: "call_2",
	name: "write_file",
	args: { path: "docs/x.md", content: "x" },
};
const bashCall = (command: string) => ({
	id: "call_3",
	name: "bash",
	args: { command },
});

describe("createAuthorizer", () => {
	it("allows a read-only call without calling approval", async () => {
		const approval = vi.fn(async () => "deny" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		const decision = await authorize(readCall, readFileTool);

		expect(decision).toEqual({ allowed: true });
		expect(approval).not.toHaveBeenCalled();
	});

	it("calls approval once for a write and honors allow_once", async () => {
		const approval = vi.fn(async () => "allow_once" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		const decision = await authorize(writeCall, writeFileTool);

		expect(decision).toEqual({ allowed: true });
		expect(approval).toHaveBeenCalledTimes(1);
		expect(approval).toHaveBeenCalledWith({
			toolName: "write_file",
			subject: "docs/x.md",
			dangerous: false,
			rule: "docs/x.md",
		});
	});

	it("returns the literal reason when the user denies", async () => {
		const approval = vi.fn(async () => "deny" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		const decision = await authorize(writeCall, writeFileTool);

		expect(decision).toEqual({
			allowed: false,
			reason: "The user denied write_file docs/x.md.",
		});
	});

	it("persists an allow_always rule and skips approval on the next call", async () => {
		const approval = vi.fn(async () => "allow_always" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		const first = await authorize(writeCall, writeFileTool);
		expect(first).toEqual({ allowed: true, remember: true });
		expect(approval).toHaveBeenCalledTimes(1);

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

		const second = await authorize(writeCall, writeFileTool);
		expect(second).toEqual({ allowed: true });
		expect(approval).toHaveBeenCalledTimes(1);
	});

	it("saves the first word of a bash command as a wildcard rule", async () => {
		const approval = vi.fn(async () => "allow_always" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		await authorize(bashCall("npm install left-pad"), bashTool);

		const written = await readFile(join(workspace, "my-agent.json"), "utf8");
		expect(written).toBe(`{
  "permissions": {
    "bash": [
      {
        "pattern": "npm *",
        "action": "allow"
      }
    ]
  }
}
`);

		const next = await authorize(bashCall("npm run build"), bashTool);
		expect(next).toEqual({ allowed: true });
		expect(approval).toHaveBeenCalledTimes(1);
	});

	it("does not persist a rule when a dangerous call is answered allow_always", async () => {
		const approval = vi.fn(async () => "allow_always" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval,
			yesAll: false,
		});

		const decision = await authorize(bashCall("rm -rf dist"), bashTool);

		expect(decision).toEqual({ allowed: true });
		await expect(access(join(workspace, "my-agent.json"))).rejects.toThrow();
	});

	it("returns the literal deny reason for a matching deny rule", async () => {
		const rules: PermissionRules = {
			...defaultRules(),
			write_file: [{ pattern: "docs/*", action: "deny" }],
		};
		const approval = vi.fn(async () => "allow_once" as const);
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules,
			approval,
			yesAll: false,
		});

		const decision = await authorize(writeCall, writeFileTool);

		expect(decision).toEqual({
			allowed: false,
			reason: "Denied by rule for write_file docs/x.md.",
		});
		expect(approval).not.toHaveBeenCalled();
	});

	it("approves asks under yesAll and warns before a dangerous call", async () => {
		const lines: string[] = [];
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval: headlessApproval({
				yesAll: true,
				log: (line) => lines.push(line),
			}),
			yesAll: true,
		});

		const decision = await authorize(bashCall("rm -rf dist"), bashTool);

		expect(decision).toEqual({ allowed: true });
		expect(lines).toEqual([
			"[approval] bash rm -rf dist approved by --yes (dangerous)\n",
		]);
	});

	it("never writes a project file under yesAll", async () => {
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval: headlessApproval({ yesAll: true, log: () => {} }),
			yesAll: true,
		});

		await authorize(writeCall, writeFileTool);

		await expect(access(join(workspace, "my-agent.json"))).rejects.toThrow();
	});
});

describe("headlessApproval", () => {
	it("denies with the literal re-run reason when yesAll is false", async () => {
		const approval = headlessApproval({ yesAll: false, log: () => {} });

		const decision = await approval({
			toolName: "write_file",
			subject: "docs/x.md",
			dangerous: false,
			rule: "docs/x.md",
		});

		expect(decision).toEqual({
			deny: "Approval required for write_file docs/x.md. Re-run with --yes to approve.",
		});
	});

	it("approves with allow_once when yesAll is true", async () => {
		const approval = headlessApproval({ yesAll: true, log: () => {} });

		const decision = await approval({
			toolName: "write_file",
			subject: "docs/x.md",
			dangerous: false,
			rule: "docs/x.md",
		});

		expect(decision).toBe("allow_once");
	});

	it("prints the outcome lines to the write hook", async () => {
		const denied: string[] = [];
		const approved: string[] = [];
		await headlessApproval({
			yesAll: false,
			log: (line) => denied.push(line),
		})({
			toolName: "write_file",
			subject: "docs/x.md",
			dangerous: false,
			rule: "docs/x.md",
		});
		await headlessApproval({
			yesAll: true,
			log: (line) => approved.push(line),
		})({
			toolName: "bash",
			subject: "rm -rf dist",
			dangerous: true,
			rule: null,
		});

		expect(denied).toEqual(["[approval] write_file docs/x.md denied\n"]);
		expect(approved).toEqual([
			"[approval] bash rm -rf dist approved by --yes (dangerous)\n",
		]);
	});
});
