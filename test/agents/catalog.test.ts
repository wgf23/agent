import { describe, expect, it } from "vitest";
import {
	AGENT_IDS,
	AGENTS,
	agentByCommand,
	agentById,
	missingCommandMessage,
	ROB_COMMANDS,
	unsupportedCommandMessage,
} from "../../shared/agents.js";

describe("agent catalog", () => {
	it("lists the rob-capable commands in the documented order", () => {
		expect(ROB_COMMANDS).toEqual(["pi", "opencode", "claude"]);
	});

	it("keeps every agent id unique", () => {
		expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length);
		expect(AGENT_IDS.length).toBe(AGENTS.length);
	});

	it("looks an agent up by id and by command", () => {
		for (const row of AGENTS) {
			expect(row.command).toBe(row.id);
			expect(agentById(row.id)).toBe(row);
			expect(agentByCommand(row.command)).toBe(row);
		}
	});

	it("marks codex as recognized but not rob-capable", () => {
		expect(agentByCommand("codex")?.rob).toBe(false);
		expect(agentById("codex")?.robBlockedReason).toBe("no rob backend yet");
		expect(agentByCommand("nope")).toBeUndefined();
		expect(agentById("nope")).toBeUndefined();
	});

	it("generates the unsupported-command message from the catalog", () => {
		expect(unsupportedCommandMessage("codex")).toBe(
			'Unsupported CLI command "codex". Only "pi", "opencode", and "claude" are supported.',
		);
	});

	it("generates the missing-command message from the command", () => {
		expect(missingCommandMessage("codex")).toBe(
			'Cannot use the "codex" backend: the command is not on PATH. Install it first, or choose the built-in backend.',
		);
	});
});
