import { describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { readFileTool } from "../../src/tools/read_file.js";
import { writeFileTool } from "../../src/tools/write_file.js";

describe("readOnlyAuthorize", () => {
	it("allows a read-only tool", async () => {
		const decision = await readOnlyAuthorize(
			{ id: "call_1", name: "read_file", args: { path: "a.txt" } },
			readFileTool,
		);

		expect(decision).toEqual({ allowed: true });
	});

	it("blocks a write tool with the exact reason", async () => {
		const decision = await readOnlyAuthorize(
			{ id: "call_2", name: "write_file", args: { path: "a.txt" } },
			writeFileTool,
		);

		expect(decision).toEqual({
			allowed: false,
			reason:
				"Tool write_file is not authorized yet. Only read-only tools run in this mode.",
		});
	});
});
