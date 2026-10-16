GOAL: Add configurable tool-lifecycle hooks so a user command can run before and after each tool call; a pre-tool hook can veto the call.

WORKTREE: /tmp/opencode/wt/hooks (branch feat/hooks).

SCOPE (write): src/hooks/hooks.ts (new), src/agent/agent.ts, src/config/project-file.ts, src/config/resolve.ts, README.md, CHANGELOG.md, test/hooks/hooks.test.ts (new), test/agent/* (extend).
SCOPE (read only): src/permissions/authorizer.ts, src/tools/registry.ts, src/providers/types.ts, test/helpers/mock-provider.ts.

CONTEXT:
- Config lives in the project file `my-agent.json` as a top-level `hooks` key:
  `{ "hooks": { "preToolUse": [{ "match": "bash", "command": "node scripts/check.mjs" }], "postToolUse": [{ "match": "*", "command": "..." }] } }`
- `match` is a tool-name glob (reuse `matchesPattern` from src/permissions/rules.ts; `*` matches all).
- The hook command runs through the system shell with the workspace root as cwd. It receives one JSON object on stdin: `{ "hook": "preToolUse", "tool": "<name>", "args": <args> }`. Env may include `MY_AGENT_TOOL`.
- preToolUse: exit 0 allows. Non-zero exit blocks the tool; the tool result becomes ok:false whose reason is the hook's stdout (trimmed) or a default. Run pre hooks before authorization so a denial is still reported. postToolUse: runs after the tool finishes; its output is ignored and never changes the result. A hook that cannot be spawned blocks the pre case and is ignored for the post case.
- Parse `hooks` in src/config/resolve.ts into the resolved config (project file only for now; the global file does not need to accept it). project-file.ts schema gains the typed `hooks` block.
- Thread the parsed hooks into `runAgent` through `RunAgentOptions` (used by cli/run.ts and others which pass resolved.config). Keep it optional so existing callers are unaffected.

ACCEPTANCE:
- A project `hooks.preToolUse` entry matching a tool blocks that tool when the command exits non-zero; the tool result is ok:false with the hook stdout as the reason.
- A matching exit-0 pre hook runs and the tool proceeds. A non-matching hook does not run.
- A post hook runs after the tool and cannot change the result.
- `match: "*"` matches every tool; exact names match themselves.
- Tests inject a fake hook runner or a temp script and assert literal outcomes: blocked reason, allowed, no-match, post-hook-does-not-change-result.
- README documents the `hooks` block; CHANGELOG Unreleased > Added.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
