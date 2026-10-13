import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ensureHelperFile,
	helperFilePath,
	landlockArgv,
} from "../../src/sandbox/landlock.js";

describe("landlockArgv", () => {
	it("builds the helper argv and the writable env", async () => {
		await ensureHelperFile();

		expect(
			landlockArgv({
				command: "printf hi",
				python: "/usr/bin/python3",
				writableRoots: ["/ws", "/tmp"],
				network: false,
			}),
		).toEqual({
			argv: [
				"/usr/bin/python3",
				helperFilePath(),
				"/bin/sh",
				"-c",
				"printf hi",
			],
			env: { LL_WRITABLE: "/ws:/tmp" },
		});
	});

	it("adds LL_NETWORK=1 when network is allowed", async () => {
		await ensureHelperFile();

		const result = landlockArgv({
			command: "true",
			python: "/usr/bin/python3",
			writableRoots: ["/ws"],
			network: true,
		});

		expect(result.env).toEqual({ LL_WRITABLE: "/ws", LL_NETWORK: "1" });
	});

	it.skipIf(process.platform === "win32")(
		"writes the helper file mode 0600 (skipped on Windows: no Landlock)",
		async () => {
			const file = await ensureHelperFile();

			expect(statSync(file).mode & 0o777).toBe(0o600);
		},
	);
});
