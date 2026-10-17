import type { BackendKind } from "../../shared/protocol.js";

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
