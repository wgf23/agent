import { describe, expect, it } from "vitest";
import { type DetectProbes, detectBackends } from "../../src/sandbox/detect.js";

function probes(overrides: Partial<DetectProbes> = {}): DetectProbes {
	return {
		bwrap: async () => false,
		python: async () => null,
		landlockAbi: async () => null,
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

	it("caches per probe object so a probe runs once", async () => {
		let calls = 0;
		const shared = probes({
			bwrap: async () => {
				calls += 1;
				return true;
			},
		});

		await detectBackends(shared);
		await detectBackends(shared);

		expect(calls).toBe(1);
	});
});
