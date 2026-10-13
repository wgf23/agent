# Arena synthesis: Bot-as-persistent-entity architecture

Base taken: **Candidate 2, the Bot Ledger / Workspace Swap**
(`/tmp/opencode/arena-bot-arch/candidate-2/design.md`).

Cross-judge: `opencode/mimo-v2.6-flash-free` (the configured `claude-haiku-5-5` seat is rate-limited).
Verdict: Candidate 2 wins criteria 1, 2, 4, 7; ties 3, 5, 6. My read agrees.

## Why Candidate 2 is the base

- **Criterion 1, the bot/session invariant.** Co-locating `memory` and `turns` in one
  `bots/<slug>/<name>.json` makes "a crash cannot split the memory write from the transcript write" a
  property of the file layout, not a write-ordering discipline across two directories. Candidate 1's
  ordering rule ("memory commits *before* the transcript") is the kind of invariant that silently
  rots under a future edit.
- **Criterion 2, idiom reuse.** Candidate 2 changes `loadSession` not at all, keeps one env override
  and one `projectSlug`, and extracts `writeJsonAtomic` for both callers. Candidate 1 forks a second
  data root (`MY_AGENT_BOTS_DIR`).
- **Criterion 7, verifiability.** Candidate 2 specifies a literal-bytes test plus a real-HTTP/restart
  exercise. Candidate 1 stayed at the unit level.

## Grafts from Candidate 1

1. **Per-session bot history after restart.** Candidate 2's channels are in-memory labels, so
   "writer's past sessions" vanish at restart. Its own ledger already stores `turn.sessionId`, so a
   session's history is *reconstructable* from the ledger with no second store. Graft as a read-side
   projection over `BotRecord.turns`, keeping B2 (a channel has no write capability) intact.
   Do NOT graft Candidate 1's `bot?` field on `storedSessionSchema`; it reopens the second-store and
   crash-window surface Candidate 2 removes.
2. **Deterministic wake attribution.** Both agree on an injected clock/timer. Keep Candidate 2's
   zero-protocol-change `[wake:...]` prefix and add Candidate 1's pure `nextFire` only if cron is
   chosen; interval stays the v1 surface.

## Rejected

- **Shared mutable `WorkspaceContext` getter threaded through `HubOptions`** (both candidates
  rejected it). The captured root is a property of a lifetime, and `openWorkspace` gives it one
  disposal site for the hub, MCP, LSP, plugins, semantic index, and every rob's abort controllers.
- **One store with an `owner` field on sessions.** Deleting a bot's session would delete its memory,
  and the crash window between the two writes in one file returns.

## Dropouts

- Seat 1 on `opencode-go/claude-haiku-5-5` failed with "Go usage limit exceeded"; re-dispatched on
  `opencode/space-bunny-free`. Cross-judge seat re-dispatched on `opencode/mimo-v2.6-flash-free`.

## Open product calls (asked of the owner before the schema is frozen)

1. Is a bot's identity/memory workspace-scoped or global across workspaces?
2. Trigger surface for v1: interval only, interval + cron, or interval + cron + file watch?
