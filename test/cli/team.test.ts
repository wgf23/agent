import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTeamCommand } from "../../src/cli/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;
let home: string;
const originalKey = process.env.DEEPSEEK_API_KEY;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-cli-team-");
	home = await makeWorkspace("my-agent-cli-team-home-");
	process.env.DEEPSEEK_API_KEY = "test-key";
	await writeFile(
		join(workspace, "my-agent.json"),
		`${JSON.stringify({ robs: [{ name: "planner", role: "plan" }] }, null, 2)}\n`,
		"utf8",
	);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	await removeWorkspace(home);
	if (originalKey === undefined) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = originalKey;
	}
});

describe("runTeamCommand", () => {
	it("prints the status a rob finished with, not stopped", async () => {
		const lines: string[] = [];
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});
		try {
			const code = await runTeamCommand({
				dispatch: ["planner=hi"],
				waitMs: 2000,
				yesAll: true,
				workspaceRoot: workspace,
				homeDir: home,
				providerFactory: () =>
					createMockProvider([
						[
							{ type: "text_delta", text: "did the work" },
							{ type: "finish", reason: "stop" },
						],
					]),
			});

			expect(code).toBe(0);
			expect(lines).toContain("=== planner (idle) ===");
			expect(lines.join("\n")).not.toContain("(stopped)");
			// A solo rob is not a team, so no coordinator is inferred and no
			// deliverable is written.
			await expect(
				readdir(join(workspace, "docs", "deliverables")),
			).rejects.toThrow();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("treats a lone dispatch to one rob of several as the coordinator", async () => {
		await writeFile(
			join(workspace, "my-agent.json"),
			`${JSON.stringify(
				{
					robs: [
						{ name: "planner", role: "plan" },
						{ name: "foodie", role: "food" },
						{ name: "navigator", role: "transit" },
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "planning" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", text: "inferred deliverable" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const code = await runTeamCommand({
			dispatch: ["planner=write it"],
			waitMs: 2000,
			yesAll: true,
			workspaceRoot: workspace,
			homeDir: home,
			providerFactory: () => provider,
		});

		expect(code).toBe(0);
		const dir = join(workspace, "docs", "deliverables");
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		const doc = await readFile(join(dir, files[0]), "utf8");
		expect(doc).toContain("Coordinator: planner");
		expect(doc).toContain("inferred deliverable");
	});

	it("writes the coordinator deliverable and exits zero on convergence", async () => {
		const lines: string[] = [];
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});
		try {
			const provider = createMockProvider([
				[
					{ type: "text_delta", text: "planned" },
					{ type: "finish", reason: "stop" },
				],
				[
					{ type: "text_delta", text: "the final deliverable" },
					{ type: "finish", reason: "stop" },
				],
			]);
			const code = await runTeamCommand({
				dispatch: ["planner=write the report"],
				waitMs: 2000,
				coordinator: "planner",
				maxRounds: 3,
				yesAll: true,
				workspaceRoot: workspace,
				homeDir: home,
				providerFactory: () => provider,
			});

			expect(code).toBe(0);
			const dir = join(workspace, "docs", "deliverables");
			const files = await readdir(dir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^\d{8}T\d{6}-.+\.md$/);
			const doc = await readFile(join(dir, files[0]), "utf8");
			expect(doc).toContain("# write the report");
			expect(doc).toContain("the final deliverable");
			expect(doc).toContain("Coordinator: planner");
			expect(lines.join("\n")).toContain("deliverable:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("exits non-zero when the coordinator produces no deliverable", async () => {
		const code = await runTeamCommand({
			dispatch: ["planner=hi"],
			waitMs: 200,
			coordinator: "planner",
			maxRounds: 1,
			yesAll: true,
			workspaceRoot: workspace,
			homeDir: home,
			// Every turn yields no text, so the wrap-up has nothing to return.
			providerFactory: () => createMockProvider([]),
		});

		expect(code).toBe(1);
	});

	it("refuses a coordinator that is not on the roster before any work runs", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const code = await runTeamCommand({
				dispatch: ["planner=hi"],
				waitMs: 2000,
				coordinator: "ghost",
				yesAll: true,
				workspaceRoot: workspace,
				homeDir: home,
				providerFactory: () => createMockProvider([]),
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Unknown rob: ghost");
		} finally {
			errorSpy.mockRestore();
		}
	});
});
