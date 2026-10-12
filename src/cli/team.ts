import os from "node:os";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { Team, UnknownRobError } from "../rob/team.js";
import { robToolRules } from "../rob/tools.js";

const DEFAULT_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 50;

export interface TeamCommandOptions {
	dispatch: string[];
	waitMs?: number;
	yesAll?: boolean;
}

interface Dispatch {
	name: string;
	text: string;
}

function parseDispatches(
	values: readonly string[],
): { ok: true; dispatches: Dispatch[] } | { ok: false; error: string } {
	const dispatches: Dispatch[] = [];
	for (const value of values) {
		const separator = value.indexOf("=");
		if (separator <= 0) {
			return {
				ok: false,
				error: `Invalid --dispatch "${value}". Use --dispatch <name>=<text>.`,
			};
		}
		dispatches.push({
			name: value.slice(0, separator),
			text: value.slice(separator + 1),
		});
	}
	return { ok: true, dispatches };
}

export async function runTeamCommand(
	options: TeamCommandOptions,
): Promise<number> {
	const workspaceRoot = process.cwd();
	const resolved = resolveConfig({
		workspaceRoot,
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const { provider: settings, apiKey, permissions, robs } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		return 1;
	}
	if (robs.length === 0) {
		console.error(
			'No robs configured. Add a "robs" array to my-agent.json, for example {"name":"planner","role":"coordinate"}.',
		);
		return 1;
	}

	const parsed = parseDispatches(options.dispatch);
	if (!parsed.ok) {
		console.error(parsed.error);
		return 1;
	}

	const provider = createOpenAICompatibleProvider({
		id: settings.preset,
		baseURL: settings.baseURL,
		apiKey,
		apiKeyEnv: settings.apiKeyEnv,
	});

	const yesAll = options.yesAll ?? false;
	const approve = headlessApproval({
		yesAll,
		log: (line) => process.stderr.write(line),
	});
	const team = new Team({
		robs,
		defaultModel: settings.model,
		providerFactory: () => provider,
		workspaceRoot,
		authorizerFactory: (rob) =>
			createAuthorizer({
				workspaceRoot,
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

	// Headless mode has no user, so answer the shared queue the moment a rob asks.
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
	for (const dispatch of parsed.dispatches) {
		try {
			team.dispatch(dispatch.name, dispatch.text);
		} catch (error) {
			if (error instanceof UnknownRobError) {
				console.error(error.message);
				await team.stop();
				return 1;
			}
			throw error;
		}
	}

	const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
	const idle = await waitForIdle(team, waitMs);
	await team.stop();

	printReport(team);
	return idle ? 0 : 1;
}

async function waitForIdle(team: Team, waitMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const statuses = team.statuses();
		if (
			statuses.length > 0 &&
			statuses.every((entry) => entry.status === "idle" && entry.pending === 0)
		) {
			return true;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return false;
}

function printReport(team: Team): void {
	console.log("=== DMs ===");
	const dms = team.readDms();
	if (dms.length === 0) {
		console.log("(no DMs)");
	}
	for (const dm of dms) {
		console.log(`${dm.from} -> ${dm.to}: ${dm.text}`);
	}

	for (const status of team.statuses()) {
		console.log("");
		console.log(`=== ${status.name} (${status.status}) ===`);
		console.log(status.lastMessage ?? "(no reply)");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
