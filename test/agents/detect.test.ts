import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgents } from "../../src/agents/detect.js";
import type { InstallJob } from "../../src/agents/job.js";
import type { Probe, ProbeResult } from "../../src/agents/probe.js";

const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
});

function missing(command: string): ProbeResult {
	return { ok: false, kind: "not_found", error: `missing ${command}` };
}

function piOnly(result: ProbeResult): Probe {
	return async (command) => (command === "pi" ? result : missing(command));
}

function withPath(dir: string): void {
	process.env.PATH = dir;
}

describe("detectAgents", () => {
	it("marks a binary found only in the npm global bin dir as off PATH", async () => {
		const globalBin = mkdtempSync(path.join(tmpdir(), "my-agent-globalbin-"));
		const empty = mkdtempSync(path.join(tmpdir(), "my-agent-emptypath-"));
		withPath(empty);

		const binary = path.join(globalBin, "pi");
		const states = await detectAgents(
			piOnly({ ok: true, version: "1.0.0", path: binary }),
		);

		const pi = states.find((state) => state.id === "pi");
		expect(pi?.presence).toEqual({
			kind: "installed",
			path: binary,
			onPath: false,
			version: "1.0.0",
			error: null,
		});
	});

	it("sets onPath true when the command resolves on the given PATH", async () => {
		const bin = mkdtempSync(path.join(tmpdir(), "my-agent-onpath-"));
		writeFileSync(path.join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
		withPath(bin);

		const states = await detectAgents(
			piOnly({ ok: true, version: "1.0.0", path: path.join(bin, "pi") }),
		);

		expect(states.find((state) => state.id === "pi")?.presence).toEqual({
			kind: "installed",
			path: path.join(bin, "pi"),
			onPath: true,
			version: "1.0.0",
			error: null,
		});
	});

	it("stays installed with an error when the version probe failed", async () => {
		const empty = mkdtempSync(path.join(tmpdir(), "my-agent-emptypath-"));
		withPath(empty);

		const states = await detectAgents(
			piOnly({ ok: false, kind: "timeout", error: "timed out after 1ms" }),
		);

		const presence = states.find((state) => state.id === "pi")?.presence;
		expect(presence?.kind).toBe("installed");
		if (presence?.kind !== "installed") return;
		expect(presence.error).toBe("timed out after 1ms");
		expect(presence.version).toBeNull();
		expect(presence.onPath).toBe(false);
	});

	it("marks a not_found probe absent", async () => {
		const states = await detectAgents(async (command) => missing(command));
		for (const state of states)
			expect(state.presence).toEqual({ kind: "absent" });
	});

	it("folds a live job into the matching agent state", async () => {
		const job: InstallJob = {
			id: "job_1",
			agent: "pi",
			phase: "installing",
			detail: "installing",
			startedAt: 1,
			endedAt: null,
			error: null,
		};
		const states = await detectAgents(
			async (command) => missing(command),
			new Map([["pi", job]]),
		);
		expect(states.find((state) => state.id === "pi")?.job).toBe(job);
		expect(states.find((state) => state.id === "codex")?.job).toBeUndefined();
	});

	it("returns one state per catalog row even when a probe rejects", async () => {
		const states = await detectAgents(async (command) => {
			if (command === "pi") throw new Error("wedged");
			return missing(command);
		});

		expect(states).toHaveLength(5);
		const pi = states.find((state) => state.id === "pi");
		expect(pi?.presence.kind).toBe("installed");
		if (pi?.presence.kind !== "installed") return;
		expect(pi.presence.error).toBe("wedged");
		expect(states.find((state) => state.id === "codex")?.presence).toEqual({
			kind: "absent",
		});
	});
});
