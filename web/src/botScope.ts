import type {
	BackendKind,
	McpServerInfo,
	SkillInfo,
	UpdateBotBody,
} from "../../shared/protocol.js";

/**
 * The part of a save body these helpers own. The panel merges it into the
 * draft it builds for the other fields, so a scope helper can never send an
 * incomplete body on its own.
 */
export type BotScopeDraft = Pick<
	UpdateBotBody,
	"skills" | "skillsConfigured" | "mcp"
>;

/**
 * Whether a bot can be given bot-scoped tools at all: a cli backend runs its
 * own tool registry, so skill scope and per-bot MCP do not reach it. The panel
 * greys those controls out on this.
 *
 * This is the browser's copy of the runtime rule, not a second opinion: the
 * web build cannot import `src/`, so `test/rob/bot-scope-consistency.test.ts`
 * asserts the two agree for every backend kind. Change one, change both.
 */
export function supportsBotScopedTools(backend: BackendKind): boolean {
	return backend !== "cli";
}

/** What the panel should show for one bot's skill scope (design §1.2). */
export interface SkillSelection {
	// Installed names, in the order the server listed them. Unknown or
	// uninstalled names in the config are silently dropped (design §10 U2).
	selected: string[];
	// True when the config never confirmed a scope (`skillsConfigured !== true`),
	// which reads as "every installed skill" — the panel says so instead of
	// pretending each box was ticked on purpose.
	isDefault: boolean;
}

type SkillScope = { skills?: string[]; skillsConfigured?: boolean };

/**
 * The read side of the 5-row truth table (design §1.2). `undefined` and a bare
 * `[]` both mean "all installed"; only `skillsConfigured === true` makes the
 * list authoritative, so `[]` + true is the "ticked nothing" state.
 */
export function skillSelection(
	installed: readonly SkillInfo[],
	bot: SkillScope,
): SkillSelection {
	const names = installed.map((skill) => skill.name);
	if (bot.skillsConfigured !== true) {
		return { selected: names, isDefault: true };
	}
	const configured = new Set(bot.skills ?? []);
	return {
		selected: names.filter((name) => configured.has(name)),
		isDefault: false,
	};
}

/**
 * A ticked skill list as a save body. Always sends the list together with the
 * flag: the server rejects a bare flag, and a list without it would read back
 * as "all installed" (design §1.3.1). Names the server no longer lists are
 * dropped so a stale config does not resurrect them here.
 */
export function skillDraft(
	selected: readonly string[],
	installed: readonly SkillInfo[],
): BotScopeDraft {
	const wanted = new Set(selected);
	return {
		skills: installed
			.map((skill) => skill.name)
			.filter((name) => wanted.has(name)),
		skillsConfigured: true,
	};
}

/**
 * The one legal way back to "all installed": `[]` + `false` (design §1.3.1).
 * Sending `[]` + `true` would mean "ticked nothing" instead.
 */
export function skillDefaultDraft(): BotScopeDraft {
	return { skills: [], skillsConfigured: false };
}

/**
 * The read side of the MCP scope: absent means none (unlike skills), and
 * names this serve no longer defines are ignored (design §10 U6).
 */
export function mcpSelection(
	servers: readonly McpServerInfo[],
	bot: { mcp?: string[] },
): string[] {
	const configured = new Set(bot.mcp ?? []);
	return servers
		.map((server) => server.name)
		.filter((name) => configured.has(name));
}

/**
 * A ticked server list as a save body: `mcp` is a plain patch list (design
 * §1.3.1, leader ruling 6) — no flag travels with it.
 */
export function mcpDraft(
	selected: readonly string[],
	servers: readonly McpServerInfo[],
): BotScopeDraft {
	const wanted = new Set(selected);
	return {
		mcp: servers
			.map((server) => server.name)
			.filter((name) => wanted.has(name)),
	};
}
