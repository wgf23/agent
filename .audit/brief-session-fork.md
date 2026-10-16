GOAL: Let a user fork a saved session into a new one, optionally truncating to a chosen message.

WORKTREE: /tmp/opencode/wt/session-fork (branch feat/session-fork).

SCOPE (write): src/session/store.ts, src/cli/sessions.ts, src/index.ts, README.md, CHANGELOG.md, test/session/store.test.ts, test/cli/sessions.test.ts.
SCOPE (read only): src/session/chooser.ts, src/cli/run.ts.

CONTEXT:
- `src/session/store.ts` exports `newSession(workspaceRoot, model)`, `saveSession`, `loadSession`, `latestSession`, `listSessions`. `StoredSession` has { version, id, workspaceRoot, createdAt, updatedAt, model, usage, messages }, and messages exclude system messages.
- Add `forkSession(workspaceRoot, id, at?)`: load the source session, create a fresh session id via `newSession`, copy the messages (or only the first `at` when given), copy the model, save it, and return it. A missing source returns an error result shaped like `loadSession`'s.
- CLI: `my-agent sessions fork <id> [--at <n>]` prints the new session id; an unknown id prints a clear error and exits non-zero. Add `--at` as an integer option.

ACCEPTANCE:
- Forking copies messages and model, produces a new id, and leaves the source file unchanged.
- `--at 2` keeps exactly the first two messages.
- Unknown id is an error, non-zero exit.
- Tests use a temp `MY_AGENT_SESSIONS_DIR` and assert literal message counts and ids.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
