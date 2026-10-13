import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DetectProbes,
	detectBackends,
	findExecutable,
} from "../../src/sandbox/detect.js";

function probes(overrides: Partial<DetectProbes> = {}): DetectProbes {
	return {
		platform: "linux",
		bwrap: async () => false,
		python: async () => null,
		landlockAbi: async () => null,
		pwsh: async () => null,
		powershell: async () => null,
		windowsHelper: async () => true,
		...overrides,
	};
}

describe("detectBackends", () => {
	it("prefers bubblewrap when the binary exists", async () => {
		const plan = await detectBackends(
			probes({
				bwrap: async () => true,
				python: async () => "/usr/bin/python3",
				landlockAbi: async () => 8,
			}),
		);

		expect(plan).toEqual({ backend: "bwrap" });
	});

	it("picks landlock when python3 reports an abi", async () => {
		const plan = await detectBackends(
			probes({
				python: async () => "/usr/bin/python3",
				landlockAbi: async () => 8,
			}),
		);

		expect(plan).toEqual({ backend: "landlock", python: "/usr/bin/python3" });
	});

	it("picks none with the literal reason when no probe passes", async () => {
		const plan = await detectBackends(probes());

		expect(plan).toEqual({
			backend: "none",
			reason: "no bubblewrap binary and no Landlock-capable python3",
		});
	});

	it("does not pick landlock when the abi probe fails", async () => {
		const plan = await detectBackends(
			probes({
				python: async () => "/usr/bin/python3",
				landlockAbi: async () => null,
			}),
		);

		expect(plan.backend).toBe("none");
	});

	it("caches per probe object so a probe runs once and returns the same plan", async () => {
		let calls = 0;
		const shared = probes({
			bwrap: async () => {
				calls += 1;
				return true;
			},
		});

		const first = await detectBackends(shared);
		const second = await detectBackends(shared);

		expect(first).toEqual({ backend: "bwrap" });
		expect(second).toEqual({ backend: "bwrap" });
		expect(calls).toBe(1);
	});

	it("picks windows on win32 when pwsh is on PATH", async () => {
		const plan = await detectBackends(
			probes({
				platform: "win32",
				pwsh: async () => "C:/Program Files/PowerShell/7/pwsh.exe",
			}),
		);

		expect(plan).toEqual({
			backend: "windows",
			pwsh: "C:/Program Files/PowerShell/7/pwsh.exe",
		});
	});

	it("falls back to powershell.exe on win32 when pwsh is absent", async () => {
		const plan = await detectBackends(
			probes({
				platform: "win32",
				powershell: async () =>
					"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
			}),
		);

		expect(plan).toEqual({
			backend: "windows",
			pwsh: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		});
	});

	it("picks none with the windows reason on win32 when no shell is on PATH", async () => {
		const plan = await detectBackends(probes({ platform: "win32" }));

		expect(plan).toEqual({
			backend: "none",
			reason: "no pwsh or powershell.exe on PATH",
		});
	});

	it("picks none on win32 when the helper cannot be written", async () => {
		const plan = await detectBackends(
			probes({
				platform: "win32",
				pwsh: async () => "C:/pwsh.exe",
				windowsHelper: async () => false,
			}),
		);

		expect(plan).toEqual({
			backend: "none",
			reason: "could not write the Windows sandbox helper",
		});
	});
});

describe("findExecutable", () => {
	it("rejects a directory and accepts a real file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "my-agent-path-"));
		try {
			const dirOnly = path.join(dir, "dironly");
			mkdirSync(path.join(dirOnly, "pwsh"), { recursive: true });
			const fileDir = path.join(dir, "filedir");
			mkdirSync(fileDir, { recursive: true });
			const pwshFile = path.join(fileDir, "pwsh");
			writeFileSync(pwshFile, "#!/bin/sh\n", { mode: 0o755 });

			expect(
				findExecutable("pwsh", `${dirOnly}${path.delimiter}${fileDir}`),
			).toBe(pwshFile);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
