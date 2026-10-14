import os from "node:os";
import path from "node:path";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import {
	autoApprovedLine,
	createAuthorizer,
	headlessApproval,
} from "../permissions/authorizer.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";
import {
	type DiscussionPort,
	deliverablePath,
	renderDeliverable,
	runDiscussion,
	writeDeliverable,
} from "../rob/discussion.js";
import { Team, UnknownRobError } from "../rob/team.js";
import type { DmEntry, RobConfig, RobStatusEntry } from "../rob/types.js";

const DEFAULT_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 50;
const DEFAULT_MAX_ROUNDS = 6;

export interface TeamCommandOptions {
	dispatch: string[];
	waitMs?: number;
	coordinator?: string;
	maxRounds?: number;
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
		defaultModel: settings.model,
		providerFactory: options.providerFactory ?? (() => provider),
		workspaceRoot,
		permissions,
		providerEnv: { [settings.apiKeyEnv]: apiKey },
		extraTools: mcp.tools,
		hooks: resolved.config.hooks,
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

	// The coordinator is explicit when given; otherwise a lone dispatch to one
	// rob out of several names that rob as the one coordinating the task, which
	// is what "dispatch the task to the lead" means in practice.
	const coordinator =
		options.coordinator ?? inferCoordinator(parsed.dispatches, robs);
	// A coordinator that is not on the roster would only fail later, inside the
	// wrap-up dispatch; refuse it before any work starts.
	if (coordinator !== undefined && !team.hasRob(coordinator)) {
		console.error(`Unknown rob: ${coordinator}`);
		await team.stop();
		return 1;
	}

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
		const task = discussionTask(parsed.dispatches, coordinator);
		const discussion = await runDiscussion(discussionPort(team), {
			coordinator,
			maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
			waitMs,
			task,
			wrapUp: wrapUpPrompt,
			pollMs: POLL_INTERVAL_MS,
		});

		// Stop moves every rob to "stopped", so snapshot the roster, the DMs,
		// and the statuses first to report what each rob actually did.
		const statuses = team.statuses();
		const dms = team.readDms();
		const participants = team.roster().map((member) => member.name);
		await team.stop();

		const deliverable = discussion.deliverable;
		let deliverableFilePath: string | null = null;
		if (
			coordinator !== undefined &&
			deliverable !== null &&
			deliverable !== ""
		) {
			const at = Date.now();
			deliverableFilePath = deliverablePath(
				path.join(workspaceRoot, "docs", "deliverables"),
				at,
				task,
			);
			await writeDeliverable(
				deliverableFilePath,
				renderDeliverable({
					task,
					coordinator,
					participants,
					dms,
					body: deliverable,
					at,
				}),
			);
		}

		printReport(statuses, dms, {
			rounds: discussion.rounds,
			converged: discussion.converged,
			reason: discussion.reason,
			deliverable,
			path: deliverableFilePath,
		});

		if (coordinator === undefined) {
			// Without a coordinator the old rule stands: any quiescence inside
			// the wait is success, and only a timeout is not.
			return discussion.reason === "timeout" ? 1 : 0;
		}
		return discussion.converged && deliverable !== null && deliverable !== ""
			? 0
			: 1;
	} finally {
		await mcp.dispose();
	}
}

// Coordination needs teammates, so this only kicks in for a real team; a single
// dispatched rob is the one that was handed the task, so it coordinates it.
function inferCoordinator(
	dispatches: readonly Dispatch[],
	robs: readonly RobConfig[],
): string | undefined {
	if (robs.length <= 1 || dispatches.length !== 1) return undefined;
	return dispatches[0]?.name;
}

// The coordinator's own dispatch names the work; without one the whole set of
// dispatches is the task.
function discussionTask(
	dispatches: readonly Dispatch[],
	coordinator: string | undefined,
): string {
	const directed =
		coordinator === undefined
			? undefined
			: dispatches.find((dispatch) => dispatch.name === coordinator)?.text;
	if (directed !== undefined) return directed;
	return dispatches.map((dispatch) => dispatch.text).join("\n");
}

function wrapUpPrompt(task: string): string {
	return [
		"Wrap up the discussion now and compile the final deliverable.",
		"State the concrete result, then stop.",
		"",
		`Task: ${task}`,
	].join("\n");
}

// The loop is pure, so the live team arrives through this thin adapter.
function discussionPort(team: Team): DiscussionPort {
	return {
		statuses: () =>
			team.statuses().map(({ name, status, pending }) => ({
				name,
				status,
				pending,
			})),
		dmCount: () => team.readDms().length,
		dispatch: (name, text) => team.dispatch(name, text),
		notice: (name, text) => team.emitNotice(name, text),
		lastMessage: (name) =>
			team.statuses().find((entry) => entry.name === name)?.lastMessage ?? null,
		now: () => Date.now(),
		sleep,
	};
}

interface DiscussionReport {
	rounds: number;
	converged: boolean;
	reason: string;
	deliverable: string | null;
	path: string | null;
}

function printReport(
	statuses: readonly RobStatusEntry[],
	dms: readonly DmEntry[],
	discussion: DiscussionReport,
): void {
	console.log("=== Discussion ===");
	console.log(`rounds: ${discussion.rounds}`);
	console.log(`converged: ${discussion.converged}`);
	console.log(`reason: ${discussion.reason}`);
	if (discussion.path === null) {
		console.log("deliverable: (none)");
	} else {
		console.log(`deliverable: ${discussion.path}`);
		console.log(discussion.deliverable);
	}

	console.log("");
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
