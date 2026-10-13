// The external-agent catalog: the single source of truth for the CLI programs
// my-agent can drive and for the facts each consumer needs. This file has zero
// imports so the server (src/) and the web client (web/) can both read it and
// nothing here drags a runtime dependency into either bundle.

export interface AgentRow {
	id: string;
	command: string;
	label: string;
	npm: string;
	rob: boolean;
	// Present only while rob is false: why this agent cannot back a rob yet.
	robBlockedReason?: string;
	// pi needs an explicit provider and model; the others resolve them from the
	// user's own setup.
	needsProviderAndModel?: boolean;
	testedVersion: string;
}

// Adding a row with `rob: true` widens RobCommand below, the config validator
// (src/rob/types.ts) and the create dialog (web/src/components/NewBotDialog.tsx)
// with no other edit: every consumer derives from this table.
export const AGENTS = [
	{
		id: "pi",
		command: "pi",
		label: "pi",
		npm: "@mariozechner/pi-coding-agent",
		rob: true,
		needsProviderAndModel: true,
		testedVersion: "0.73.0",
	},
	{
		id: "opencode",
		command: "opencode",
		label: "opencode",
		npm: "opencode-ai",
		rob: true,
		needsProviderAndModel: false,
		testedVersion: "2.0.24",
	},
	{
		id: "claude",
		command: "claude",
		label: "Claude Code",
		npm: "@anthropic-ai/claude-code",
		rob: true,
		needsProviderAndModel: false,
		testedVersion: "2.1.296",
	},
	{
		id: "codex",
		command: "codex",
		label: "Codex",
		npm: "@openai/codex",
		rob: false,
		robBlockedReason: "no rob backend yet",
		testedVersion: "0.162.1",
	},
	{
		id: "gemini",
		command: "gemini",
		label: "Gemini CLI",
		npm: "@google/gemini-cli",
		rob: false,
		robBlockedReason: "no rob backend yet",
		testedVersion: "0.63.0",
	},
] as const satisfies readonly AgentRow[];

export type AgentId = (typeof AGENTS)[number]["id"];
export type AgentCommand = (typeof AGENTS)[number]["command"];

type RobAgent = Extract<(typeof AGENTS)[number], { rob: true }>;
export type RobCommand = RobAgent["command"];

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

export const ROB_COMMANDS: readonly RobCommand[] = AGENTS.filter(
	(agent): agent is RobAgent => agent.rob,
).map((agent) => agent.command);

export function agentById(id: string): AgentRow | undefined {
	return AGENTS.find((agent) => agent.id === id);
}

export function agentByCommand(command: string): AgentRow | undefined {
	return AGENTS.find((agent) => agent.command === command);
}

export function unsupportedCommandMessage(command: string): string {
	return `Unsupported CLI command "${command}". Only ${quotedList(ROB_COMMANDS)} are supported.`;
}

export function missingCommandMessage(command: string): string {
	return `Cannot use the "${command}" backend: the command is not on PATH. Install it first, or choose the built-in backend.`;
}

function quotedList(items: readonly string[]): string {
	const parts = items.map((item) => `"${item}"`);
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
