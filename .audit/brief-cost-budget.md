GOAL: Track and show dollar cost per run and enforce a `--max-cost <usd>` budget that stops a run when exceeded.

WORKTREE: /tmp/opencode/wt/cost-budget (branch feat/cost-budget).

SCOPE (write): src/agent/cost.ts (new), src/config/resolve.ts, src/index.ts, src/cli/run.ts, src/agent/agent.ts, src/tui/, README.md, CHANGELOG.md, test/agent/cost.test.ts (new).
SCOPE (read only): src/agent/events.ts, src/providers/presets.ts, test/helpers/mock-provider.ts.

CONTEXT:
- Pricing is per model, in USD per million tokens, with separate input, output, and cache-read rates. Use the DeepSeek defaults the README already states: `deepseek-flash` input 0.15, output 0.6, cache-read 0.003; `deepseek-v4-pro` input 0.66, output 1.98, cache-read 0.022. A pure `estimateCost(usage, model)` returns a number, and unknown models return 0.
- `UsageTotals` lives in src/agent/agent.ts. Add the computed cost to the final usage reporting and to the `done`/`usage` flow without breaking existing event shapes (add fields; do not rename).
- `--max-cost <usd>` on the `run` subcommand and root command. When the accumulated cost exceeds the cap, stop the loop with a new done reason `"budget"` (extend `AgentDoneReason` and `exitCodeForReason`, budget exits non-zero). Default: no cap.
- Show the running cost in the TUI status row and in the headless stderr `[usage]` line.

ACCEPTANCE:
- `estimateCost` is a pure function with literal-asserted cases: known models, cache hits, unknown model => 0.
- `--max-cost 0.0001` stops a run that would otherwise continue, and the done reason is `budget`.
- Headless stderr includes a dollar cost; the TUI status row shows it.
- Without `--max-cost`, behavior is unchanged except for the added cost line.
- Tests: unit cases for estimateCost; one headless test with the mock provider proving the budget stop and the reason.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
