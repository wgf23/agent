GOAL: Make the `hooks` config actually take effect by threading `resolved.config.hooks` into every `runAgent` call site, so a configured hook runs during a real turn.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities, which already has all units merged). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/cli/run.ts, src/serve/solo.ts, src/serve/server.ts, src/serve/runtime.ts (only if needed to pass the value), src/tui/index.tsx, src/tui/App.tsx, test/agent/hooks.test.ts (extend), README.md, CHANGELOG.md.
SCOPE (read only): src/hooks/hooks.ts, src/config/resolve.ts, src/agent/agent.ts, test/helpers/mock-provider.ts, src/serve/hub.ts.

CONTEXT:
- `runAgent` already accepts `hooks?: HooksConfig` and runs pre/post hooks; `runHook` is its default runner. `resolveConfig` already returns `resolved.config.hooks`.
- The gap: no caller passes `hooks`. `src/cli/run.ts` has `resolved.config` in scope. `src/serve/solo.ts` reads `this.options.compaction` etc., so `HubOptions` needs a `hooks` field set where the hub is constructed. `src/tui/App.tsx` receives props like `compaction` from `src/tui/index.tsx`, which has `resolved.config`.
- Do not change hook semantics in `src/hooks/hooks.ts` or `src/agent/agent.ts`.

ACCEPTANCE:
- A `my-agent.json` with `{ "hooks": { "preToolUse": [{ "match": "bash", "command": "<script exiting 1 with a message>" }] } }` actually blocks a bash tool call in a headless run: the tool result is ok:false carrying the hook's message. Assert this end to end with the injected provider seam and a temp hook script on disk.
- The same hooks value is threaded into the TUI and the serve solo hub (assert the plumbing by unit: the value reaches `runAgent`).
- `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.

FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase, no changing existing hook or agent semantics.
REPORT: at most 15 lines.
