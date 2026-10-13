import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SANDBOX,
	planSandboxedBash,
	type SandboxSettings,
} from "../../src/sandbox/index.js";
import {
	ensureHelperFile,
	helperFilePath,
} from "../../src/sandbox/landlock.js";

function settings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
	return { ...DEFAULT_SANDBOX, ...overrides };
}

const nonePlan = { backend: "none", reason: "nothing available" } as const;

describe("planSandboxedBash", () => {
	it("runs the command unchanged when mode is off", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "/ws",
			settings: settings({ mode: "off" }),
			plan: { backend: "landlock", python: "/usr/bin/python3" },
		});

		expect(plan).toEqual({
			run: true,
			argv: ["/bin/sh", "-c", "printf hi"],
			env: {},
		});
	});

	it("runs unsandboxed with a warning when auto has no backend", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "/ws",
			settings: settings({ mode: "auto" }),
			plan: nonePlan,
		});

		expect(plan).toEqual({
			run: true,
			argv: ["/bin/sh", "-c", "printf hi"],
			env: {},
			warning: "sandbox unavailable: nothing available; running unsandboxed",
		});
	});

	it("denies with the literal reason when require has no backend", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "/ws",
			settings: settings({ mode: "require" }),
			plan: nonePlan,
		});

		expect(plan).toEqual({
			run: false,
			reason:
				'Sandboxing is required (sandbox.mode = "require") but no sandbox backend is available. Install bubblewrap, or set sandbox.mode to "auto" or "off".',
		});
	});

	it("routes the workspace and temp dir into the landlock writable env", async () => {
		await ensureHelperFile();

		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "/ws",
			settings: settings(),
			plan: { backend: "landlock", python: "/usr/bin/python3" },
		});

		expect(plan).toEqual({
			run: true,
			argv: [
				"/usr/bin/python3",
				helperFilePath(),
				"/bin/sh",
				"-c",
				"printf hi",
			],
			env: { LL_WRITABLE: `/ws:${tmpdir()}` },
		});
	});

	it("passes the network flag through to the backend", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "/ws",
			settings: settings({ network: true }),
			plan: { backend: "bwrap" },
		});

		if (!plan.run) throw new Error("expected a runnable plan");
		expect(plan.argv).not.toContain("--unshare-net");
	});
});
