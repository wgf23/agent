import { AGENTS, type AgentId } from "../../shared/agents.js";
import { errorMessage } from "../util/errors.js";
import { resolveCommand } from "../util/which.js";
import type { InstallJob } from "./job.js";
import type { Probe } from "./probe.js";

export type Presence =
	| { kind: "absent" }
	| {
			kind: "installed";
			path: string;
			onPath: boolean;
			version: string | null;
			error: string | null;
	  };

export interface AgentState {
	id: AgentId;
	presence: Presence;
	job: InstallJob | undefined;
}

type CatalogAgent = (typeof AGENTS)[number];

// Folds the injected probe over the catalog. Probes run concurrently and every
// rejection is caught, so one wedged agent cannot stall or fail the rest. A
// binary found outside PATH (for example only in npm's global bin directory) is
// installed with onPath false; a binary that runs but whose --version failed is
// installed with a non-null error, never absent.
export async function detectAgents(
	probe: Probe,
	jobs?: ReadonlyMap<AgentId, InstallJob>,
): Promise<AgentState[]> {
	const settled = await Promise.allSettled(
		AGENTS.map((row) => detectOne(probe, row, jobs)),
	);
	return settled.map((result, index) => {
		if (result.status === "fulfilled") return result.value;
		const row = AGENTS[index];
		return {
			id: row.id,
			presence: {
				kind: "installed",
				path: row.command,
				onPath: false,
				version: null,
				error: errorMessage(result.reason),
			},
			job: jobs?.get(row.id),
		};
	});
}

async function detectOne(
	probe: Probe,
	row: CatalogAgent,
	jobs?: ReadonlyMap<AgentId, InstallJob>,
): Promise<AgentState> {
	const presence = await presenceFor(probe, row);
	return { id: row.id, presence, job: jobs?.get(row.id) };
}

async function presenceFor(probe: Probe, row: CatalogAgent): Promise<Presence> {
	const resolved = resolveCommand(row.command);
	const result = await probe(row.command);
	if (result.ok) {
		return {
			kind: "installed",
			path: result.path,
			onPath: resolved !== undefined,
			version: result.version,
			error: null,
		};
	}
	if (result.kind === "not_found") return { kind: "absent" };
	return {
		kind: "installed",
		path: resolved ?? row.command,
		onPath: resolved !== undefined,
		version: null,
		error: result.error,
	};
}
