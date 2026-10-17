import { describe, expect, it } from "vitest";
import type { BackendKind } from "../../shared/protocol.js";
import { supportsBotScopedTools as runtimeSupports } from "../../src/rob/types.js";
import { supportsBotScopedTools as webSupports } from "../../web/src/botScope.js";

// The web build cannot import from src/, so the panel keeps its own copy of
// this rule. That copy is only safe if it cannot drift, and a comment cannot
// enforce that — this test can. One list, both call sites.
const backends: BackendKind[] = ["native", "cli"];

describe("bot-scoped tools predicate", () => {
	it("agrees across the runtime and the web panel for every backend", () => {
		for (const backend of backends) {
			// The runtime takes the config object; the panel gets the wire
			// string. Same rule, two shapes.
			const runtime = runtimeSupports(
				backend === "cli"
					? { kind: "cli", command: "claude" }
					: { kind: "native" },
			);
			expect(webSupports(backend), `backend=${backend}`).toBe(runtime);
		}
	});

	it("treats a bot with no backend as native", () => {
		// Absent means native (the default), so scoped tools are available.
		expect(runtimeSupports(undefined)).toBe(true);
		expect(webSupports("native")).toBe(true);
	});

	it("excludes only the cli backend", () => {
		expect(runtimeSupports({ kind: "native" })).toBe(true);
		expect(runtimeSupports({ kind: "cli", command: "claude" })).toBe(false);
		expect(webSupports("native")).toBe(true);
		expect(webSupports("cli")).toBe(false);
	});
});
