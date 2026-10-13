import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandExists } from "../../src/util/which.js";

describe("commandExists", () => {
	it("finds an executable on the provided PATH", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "my-agent-which-"));
		const tool = path.join(dir, "faketool");
		writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });

		expect(commandExists("faketool", dir)).toBe(true);
		expect(commandExists("missing-tool", dir)).toBe(false);
		expect(commandExists(tool, dir)).toBe(true);
	});
});
