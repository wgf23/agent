GOAL: Add `my-agent init` to draft an `AGENTS.md` for the current workspace from a scan plus one model call.

WORKTREE: /tmp/opencode/wt/init (branch feat/init-agents-md).

SCOPE (write): src/cli/init.ts (new), src/index.ts, README.md, CHANGELOG.md, test/cli/init.test.ts (new).
SCOPE (read only): src/cli/run.ts, src/config/resolve.ts, src/providers/openai-compatible.ts, src/providers/types.ts, test/helpers/mock-provider.ts, src/agent/system-prompt.ts.

CONTEXT:
- Read `package.json` (name, scripts, deps) and `README.md` if present, and a shallow top-level file listing, then make ONE provider call asking the model to write a concise `AGENTS.md`. Collect `text_delta` events and concatenate.
- Build the provider the same way `runHeadless` does (resolveConfig + createOpenAICompatibleProvider). Add an injectable provider seam so tests never hit the network (mirror `RunHeadlessOptions.provider`).
- Write the result to `<workspace>/AGENTS.md`. If it already exists and `--force` is not passed, print a clear message and exit non-zero without calling the model. A missing API key prints the existing `missingApiKeyMessage` and exits non-zero.
- Print the path written on success.

ACCEPTANCE:
- With a stub provider, `init` writes `AGENTS.md` containing the stub's text and prints the path.
- An existing `AGENTS.md` without `--force` is refused (non-zero) and the file is unchanged; `--force` overwrites.
- A missing key exits non-zero with the friendly message and makes no provider call.
- Tests use the injected provider seam and a temp workspace; assert literal file contents.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
