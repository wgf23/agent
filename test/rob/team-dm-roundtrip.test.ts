import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Team } from "../../src/rob/team.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import { allowAllAuthorizerFactory, waitFor } from "./helpers.js";

const CLAUDE_FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-claude.mjs", import.meta.url),
);
const PI_FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-pi.mjs", import.meta.url),
);

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-team-dm-");
	await chmod(CLAUDE_FIXTURE, 0o755);
	await chmod(PI_FIXTURE, 0o755);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	delete process.env.FAKE_CLAUDE_SCENARIO;
	delete process.env.FAKE_CLAUDE_TEAM_CALLS;
	delete process.env.FAKE_CLAUDE_TEAM_RESULTS;
	delete process.env.FAKE_CLAUDE_ARGV_FILE;
	delete process.env.FAKE_CLAUDE_ENV_FILE;
	delete process.env.FAKE_CLAUDE_ENV_NAME;
	delete process.env.FAKE_CLAUDE_PID_FILE;
	delete process.env.FAKE_PI_SCENARIO;
	delete process.env.FAKE_PI_TEAM_CALLS;
	delete process.env.FAKE_PI_TEAM_RESULTS;
	delete process.env.FAKE_PI_ARGV_FILE;
	delete process.env.FAKE_PI_ENV_FILE;
	delete process.env.FAKE_PI_ENV_NAME;
	delete process.env.FAKE_PI_PID_FILE;
	delete process.env.FAKE_PI_STEER_FILE;
	delete process.env.MY_AGENT_CLAUDE_CONFIG_DIR;
});

describe("cross-backend DM roundtrip", () => {
	it("delivers a claude rob's DM to a pi rob and carries the pi rob's reply back", async () => {
		// claude resolves its binary by name, so the fixture copied to "claude" on
		// the child's PATH answers the rob config's command.
		const binDir = path.join(workspace, "bin");
		await mkdir(binDir, { recursive: true });
		await copyFile(CLAUDE_FIXTURE, path.join(binDir, "claude"));
		await chmod(path.join(binDir, "claude"), 0o755);

		const alphaCalls = path.join(workspace, "alpha-calls.json");
		const betaCalls = path.join(workspace, "beta-calls.json");
		const betaResults = path.join(workspace, "beta-results.json");
		await writeFile(
			alphaCalls,
			JSON.stringify([
				{ name: "send_message", args: { to: "beta", text: "ping" } },
			]),
			"utf8",
		);
		await writeFile(
			betaCalls,
			JSON.stringify([
				{ name: "send_message", args: { to: "alpha", text: "pong" } },
			]),
			"utf8",
		);

		process.env.FAKE_CLAUDE_SCENARIO = "team";
		process.env.FAKE_CLAUDE_TEAM_CALLS = alphaCalls;
		process.env.FAKE_PI_SCENARIO = "team";
		process.env.FAKE_PI_TEAM_CALLS = betaCalls;
		process.env.FAKE_PI_TEAM_RESULTS = betaResults;
		process.env.MY_AGENT_CLAUDE_CONFIG_DIR = path.join(
			workspace,
			"claude-config",
		);

		const team = new Team({
			robs: [
				{
					name: "alpha",
					role: "plan",
					backend: { kind: "cli", command: "claude" },
				},
				{
					name: "beta",
					role: "work",
					backend: {
						kind: "cli",
						command: PI_FIXTURE,
						provider: "deepseek",
						model: "deepseek-v4-flash",
					},
				},
			],
			defaultModel: "deepseek-flash",
			providerFactory: () => createMockProvider([]),
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			providerEnv: {
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		});
		team.start();
		team.dispatch("alpha", "reach the team");

		await waitFor(
			() => team.readDms().length >= 1,
			"alpha's ping to reach the team",
			20_000,
		);
		// alpha reads this file before it sends, so the ping proves the read. Blank
		// it so beta's reply does not wake alpha into re-sending the same ping and
		// the two robs ping-pong forever.
		await writeFile(alphaCalls, "[]", "utf8");

		await waitFor(
			() =>
				team.readDms().length === 2 &&
				team.statuses().every((entry) => entry.status === "idle"),
			"beta's reply and both robs to finish",
			20_000,
		);
		const statuses = team.statuses();
		await team.stop();

		expect(team.readDms()).toEqual([
			{ from: "alpha", to: "beta", text: "ping", at: expect.any(Number) },
			{ from: "beta", to: "alpha", text: "pong", at: expect.any(Number) },
		]);
		expect(statuses.map((entry) => entry.status)).toEqual(["idle", "idle"]);
		expect(JSON.parse(await readFile(betaResults, "utf8"))).toEqual([
			'Message queued for "alpha".',
			"Denied by the my-agent approval bridge.",
		]);
	}, 30_000);
});
