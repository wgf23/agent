import type { AgentId } from "../../shared/agents.js";

export type InstallPhase =
	| "queued"
	| "installing"
	| "verifying"
	| "installed"
	| "unverified"
	| "failed"
	| "cancelled";

export interface InstallJob {
	id: string;
	agent: AgentId;
	phase: InstallPhase;
	detail: string;
	startedAt: number;
	endedAt: number | null;
	error: string | null;
}

export type JobEvent =
	| { type: "start" }
	| { type: "output"; line: string }
	| { type: "npm_ok" }
	| { type: "npm_failed"; error: string }
	| { type: "verified"; version: string | null; path: string }
	| { type: "unverified"; path: string | null }
	| { type: "cancelled" };

// A phase with a process behind it: only these accept further events. Every
// terminal phase ignores later events, so a late cancel or a duplicated npm
// exit cannot corrupt a finished job.
export function isLive(phase: InstallPhase): boolean {
	return phase === "queued" || phase === "installing" || phase === "verifying";
}

// The pure lifecycle. It owns phase, detail, and error; the supervisor stamps
// startedAt/endedAt from its clock. Total by construction: an event that does
// not belong to the current phase returns the job unchanged.
export function advance(job: InstallJob, event: JobEvent): InstallJob {
	if (!isLive(job.phase)) return job;
	switch (event.type) {
		case "start":
			if (job.phase !== "queued") return job;
			return { ...job, phase: "installing", detail: "installing" };
		case "output":
			if (job.phase !== "installing") return job;
			return { ...job, detail: event.line };
		case "npm_ok":
			if (job.phase !== "installing") return job;
			return { ...job, phase: "verifying", detail: "verifying" };
		case "npm_failed":
			if (job.phase !== "installing") return job;
			return {
				...job,
				phase: "failed",
				detail: event.error,
				error: event.error,
			};
		case "verified":
			if (job.phase !== "verifying") return job;
			return {
				...job,
				phase: "installed",
				detail:
					event.version === null
						? `installed at ${event.path}`
						: `installed ${event.version} at ${event.path}`,
				error: null,
			};
		case "unverified": {
			if (job.phase !== "verifying") return job;
			const error =
				event.path === null
					? "The command is not on PATH after npm finished."
					: `The command is not at ${event.path} after npm finished.`;
			return {
				...job,
				phase: "unverified",
				detail: error,
				error,
			};
		}
		case "cancelled":
			return { ...job, phase: "cancelled", detail: "cancelled", error: null };
	}
}
