# Program frame: close the agent feature gaps

Run: autonomous overnight, 2026-10-12. Base: repo HEAD 9464014 on `feat/web-client`.
Method: figure-it-out, parallel units in their own worktrees, each verified by its own tests.

## Done predicate

Every item on the gap list carries a verdict in this document, and the implemented units pass
`pnpm test`, `pnpm typecheck`, `pnpm lint` on the integrated branch:

- **implemented** = merged onto `feat/agent-capabilities` with its branch tests green.
- **gated** = not done this run, with the reason and the unblocking condition written below.

## Premise attacked up front

"Do all of these in one session" is not a reachable predicate. The list mixes four different
kinds of work: self-contained tool/CLI features, cross-cutting UI features, multi-week design
programs (plugin system, LSP, multimodal, native Anthropic adapter), and work blocked on
resources this machine does not have (an npm publish token, a search API key, other CLI agents,
macOS/Windows hosts). Doing all of them well is impossible in one pass; doing them fast produces
slop. This run implements the self-contained high-value features and writes a decision + design
verdict for the rest so nothing is silently dropped.

## Implemented this run (one unit per worktree)

| Unit | Worktree / branch | User-visible result |
| --- | --- | --- |
| web_fetch tool | /tmp/opencode/wt/web-fetch, feat/web-fetch | Agent can fetch a URL; asks first |
| task subagent tool | /tmp/opencode/wt/task-tool, feat/task-tool | Solo agent can delegate one sub-task |
| headless JSON output | /tmp/opencode/wt/json-output, feat/json-output | `run --output-format json` for scripts/CI |
| tool-lifecycle hooks | /tmp/opencode/wt/hooks, feat/hooks | pre/post tool-use shell hooks; pre can veto |
| cost + budget | /tmp/opencode/wt/cost-budget, feat/cost-budget | dollar cost shown; `--max-cost` stops a run |
| custom slash commands | /tmp/opencode/wt/commands, feat/commands | `/name args` from `.my-agent/commands/*.md` |

## Landed on feat/agent-capabilities (all verified)

The batch grew to nine units, all merged onto `feat/agent-capabilities` with the suite green
(650 tests) plus the hooks wiring:

| Unit | Branch | Result |
| --- | --- | --- |
| web_fetch tool | feat/web-fetch | URL fetch tool, asks first |
| task subagent tool | feat/task-tool | solo agent can delegate one sub-task |
| headless JSON output | feat/json-output | `run --output-format json` |
| tool-lifecycle hooks | feat/hooks | pre/post tool-use hooks (+ wiring) |
| cost + budget | feat/cost-budget | dollar cost + `--max-cost` stop |
| custom slash commands | feat/commands | `/name args` from `.my-agent/commands/*.md` |
| session fork | feat/session-fork | `my-agent sessions fork <id> [--at n]` |
| init AGENTS.md | feat/init-agents-md | `my-agent init` |
| web auth token | feat/web-auth-token | token on non-loopback binds |
| web_search tool | feat/agent-capabilities | search via a configurable provider (stubbed tests) |
| claude cli backend | feat/claude-backend | rob runs on Claude Code (real CLI, no live turn) |

## Gated this run

### Blocked on resources not on this machine

- **npm publish** (make the package public). Needs an npm registry token and is irreversible
  (a public release). Gate: owner runs `npm publish` after `pnpm build`.
- **codex / kimi CLI rob backends**. The binaries are not installed, so behavior cannot be
  verified (docs/design/pi-capabilities.md sets the rule: verify, never assume). Unblock:
  install each tool and repeat the pi capability probe.
- **macOS / Windows sandbox**. No such host here to test seatbelt/AppContainer. Unblock:
  a macOS runner plus a seatbelt profile, a Windows runner plus a job object.

### Implemented but not live-verified

- **web_search tool** (added this run). Config-driven with brave, tavily, and searxng mappings,
  tested against a stubbed network. This machine has no search key and no general internet, so a
  live query is unverified. Set `<provider>` under a top-level `search` block to use it.
- **claude CLI rob backend** (added this run). Installed and probed the real `claude` 2.1.296 CLI
  and drove it end to end from a rob, proving the spawn, args, and isolated `CLAUDE_CONFIG_DIR`.
  The turn stopped at the expected `authentication_failed` result because there are no Anthropic
  credentials here, so a successful real turn is unverified. Interactive approval is also not
  bridged (only `allow` tools are exposed via `--allowedTools`).

### Multi-week design programs (proposal below, not this run)

- **image / multimodal input**, **LSP diagnostics**, **semantic code index**, **plugin system**,
  **native Anthropic adapter**, **MCP HTTP/SSE transport**.

### Smaller follow-ups

- rob session persistence, web auth token for non-loopback binds, session fork/branch,
  checkpoint/rewind, diff preview before apply, `/init` to generate AGENTS.md, jsdom component
  tests. See the design proposals file for shape and effort.

## Design proposals for the programs

See `docs/design/agent-capabilities.md`.
