import { describe, expect, it } from "vitest";
import { bwrapArgv } from "../../src/sandbox/bwrap.js";

const base = {
	command: "printf hi",
	workspaceRoot: "/workspace",
	writableRoots: ["/workspace", "/tmp", "/data"],
};

describe("bwrapArgv", () => {
	it("builds the read-only root argv with network denied", () => {
		expect(bwrapArgv({ ...base, network: false })).toEqual({
			argv: [
				"bwrap",
				"--ro-bind",
				"/",
				"/",
				"--dev",
				"/dev",
				"--proc",
				"/proc",
				"--tmpfs",
				"/tmp",
				"--bind",
				"/workspace",
				"/workspace",
				"--bind",
				"/tmp",
				"/tmp",
				"--bind",
				"/data",
				"/data",
				"--die-with-parent",
				"--unshare-net",
				"--chdir",
				"/workspace",
				"/bin/sh",
				"-c",
				"printf hi",
			],
			env: {},
		});
	});

	it("drops --unshare-net when network is allowed", () => {
		expect(bwrapArgv({ ...base, network: true }).argv).toEqual([
			"bwrap",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
			"--bind",
			"/workspace",
			"/workspace",
			"--bind",
			"/tmp",
			"/tmp",
			"--bind",
			"/data",
			"/data",
			"--die-with-parent",
			"--chdir",
			"/workspace",
			"/bin/sh",
			"-c",
			"printf hi",
		]);
	});
});
