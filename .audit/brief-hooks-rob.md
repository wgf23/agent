GOAL: Make tool-lifecycle hooks fire on rob and team turns too, not only the headless/TUI/serve-solo paths.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities; nine units and the hooks wiring are already merged). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/rob/rob.ts, src/rob/backend.ts, src/rob/team.ts, src/rob/types.ts, src/serve/team.ts, src/cli/team.ts, src/tui/team/state.ts or team/App.tsx (only to pass the value), test/rob/*.ts, README.md, CHANGELOG.md.
SCOPE (read only): src/hooks/hooks.ts, src/config/resolve.ts, src/agent/agent.ts, src/serve/server.ts, test/helpers/mock-provider.ts.

CONTEXT:
- `runAgent` accepts `hooks?: HooksConfig`. The solo paths now pass `resolved.config.hooks`; the rob paths do not. `src/rob/rob.ts` (about line 236) and `src/rob/backend.ts` (about line 63) call `runAgent` with no hooks.
- Rob and Team options already carry things like `extraTools` and `permissions` (see `TeamOptions`/`RobOptions` in src/rob/types.ts and the `new Rob({...})` in src/rob/team.ts `createRob`). Add an optional `hooks?: HooksConfig` next to `extraTools`, thread it through `createRob` and the two runAgent calls.
- Pass `resolved.config.hooks` where the Team is constructed: src/serve/team.ts and src/cli/team.ts (both have the resolved config), and the TUI team path if it builds a Team.
- Do not change hook semantics.

ACCEPTANCE:
- A `TeamOptions.hooks` value reaches `runAgent` on a rob turn (both the native rob path and the backend path).
- A test proves a preToolUse hook blocks a rob's `bash` call end to end with the mock provider, asserting the block message literally, or at minimum asserts `runAgent` received the hooks value on a rob turn.
- Existing rob/team tests stay green.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.

FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase, no changing hook or agent semantics.
REPORT: at most 12 lines.
