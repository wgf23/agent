import { describe, expect, it } from "vitest";
import type { InstallPhase } from "../../shared/protocol.js";
import {
	advance,
	type InstallJob,
	isLive,
	type JobEvent,
} from "../../src/agents/job.js";

function job(overrides: Partial<InstallJob> = {}): InstallJob {
	return {
		id: "job_1",
		agent: "pi",
		phase: "queued",
		detail: "queued",
		startedAt: 1,
		endedAt: null,
		error: null,
		...overrides,
	};
}

const TERMINAL: InstallPhase[] = [
	"installed",
	"unverified",
	"failed",
	"cancelled",
];

const EVERY_EVENT: JobEvent[] = [
	{ type: "start" },
	{ type: "output", line: "line" },
	{ type: "npm_ok" },
	{ type: "npm_failed", error: "boom" },
	{ type: "verified", version: "1.0.0", path: "/bin/pi" },
	{ type: "unverified", path: null },
	{ type: "cancelled" },
];

describe("isLive", () => {
	it("is true only for the phases with a process behind them", () => {
		expect(isLive("queued")).toBe(true);
		expect(isLive("installing")).toBe(true);
		expect(isLive("verifying")).toBe(true);
		for (const phase of TERMINAL) expect(isLive(phase)).toBe(false);
	});
});

describe("advance", () => {
	it("moves queued to installing on start", () => {
		const next = advance(job(), { type: "start" });
		expect(next.phase).toBe("installing");
		expect(next.detail).toBe("installing");
	});

	it("replaces the detail with each output line while installing", () => {
		const next = advance(job({ phase: "installing" }), {
			type: "output",
			line: "npm notice hi",
		});
		expect(next.phase).toBe("installing");
		expect(next.detail).toBe("npm notice hi");
	});

	it("moves installing to verifying on npm_ok", () => {
		const next = advance(job({ phase: "installing" }), { type: "npm_ok" });
		expect(next.phase).toBe("verifying");
		expect(next.detail).toBe("verifying");
	});

	it("moves installing to failed and records the npm error", () => {
		const next = advance(job({ phase: "installing" }), {
			type: "npm_failed",
			error: "npm ERR! boom",
		});
		expect(next.phase).toBe("failed");
		expect(next.detail).toBe("npm ERR! boom");
		expect(next.error).toBe("npm ERR! boom");
	});

	it("moves verifying to installed with the probed version and path", () => {
		const next = advance(job({ phase: "verifying" }), {
			type: "verified",
			version: "1.2.3",
			path: "/usr/bin/pi",
		});
		expect(next.phase).toBe("installed");
		expect(next.detail).toBe("installed 1.2.3 at /usr/bin/pi");
		expect(next.error).toBeNull();
	});

	it("names the path when the version is unknown", () => {
		const next = advance(job({ phase: "verifying" }), {
			type: "verified",
			version: null,
			path: "/usr/bin/pi",
		});
		expect(next.phase).toBe("installed");
		expect(next.detail).toBe("installed at /usr/bin/pi");
	});

	it("moves verifying to unverified naming the blocker", () => {
		const next = advance(job({ phase: "verifying" }), {
			type: "unverified",
			path: null,
		});
		expect(next.phase).toBe("unverified");
		expect(next.detail).toMatch(/not on PATH/);
		expect(next.error).toMatch(/not on PATH/);
	});

	it("cancels a live job from any live phase", () => {
		for (const phase of ["queued", "installing", "verifying"] as const) {
			const next = advance(job({ phase }), { type: "cancelled" });
			expect(next.phase).toBe("cancelled");
		}
	});

	it("ignores an event that does not belong to the current phase", () => {
		const queued = job();
		expect(advance(queued, { type: "npm_ok" })).toBe(queued);
		const verifying = job({ phase: "verifying" });
		expect(advance(verifying, { type: "start" })).toBe(verifying);
	});

	it("is total: a terminal job is unchanged by any later event", () => {
		for (const phase of TERMINAL) {
			const done = job({
				phase,
				detail: "done",
				endedAt: 5,
				error: phase === "failed" ? "boom" : null,
			});
			for (const event of EVERY_EVENT) {
				expect(advance(done, event)).toBe(done);
			}
		}
	});

	it("never mutates the input job", () => {
		const original = job({ phase: "installing" });
		const snapshot = { ...original };
		advance(original, { type: "output", line: "changed" });
		expect(original).toEqual(snapshot);
	});
});
