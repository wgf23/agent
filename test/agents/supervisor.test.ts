import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NpmOptions, NpmResult } from "../../src/agents/install.js";
import { type InstallJob, isLive } from "../../src/agents/job.js";
import type { ProbeResult } from "../../src/agents/probe.js";
import {
	AgentSupervisor,
	type ApprovalGate,
} from "../../src/agents/supervisor.js";

const allow: ApprovalGate = async () => ({ ok: true });

function missing(command: string): ProbeResult {
	return { ok: false, kind: "not_found", error: `missing ${command}` };
}

function fixedProbe(result: ProbeResult): () => Promise<ProbeResult> {
	return async () => result;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function settle(
	sup: AgentSupervisor,
	jobId: string,
	timeoutMs = 3000,
): Promise<InstallJob> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = sup.job(jobId);
		if (job !== undefined && !isLive(job.phase)) return job;
		if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentSupervisor", () => {
	it("is idempotent for an already-installed agent and never runs npm", async () => {
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => ({
				ok: true,
			}),
		);
		const sup = new AgentSupervisor({
			probe: fixedProbe({
				ok: true,
				version: "1.0.0",
				path: "/opt/npm/bin/pi",
			}),
			install,
		});

		const result = await sup.install("pi", allow);

		expect(result.alreadyRunning).toBe(false);
		expect(result.job.phase).toBe("installed");
		expect(result.job.detail).toBe("already installed at /opt/npm/bin/pi");
		expect(install).not.toHaveBeenCalled();
		await sup.dispose();
	});

	it("returns the running job with alreadyRunning on a second install", async () => {
		const pending = deferred<NpmResult>();
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> =>
				pending.promise,
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const first = await sup.install("pi", allow);
		const second = await sup.install("pi", allow);

		expect(first.job.phase).toBe("queued");
		expect(second.alreadyRunning).toBe(true);
		expect(second.job.id).toBe(first.job.id);
		expect(install).toHaveBeenCalledTimes(1);

		pending.resolve({ ok: true });
		await settle(sup, first.job.id);
		await sup.dispose();
	});

	it("fails a different id while a global install is live", async () => {
		const pending = deferred<NpmResult>();
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> =>
				pending.promise,
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const first = await sup.install("pi", allow);
		const other = await sup.install("codex", allow);

		expect(other.alreadyRunning).toBe(false);
		expect(other.job.phase).toBe("failed");
		expect(other.job.error).toMatch(/another install is running/i);
		expect(install).toHaveBeenCalledTimes(1);
		expect(sup.job(other.job.id)).toBeUndefined();

		pending.resolve({ ok: true });
		await settle(sup, first.job.id);
		await sup.dispose();
	});

	it("ends unverified when npm succeeds but the re-probe still says absent", async () => {
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => ({
				ok: true,
			}),
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const { job } = await sup.install("pi", allow);
		const done = await settle(sup, job.id);

		expect(done.phase).toBe("unverified");
		expect(done.error).toMatch(/not on PATH/);
		expect(install).toHaveBeenCalledTimes(1);
		await sup.dispose();
	});

	it("ends installed when npm exits non-zero but the re-probe finds the binary", async () => {
		let present = false;
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => {
				present = true;
				return { ok: false, error: "npm ERR! boom", cancelled: false };
			},
		);
		const sup = new AgentSupervisor({
			probe: async (command) =>
				present
					? { ok: true, version: "2.0.0", path: `/opt/bin/${command}` }
					: missing(command),
			install,
		});

		const { job } = await sup.install("pi", allow);
		const done = await settle(sup, job.id);

		expect(done.phase).toBe("installed");
		expect(done.detail).toContain("2.0.0");
		expect(done.error).toBeNull();
		await sup.dispose();
	});

	it("fails the job when the installer itself rejects", async () => {
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => {
				throw new Error("could not spawn npm");
			},
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const { job } = await sup.install("pi", allow);
		const done = await settle(sup, job.id);

		expect(done.phase).toBe("failed");
		expect(done.error).toBe("could not spawn npm");
		await sup.dispose();
	});

	it("creates no job and runs no installer when the gate refuses", async () => {
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> => ({
				ok: true,
			}),
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const result = await sup.install("pi", async () => ({
			ok: false,
			error: "not allowed",
		}));

		expect(result.alreadyRunning).toBe(false);
		expect(result.job.phase).toBe("failed");
		expect(result.job.error).toBe("not allowed");
		expect(sup.job(result.job.id)).toBeUndefined();
		expect(install).not.toHaveBeenCalled();
		await sup.dispose();
	});

	it("cancels a live install without leaving it running", async () => {
		const pending = deferred<NpmResult>();
		const install = vi.fn(
			async (_pkg: string, _options?: NpmOptions): Promise<NpmResult> =>
				pending.promise,
		);
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install,
		});

		const { job } = await sup.install("pi", allow);
		expect(sup.cancel("pi")).toBe(true);
		expect(sup.cancel("pi")).toBe(false);
		pending.resolve({ ok: false, error: "cancelled", cancelled: true });
		const done = await settle(sup, job.id);
		expect(done.phase).toBe("cancelled");
		expect(done.endedAt).not.toBeNull();
		await sup.dispose();
	});

	it("streams a job's snapshots through jobs(id)", async () => {
		const sup = new AgentSupervisor({
			probe: async (command) => missing(command),
			install: async () => ({ ok: true }),
		});

		const { job } = await sup.install("pi", allow);
		const phases: string[] = [];
		for await (const snapshot of sup.jobs("pi")) {
			phases.push(snapshot.phase);
			if (!isLive(snapshot.phase)) break;
		}

		expect(phases).toContain("unverified");
		expect(sup.job(job.id)?.phase).toBe("unverified");
		await sup.dispose();
	});

	it("reuses a cached version within the TTL instead of re-probing", async () => {
		const bin = await mkdtemp(path.join(tmpdir(), "my-agent-sup-path-"));
		await writeFile(path.join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
		await chmod(path.join(bin, "pi"), 0o755);
		const original = process.env.PATH;
		process.env.PATH = bin;
		try {
			const probe = vi.fn(
				async (command: string): Promise<ProbeResult> => ({
					ok: true,
					version: "1.0.0",
					path: path.join(bin, command),
				}),
			);
			const sup = new AgentSupervisor({
				probe,
				versionTtlMs: 60_000,
				clock: () => 0,
			});

			await sup.list();
			await sup.list();

			const piCalls = probe.mock.calls.filter(
				([command]) => command === "pi",
			).length;
			expect(piCalls).toBe(1);
			await sup.dispose();
		} finally {
			process.env.PATH = original;
			await rm(bin, { recursive: true, force: true });
		}
	});
});
