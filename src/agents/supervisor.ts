import { type AgentId, type AgentRow, agentById } from "../../shared/agents.js";
import type { AgentJobView, AgentStatusView } from "../../shared/protocol.js";
import { errorMessage } from "../util/errors.js";
import { resolveCommand } from "../util/which.js";
import { type AgentState, detectAgents } from "./detect.js";
import { npmInstallGlobal } from "./install.js";
import { advance, type InstallJob, isLive, type JobEvent } from "./job.js";
import { type Probe, probeVersion } from "./probe.js";

export type ApprovalGate = (
	state: AgentState,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface AgentSupervisorOptions {
	probe?: Probe;
	install?: typeof npmInstallGlobal;
	clock?: () => number;
	newId?: () => string;
	timeoutMs?: number;
	versionTtlMs?: number;
}

export type AgentEvent =
	| { type: "job"; job: InstallJob }
	| { type: "list"; agents: AgentState[] };

const DEFAULT_VERSION_TTL_MS = 30_000;

interface VersionEntry {
	version: string | null;
	at: number;
}

// The single object that touches the machine. `list` reads state, `install`
// drives one global npm install, and `jobs` streams a job's snapshots. Nothing
// here interprets npm's exit code as truth: only a re-probe can mark a job
// installed.
export class AgentSupervisor {
	private readonly probe: Probe;
	private readonly installer: typeof npmInstallGlobal;
	private readonly clock: () => number;
	private readonly newId: () => string;
	private readonly timeoutMs: number | undefined;
	private readonly versionTtlMs: number;
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private readonly jobsById = new Map<string, InstallJob>();
	private readonly lastByAgent = new Map<AgentId, InstallJob>();
	private readonly liveByAgent = new Map<AgentId, string>();
	private readonly versions = new Map<string, VersionEntry>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly runs = new Map<string, Promise<void>>();
	private readonly streams = new Map<AgentId, Set<JobQueue>>();
	private disposed = false;

	// Caches the version per resolved path. list() re-reads PATH every call, so
	// a cache hit only happens for a binary still resolvable to that same path.
	private readonly cachedProbe: Probe = async (command) => {
		const resolved = resolveCommand(command);
		if (resolved !== undefined) {
			const entry = this.versions.get(resolved);
			if (entry !== undefined && this.clock() - entry.at < this.versionTtlMs) {
				return { ok: true, version: entry.version, path: resolved };
			}
		}
		const result = await this.probe(command);
		if (result.ok) {
			this.versions.set(result.path, {
				version: result.version,
				at: this.clock(),
			});
		}
		return result;
	};

	constructor(options: AgentSupervisorOptions = {}) {
		this.probe = options.probe ?? probeVersion;
		this.installer = options.install ?? npmInstallGlobal;
		this.clock = options.clock ?? Date.now;
		this.newId = options.newId ?? defaultId;
		this.timeoutMs = options.timeoutMs;
		this.versionTtlMs = options.versionTtlMs ?? DEFAULT_VERSION_TTL_MS;
	}

	// Re-resolves PATH on every call and folds in any live job.
	async list(): Promise<AgentState[]> {
		const agents = await detectAgents(this.cachedProbe, this.liveJobs());
		this.emit({ type: "list", agents });
		return agents;
	}

	async install(
		id: AgentId,
		gate: ApprovalGate,
	): Promise<{ job: InstallJob; alreadyRunning: boolean }> {
		if (this.disposed) throw new Error("The supervisor has been disposed.");
		const row = agentById(id);
		if (row === undefined) throw new Error(`Unknown agent: ${id}`);

		const states = await this.list();
		const state = states.find((candidate) => candidate.id === id);
		if (state === undefined) throw new Error(`Unknown agent: ${id}`);

		const approval = await gate(state);
		if (!approval.ok) {
			return {
				job: this.oneOff("failed", id, approval.error, approval.error),
				alreadyRunning: false,
			};
		}

		if (state.presence.kind === "installed") {
			const job = this.oneOff(
				"installed",
				id,
				`already installed at ${state.presence.path}`,
				null,
			);
			this.record(job);
			return { job, alreadyRunning: false };
		}

		const running = this.liveJob(id);
		if (running !== undefined) return { job: running, alreadyRunning: true };

		if (this.liveByAgent.size > 0) {
			return {
				job: this.oneOff(
					"failed",
					id,
					"Another install is running; try again after it finishes.",
					"Another install is running; try again after it finishes.",
				),
				alreadyRunning: false,
			};
		}

		const job: InstallJob = {
			id: this.newId(),
			agent: id,
			phase: "queued",
			detail: "queued",
			startedAt: this.clock(),
			endedAt: null,
			error: null,
		};
		this.record(job);
		this.liveByAgent.set(id, job.id);
		const run = this.performInstall(id, row, job);
		this.runs.set(job.id, run);
		void run.finally(() => {
			this.runs.delete(job.id);
		});
		return { job, alreadyRunning: false };
	}

	// Aborting a live job marks it cancelled at once, then kills npm; any later
	// update from the dead process is ignored because the job is terminal.
	cancel(id: AgentId): boolean {
		const job = this.liveJob(id);
		if (job === undefined) return false;
		this.apply(id, job.id, { type: "cancelled" });
		this.controllers.get(job.id)?.abort();
		return true;
	}

	job(jobId: string): InstallJob | undefined {
		return this.jobsById.get(jobId);
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// Streams every snapshot of every job for one agent: the current live job
	// first, then each update, then future jobs for the same agent.
	async *jobs(id: AgentId): AsyncIterableIterator<InstallJob> {
		const queue = new JobQueue();
		const running = this.liveJob(id) ?? this.lastByAgent.get(id);
		if (running !== undefined) queue.push(running);
		let streams = this.streams.get(id);
		if (streams === undefined) {
			streams = new Set();
			this.streams.set(id, streams);
		}
		streams.add(queue);
		try {
			for (;;) {
				const next = await queue.next();
				if (next.done) return;
				yield next.value;
			}
		} finally {
			streams.delete(queue);
			if (streams.size === 0) this.streams.delete(id);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const id of [...this.liveByAgent.keys()]) this.cancel(id);
		await Promise.allSettled([...this.runs.values()]);
		for (const streams of this.streams.values()) {
			for (const stream of streams) stream.close();
		}
		this.streams.clear();
		this.listeners.clear();
	}

	private async performInstall(
		id: AgentId,
		row: AgentRow,
		job: InstallJob,
	): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		try {
			this.apply(id, job.id, { type: "start" });
			const result = await this.installer(row.npm, {
				onOutput: (line) => this.apply(id, job.id, { type: "output", line }),
				signal: controller.signal,
				timeoutMs: this.timeoutMs,
			});
			const current = this.jobsById.get(job.id);
			if (current === undefined || !isLive(current.phase)) return;
			if (!result.ok && result.cancelled) {
				this.apply(id, job.id, { type: "cancelled" });
				return;
			}
			this.apply(id, job.id, { type: "npm_ok" });
			await this.verify(id, row, job.id);
		} catch (error) {
			this.apply(id, job.id, {
				type: "npm_failed",
				error: errorMessage(error),
			});
		} finally {
			this.controllers.delete(job.id);
		}
	}

	// npm's exit code is not the source of truth. Re-probe the same probe: a
	// resolvable binary is installed, otherwise the job is unverified.
	private async verify(
		id: AgentId,
		row: AgentRow,
		jobId: string,
	): Promise<void> {
		const result = await this.cachedProbe(row.command);
		if (result.ok) {
			this.apply(id, jobId, {
				type: "verified",
				version: result.version,
				path: result.path,
			});
			return;
		}
		if (result.kind === "not_found") {
			this.apply(id, jobId, { type: "unverified", path: null });
			return;
		}
		const resolved = resolveCommand(row.command);
		this.apply(id, jobId, {
			type: "verified",
			version: null,
			path: resolved ?? row.command,
		});
	}

	private apply(id: AgentId, jobId: string, event: JobEvent): void {
		const job = this.jobsById.get(jobId);
		if (job === undefined) return;
		const next = advance(job, event);
		if (next === job) return;
		const stamped =
			!isLive(next.phase) && next.endedAt === null
				? { ...next, endedAt: this.clock() }
				: next;
		if (!isLive(stamped.phase) && this.liveByAgent.get(id) === jobId) {
			this.liveByAgent.delete(id);
		}
		this.record(stamped);
	}

	private record(job: InstallJob): void {
		this.jobsById.set(job.id, job);
		this.lastByAgent.set(job.agent, job);
		const streams = this.streams.get(job.agent);
		if (streams !== undefined) {
			for (const stream of [...streams]) stream.push(job);
		}
		this.emit({ type: "job", job });
	}

	private liveJob(id: AgentId): InstallJob | undefined {
		const jobId = this.liveByAgent.get(id);
		if (jobId === undefined) return undefined;
		const job = this.jobsById.get(jobId);
		if (job === undefined || !isLive(job.phase)) {
			this.liveByAgent.delete(id);
			return undefined;
		}
		return job;
	}

	private liveJobs(): Map<AgentId, InstallJob> {
		const map = new Map<AgentId, InstallJob>();
		for (const id of [...this.liveByAgent.keys()]) {
			const job = this.liveJob(id);
			if (job !== undefined) map.set(id, job);
		}
		return map;
	}

	private oneOff(
		phase: "installed" | "failed",
		agent: AgentId,
		detail: string,
		error: string | null,
	): InstallJob {
		const now = this.clock();
		return {
			id: this.newId(),
			agent,
			phase,
			detail,
			startedAt: now,
			endedAt: now,
			error,
		};
	}

	private emit(event: AgentEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

function defaultId(): string {
	return `job_${Math.random().toString(36).slice(2, 10)}`;
}

// The one projection from domain state to the wire view, shared by the server
// and the CLI so the two surfaces cannot drift.
export function toAgentJobView(job: InstallJob): AgentJobView {
	return {
		id: job.id,
		agent: job.agent,
		phase: job.phase,
		detail: job.detail,
		error: job.error,
	};
}

export function toAgentStatusView(state: AgentState): AgentStatusView {
	const row = agentById(state.id);
	if (row === undefined) throw new Error(`Unknown agent: ${state.id}`);
	const presence = state.presence;
	const installed = presence.kind === "installed";
	return {
		id: state.id,
		label: row.label,
		command: row.command,
		npmPackage: row.npm,
		installed,
		onPath: installed ? presence.onPath : false,
		path: installed ? presence.path : null,
		version: installed ? presence.version : null,
		error: installed ? presence.error : null,
		robBackend: row.rob,
		needsProviderAndModel: row.needsProviderAndModel === true,
		robBlockedReason: row.robBlockedReason ?? "",
		testedVersion: row.testedVersion,
		job: state.job === undefined ? null : toAgentJobView(state.job),
	};
}

// A push queue that an async generator drains. Push before a consumer arrives
// buffers so no update is lost between install() and the first iteration.
class JobQueue {
	private readonly buffer: InstallJob[] = [];
	private readonly waiters: Array<
		(result: IteratorResult<InstallJob>) => void
	> = [];
	private closed = false;

	push(job: InstallJob): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter({ value: job, done: false });
		else this.buffer.push(job);
	}

	next(): Promise<IteratorResult<InstallJob>> {
		const job = this.buffer.shift();
		if (job !== undefined) return Promise.resolve({ value: job, done: false });
		if (this.closed) {
			return Promise.resolve({ value: undefined as never, done: true });
		}
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ value: undefined as never, done: true });
		}
	}
}
