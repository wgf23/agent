GOAL: Fix the real defects a cross-model review found in the claude backend and web_search, and tighten their tests. Do not add features.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/rob/claude-backend.ts, test/rob/claude-backend.test.ts, test/fixtures/fake-claude.mjs, src/tools/web_search.ts, test/tools/web_search.test.ts.

DEFECTS TO FIX (each needs a test that fails before the fix):

1. claude-backend stderr deadlock. The child's stderr is piped with no listener, so about 64KB of stderr fills the pipe and blocks claude forever. Add a stderr listener that consumes and captures the text. Include the captured stderr in the turn error when the turn fails. Extend the fake fixture to write a large stderr blob and prove the turn still completes.

2. claude-backend has no timeout. A stuck claude hangs the rob forever (the rob loop awaits the turn). Add a per-turn timeout (default 600000 ms, overridable via an option) that kills the child process group and returns `ok:false` with a `claude: timed out after <n>ms` message. Mirror the process-group kill in src/tools/bash.ts. Test with a fake that sleeps.

3. claude-backend resume after failure. The resume session id is stored before the turn runs, so a failed first turn makes every later turn send `--resume <uuid>` for a session claude never created. Only remember the session id when the turn returns `ok:true`. Test: a first turn that returns `is_error:true` must leave the next turn using `--session-id` (or no resume), not `--resume`.

4. claude tool allowlist drops pattern-ruled tools incorrectly. `claudeToolAllowlist` must expose a tool as an allowed tool only when its rules cannot resolve to anything but allow for any subject, the same rule `opencodePermissions` uses in src/rob/opencode-backend.ts. A scalar `"allow"` allows; a list of only `{ "pattern": "*", "action": "allow" }` allows; any specific pattern, `deny`, or `ask` entry must NOT blanket-allow that tool. Test the pattern-list case (`write_file: [{ pattern: "docs/**", action: "allow" }]` must not land in `--allowedTools`) and the scalar case.

5. claude-backend silent empty success. A clean exit with no `result` line currently returns `ok:true, text:""`. Return `ok:false` with a clear `claude ended without a result` message instead. Test it.

6. claude-backend tool set omits `web_search`. Add `web_search` to the claude tool allowlist set so the tool shipped in this branch is reachable from a claude rob. Keep `task`/`send_message`/`delegate` out (native-only).

7. web_search ignores `count`. Slice the mapped results to `count` for every provider, and pass a count/limit parameter in the searxng request where the API supports one. Test that a response with more than `count` results returns exactly `count`, and that an aborted request returns a clear `request aborted` message rather than the raw error text.

ACCEPTANCE:
- Every fix has a test that would fail against the current code and passes after.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.

FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase, no `--dangerously-skip-permissions`, do not weaken existing tests.
REPORT: at most 15 lines.
