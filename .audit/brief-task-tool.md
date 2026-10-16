GOAL: Add a `task` tool so the solo agent can delegate one self-contained sub-task to a fresh sub-agent and get only its final text back.

WORKTREE: /tmp/opencode/wt/task-tool (branch feat/task-tool).

SCOPE (write): src/tools/task.ts (new), src/permissions/rules.ts, src/cli/run.ts, src/tui/index.tsx, src/serve/solo.ts, README.md, CHANGELOG.md, test/tools/task.test.ts (new).
SCOPE (read only): src/rob/tools.ts, src/rob/rob.ts, src/agent/agent.ts, src/agent/events.ts, src/providers/types.ts, test/helpers/mock-provider.ts, test/tools/*.test.ts, src/cli/run.ts.

CONTEXT:
- Mirror src/rob/tools.ts `createDelegateTool({ from, depth, run })`: a pure factory that takes an injected runner, so the tool is unit-testable and the entry points own the real call.
- Suggested API: `createTaskTool({ run, depth }: { run: (task: string, signal?: AbortSignal) => Promise<string>; depth: number })`.
- The sub-agent inherits the parent provider, model, workspaceRoot, authorize, and thinking, and gets the standard tools EXCEPT `task` (no recursion; hard cap depth 1). Wire the runner in cli/run.ts, tui/index.tsx, and serve/solo.ts by calling `runAgent` with the same settings and no `task` tool.
- Sub-agent events do not stream to the user's transcript; only the final text returns. Cap the returned text at 4000 chars.
- runAgent signature is in src/agent/agent.ts. The final assistant text is the last assistant message's text blocks joined.

ACCEPTANCE:
- `createTaskTool` returns a Tool named `task`, readOnly false, `.strict()` schema `{ task: string }`.
- Calls the injected run(task, signal) and returns ok:true with the (capped) text; a rejected runner becomes ok:false describing the error, never throws.
- Depth guard: constructed at depth >= 1 returns ok:false without calling run.
- `task` defaults to ask in src/permissions/rules.ts.
- Wired into the headless run, TUI, and solo serve so the model can call it.
- Tests: fake runner success, runner error, depth guard, all with literal assertions. One integration test using the mock provider proves a `task` call yields a tool result containing the sub-agent text and that the sub-agent receives no `task` tool.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no rob behavior change, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
