import os from "node:os";
import {
	childProviderEnv,
	missingApiKeyMessage,
	resolveConfig,
} from "../config/resolve.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import {
	autoApprovedLine,
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";
import { Team, UnknownRobError } from "../rob/team.js";
import type { DmEntry, RobConfig, RobStatusEntry } from "../rob/types.js";

const DEFAULT_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 50;

export interface TeamCommandOptions {
	dispatch: string[];
	waitMs?: number;
	yesAll?: boolean;
	workspaceRoot?: string;
	homeDir?: string;
	providerFactory?: (rob: RobConfig) => Provider;
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
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const resolved = resolveConfig({
		workspaceRoot,
		env: process.env,
		homeDir: options.homeDir ?? os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		return 1;
	}

	const {
		provider: settings,
		apiKey,
		permissions,
		robs,
		rooms,
	} = resolved.config;
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
	const allowAll = createAllowAll(yesAll);
	const approve = headlessApproval({
		yesAll,
		log: (line) => process.stderr.write(line),
	});
	// One connection serves every rob; it is disposed after the team stops.
	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot,
	});
	for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);
	const team = new Team({
		robs,
		rooms,
		defaultModel: settings.model,
		providerFactory: options.providerFactory ?? (() => provider),
		workspaceRoot,
		permissions,
		providerEnv: childProviderEnv(settings, apiKey),
		extraTools: mcp.tools,
		hooks: resolved.config.hooks,
		consolidate: true,
		authorizerFactory: (rob) =>
			createAuthorizer({
				workspaceRoot,
				rules: rob.rules,
				approval: rob.approval,
				yesAll,
				allowAll,
				onAutoApproved: (request) =>
					process.stderr.write(`${autoApprovedLine(request)}\n`),
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

	try {
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
		// Stop moves every rob to "stopped", so read the statuses first to report
		// what each rob actually did.
		const statuses = team.statuses();
		await team.stop();

		printReport(statuses, team.readDms());
		return idle ? 0 : 1;
	} finally {
		await mcp.dispose();
	}
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

function printReport(
	statuses: readonly RobStatusEntry[],
	dms: readonly DmEntry[],
): void {
	console.log("=== DMs ===");
	if (dms.length === 0) {
		console.log("(no DMs)");
	}
	for (const dm of dms) {
		console.log(`${dm.from} -> ${dm.to}: ${dm.text}`);
	}

	for (const status of statuses) {
		console.log("");
		console.log(`=== ${status.name} (${status.status}) ===`);
		console.log(status.lastMessage ?? "(no reply)");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
