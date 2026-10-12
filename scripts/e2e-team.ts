import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config/resolve.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../src/permissions/authorizer.js";
import { defaultRules } from "../src/permissions/rules.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { Team } from "../src/rob/team.js";
import { robToolRules } from "../src/rob/tools.js";

if (process.env.MY_AGENT_E2E !== "1") {
	console.log("skipped: set MY_AGENT_E2E=1 to run against the real API");
	process.exit(0);
}

const WAIT_MS = 120_000;
const POLL_MS = 200;
const failures: string[] = [];

const workspace = await mkdtemp(path.join(os.tmpdir(), "my-agent-e2e-team-"));
try {
	await writeFile(
		path.join(workspace, "my-agent.json"),
		`${JSON.stringify(
			{
				robs: [
					{
						name: "planner",
						role: "coordinate the team and ask the worker to do tasks",
					},
					{ name: "worker", role: "carry out file tasks" },
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const resolved = resolveConfig({
		workspaceRoot: workspace,
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		failures.push(resolved.error);
	} else {
		const { provider: settings, apiKey, permissions, robs } = resolved.config;
		if (apiKey === undefined) {
			failures.push(`missing ${settings.apiKeyEnv}`);
		} else {
			const provider = createOpenAICompatibleProvider({
				id: settings.preset,
				baseURL: settings.baseURL,
				apiKey,
				apiKeyEnv: settings.apiKeyEnv,
			});
			// Same --yes behavior as cli/team.ts: the headless run answers the
			// shared approval queue with allow_once instead of asking a user.
			const yesAll = true;
			const approve = headlessApproval({
				yesAll,
				log: (line) => process.stderr.write(line),
			});
			const team = new Team({
				robs,
				defaultModel: settings.model,
				providerFactory: () => provider,
				workspaceRoot: workspace,
				authorizerFactory: (rob) =>
					createAuthorizer({
						workspaceRoot: workspace,
						rules: {
							...defaultRules(),
							...robToolRules(),
							...permissions,
							...rob.permissions,
						},
						approval: rob.approval,
						yesAll,
					}),
			});
			team.subscribe((event) => {
				if (event.kind !== "approval_requested") return;
				const decision = approve(event.request);
				if (decision instanceof Promise) {
					void decision.then((value) =>
						team.resolveApproval(event.request.id, value),
					);
					return;
				}
				team.resolveApproval(event.request.id, decision);
			});

			team.start();
			team.dispatch(
				"planner",
				"Send worker a private message asking it to write the word hello into out.txt, then wait.",
			);
			team.dispatch(
				"worker",
				"Write the word hello into out.txt, then reply with done.",
			);

			const idle = await waitForIdle(team);
			const statuses = team.statuses();
			await team.stop();

			if (!idle) {
				failures.push(`team did not go idle within ${WAIT_MS} ms`);
			}
			for (const status of statuses) {
				if (status.status !== "idle") {
					failures.push(`${status.name} ended ${status.status}, expected idle`);
				}
			}

			let content: string | undefined;
			try {
				content = await readFile(path.join(workspace, "out.txt"), "utf8");
			} catch {
				content = undefined;
			}
			if (content === undefined) {
				failures.push("out.txt was not created");
			} else if (!content.includes("hello")) {
				failures.push(
					`out.txt does not contain hello: ${JSON.stringify(content)}`,
				);
			}

			const dms = team.readDms();
			if (
				!dms.some((entry) => entry.from === "planner" && entry.to === "worker")
			) {
				failures.push("no DM from planner to worker");
			}

			if (failures.length === 0) {
				console.log(
					`PASS out.txt contains hello, ${dms.length} DM(s) including planner -> worker, both robs idle`,
				);
			}
		}
	}
} finally {
	await rm(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL ${failure}`);
	process.exitCode = 1;
}

async function waitForIdle(team: Team): Promise<boolean> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		const statuses = team.statuses();
		if (
			statuses.length > 0 &&
			statuses.every((entry) => entry.status === "idle" && entry.pending === 0)
		) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	return false;
}
