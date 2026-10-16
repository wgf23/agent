import { describe, expect, it } from "vitest";
import type { AgentStatusView } from "../../shared/protocol.js";
import { formatAgentTable } from "../../src/cli/agents.js";

function status(overrides: Partial<AgentStatusView>): AgentStatusView {
	return {
		id: "pi",
		label: "pi",
		command: "pi",
		npmPackage: "@mariozechner/pi-coding-agent",
		installed: true,
		onPath: true,
		path: "/usr/local/bin/pi",
		version: "0.73.0",
		error: null,
		robBackend: true,
		needsProviderAndModel: true,
		robBlockedReason: "",
		testedVersion: "0.73.0",
		job: null,
		...overrides,
	};
}

const pi = status({});
const codex = status({
	id: "codex",
	label: "Codex",
	command: "codex",
	npmPackage: "@openai/codex",
	installed: false,
	onPath: false,
	path: null,
	version: null,
	robBackend: false,
	needsProviderAndModel: false,
	robBlockedReason: "no rob backend yet",
	testedVersion: "0.162.1",
});

describe("formatAgentTable", () => {
	it("renders a header row and one padded row per agent", () => {
		expect(formatAgentTable([pi, codex])).toBe(
			"id     label  npm                            status     version  path\n" +
				"pi     pi     @mariozechner/pi-coding-agent  installed  0.73.0   /usr/local/bin/pi\n" +
				"codex  Codex  @openai/codex                  missing\n",
		);
	});

	it("reports an empty catalog instead of an empty table", () => {
		expect(formatAgentTable([])).toBe("No agents recognized.\n");
	});
});
