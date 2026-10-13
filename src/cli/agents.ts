import { createInterface } from "node:readline/promises";
import { type AgentId, agentById } from "../../shared/agents.js";
import type { AgentJobView, AgentStatusView } from "../../shared/protocol.js";
import { isLive } from "../agents/job.js";
import { AgentSupervisor, toAgentStatusView } from "../agents/supervisor.js";
import { NPM_BIN, NPM_FLAGS } from "../util/npm.js";

const COLUMNS = ["id", "label", "npm", "status", "version", "path"];

export interface AgentsInstallOptions {
	yes?: boolean;
}

export async function runAgentsList(): Promise<number> {
	const supervisor = new AgentSupervisor();
	try {
		const states = await supervisor.list();
		process.stdout.write(formatAgentTable(states.map(toAgentStatusView)));
		return 0;
	} finally {
		await supervisor.dispose();
	}
}

// Resolves the id, prints the exact npm command the catalog implies, confirms on
// stdin unless --yes, then streams the job to stderr and returns its exit code.
export async function runAgentsInstall(
	id: string,
	options: AgentsInstallOptions = {},
): Promise<number> {
	const row = agentById(id);
	if (row === undefined) {
		console.error(`Unknown agent: ${id}`);
		return 1;
	}

	const command = `${NPM_BIN} install -g ${NPM_FLAGS.join(" ")} -- ${row.npm}`;
	process.stderr.write(`This will run: ${command}\n`);
	if (
		options.yes !== true &&
		!(await confirm(`Install ${row.label}? [y/N] `))
	) {
		process.stderr.write("Cancelled.\n");
		return 1;
	}

	const supervisor = new AgentSupervisor();
	try {
		const agentId = row.id as AgentId;
		const { job } = await supervisor.install(agentId, async () => ({
			ok: true,
		}));
		process.stderr.write(`${job.phase}: ${job.detail}\n`);
		if (!isLive(job.phase)) return exitCodeFor(job);
		for await (const snapshot of supervisor.jobs(agentId)) {
			process.stderr.write(`${snapshot.phase}: ${snapshot.detail}\n`);
			if (!isLive(snapshot.phase)) return exitCodeFor(snapshot);
		}
		return 1;
	} finally {
		await supervisor.dispose();
	}
}

export function formatAgentTable(statuses: readonly AgentStatusView[]): string {
	if (statuses.length === 0) return "No agents recognized.\n";

	const rows = statuses.map((agent) => [
		agent.id,
		agent.label,
		agent.npmPackage,
		agent.installed ? "installed" : "missing",
		agent.version ?? "",
		agent.path ?? "",
	]);
	const widths = COLUMNS.map((label, index) =>
		Math.max(label.length, ...rows.map((row) => row[index].length)),
	);
	const lines = [COLUMNS, ...rows].map((row) =>
		row
			.map((cell, index) =>
				index === row.length - 1 ? cell : cell.padEnd(widths[index]),
			)
			.join("  ")
			.trimEnd(),
	);
	return `${lines.join("\n")}\n`;
}

function exitCodeFor(job: AgentJobView): number {
	return job.phase === "installed" ? 0 : 1;
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}
