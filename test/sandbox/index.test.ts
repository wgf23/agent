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
import { windowsHelperPath } from "../../src/sandbox/windows.js";

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
			env: { LL_WRITABLE: `/ws:${tmpdir()}`, LL_NETWORK: "1" },
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

	it("runs unsandboxed when mode is off even with a windows backend", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "C:/ws",
			settings: settings({ mode: "off" }),
			plan: { backend: "windows", pwsh: "C:/pwsh.exe" },
		});

		expect(plan).toEqual({
			run: true,
			argv: ["/bin/sh", "-c", "printf hi"],
			env: {},
		});
	});

	it("routes auto through the windows helper and warns about what is not isolated", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "C:/ws",
			settings: settings(),
			plan: { backend: "windows", pwsh: "C:/pwsh.exe" },
		});

		expect(plan).toEqual({
			run: true,
			argv: [
				"C:/pwsh.exe",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				windowsHelperPath(),
				"-Command",
				"printf hi",
				"-Cwd",
				"C:/ws",
			],
			env: {},
			warning:
				"Windows sandbox only manages the process lifecycle; the filesystem and network are not isolated",
		});
	});

	it("refuses in require mode because windows does not isolate filesystem or network", () => {
		const plan = planSandboxedBash({
			command: "printf hi",
			workspaceRoot: "C:/ws",
			settings: settings({ mode: "require" }),
			plan: { backend: "windows", pwsh: "C:/pwsh.exe" },
		});

		expect(plan).toEqual({
			run: false,
			reason:
				'Sandboxing is required (sandbox.mode = "require") but the Windows backend only manages the process lifecycle, not filesystem or network isolation. Set sandbox.mode to "auto" or "off".',
		});
	});
});
