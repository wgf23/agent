import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let withAgents: string;
let withoutAgents: string;

beforeAll(async () => {
	withAgents = await makeWorkspace("my-agent-prompt-with-");
	await writeFile(
		path.join(withAgents, "AGENTS.md"),
		"Project rules: be nice.",
		"utf8",
	);
	withoutAgents = await makeWorkspace("my-agent-prompt-without-");
});

afterAll(async () => {
	await removeWorkspace(withAgents);
	await removeWorkspace(withoutAgents);
});

describe("buildSystemPrompt", () => {
	it("includes the cwd, platform, date, and AGENTS.md content", async () => {
		const prompt = await buildSystemPrompt({
			workspaceRoot: withAgents,
			platform: "linux",
			date: "2026-10-11",
		});

		expect(prompt).toContain(withAgents);
		expect(prompt).toContain("- platform: linux");
		expect(prompt).toContain("- date: 2026-10-11");
		expect(prompt).toContain("## AGENTS.md");
		expect(prompt).toContain("Project rules: be nice.");
	});

	it("omits the AGENTS.md heading when the file is absent", async () => {
		const prompt = await buildSystemPrompt({
			workspaceRoot: withoutAgents,
			platform: "linux",
			date: "2026-10-11",
		});

		expect(prompt).not.toContain("## AGENTS.md");
	});
});
