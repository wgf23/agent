GOAL: Add a machine-readable output mode to headless runs: `my-agent run --output-format json "..."` writes one JSON object per agent event plus a final summary to stdout, for scripting and CI.

WORKTREE: /tmp/opencode/wt/json-output (branch feat/json-output).

SCOPE (write): src/cli/run.ts, src/index.ts, README.md, CHANGELOG.md, test/cli/run.test.ts (new or extend an existing cli test).
SCOPE (read only): src/agent/events.ts, src/providers/types.ts, test/helpers/mock-provider.ts, test/cli/*.

CONTEXT:
- `runHeadless` streams AgentEvents through `options.onEvent`. Today it writes human text to stdout and `[tool]`/`[usage]`/`[done]` lines to stderr.
- Define the line shape in an exported pure function so it is unit-testable: each AgentEvent becomes one JSON line carrying its `type` and payload; a final `{"type":"summary","reason":...,"steps":...,"usage":{...}}` line ends the stream.
- Add `--output-format <text|json>` (default `text`) to the `run` subcommand and the root command. Text mode must stay byte-identical to today.
- In json mode, suppress the human stdout text and the `[tool]`/`[reasoning]`/`[usage]`/`[done]` stderr lines, and keep the existing `[session]` behavior only if it does not corrupt stdout. Fatal config errors may still go to stderr. Exit codes are unchanged.

ACCEPTANCE:
- `--output-format json` writes only valid JSON lines to stdout: one per event, then a summary line. Nothing non-JSON on stdout.
- Text mode output is unchanged (assert exact stdout for a stub run).
- Tests drive RunHeadlessOptions.provider (the injected seam), capture stdout/stderr, and assert parsed JSON with literal expected values, plus the unchanged text path.
- README documents the flag; CHANGELOG Unreleased > Added.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
