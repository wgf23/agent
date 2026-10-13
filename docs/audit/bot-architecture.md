# Bot-as-persistent-entity: plan and decision trail

Run: 2026-10-13. Base `97476b9` on the worktree `/tmp/opencode/wt/bot-arch`, branch
`feat/bot-architecture`. Method: figure-it-out, arena design bakeoff, one owner per unit,
each unit verified against the real artifact before the next.

The arena record (two candidate designs, cross-judge scores, graft list) is
`.audit/arena-synthesis.md` in this worktree.

## Done predicate

Falsifiable on this box, with a real `node` process, real HTTP, and real disk:

1. Create a bot session, tell the bot a fact, destroy the session, restart the process, create a new
   session, ask the fact back, and the bot answers it.
2. Kill the process and restart. The bot's ledger bytes are intact and its memory is unchanged.
3. With no `POST /api/send`, an interval trigger wakes a bot and it emits a turn attributed in the
   transcript.
4. In the browser, switch the active workspace. The session list and the bot list swap to the new
   workspace, and switching back restores the first one.

## Owner decisions (one-way doors, answered up front)

- **Bot identity and memory are global across workspaces.** The ledger is keyed by name alone at
  `<dataRoot>/bots/<name>.json` (`MY_AGENT_BOTS_DIR` override), not under a project slug.
- **Trigger surface is interval only.** `wakeRule` is `{kind:"manual"} | {kind:"interval", everyMs}`.
  Cron is deferred; it would be one more pure `nextFire` rule.
- **Sessions stay ephemeral.** A session is an in-memory label with no writer, no path, and no
  schema. A bot's per-session history is reconstructed from the ledger's turns, filtered by session
  id, so persistence stays single-writer and the bot/session invariant stays a property of the layout.

## Consequence of global memory

Memory is global, but a transcript must never mix workspaces. Every turn records its
`workspaceRoot`, and `replay(turns, workspaceRoot, sessionId?)` filters by workspace first, then by
session. So a bot carries one memory across codebases while its replayed context stays scoped to the
codebase it is working in.

## Unit plan (riskiest unknown first, scaffold and verification before features)

| # | Unit | Status |
| --- | --- | --- |
| 1 | Durable bot ledger: `writeJsonAtomic`, exported `messageSchema`, `bot/schema.ts`, `bot/record.ts` pure folds, `bot/store.ts` | LANDED 317f268 |
| 2 | Wire the ledger into `Rob`: read memory each turn, commit in `finally`, native `remember`/`forget` tools | planned |
| 3 | Session channels: in-memory `ChannelRegistry`, open/close routes, history projected from turns | planned |
| 4 | Wake seam: injected `Clock`/`Timer`, interval rule, `[wake:interval]` attribution | planned |
| 5 | Retire the fake bot: delete `BotKind`/`BotInfo.kind`, `newChat`/`openChat`, sessions as a top-level list | planned |
| 6 | Workspace selection: `openWorkspace` scope, `WorkspaceHub`, `workspaces.json`, `--workspace` | planned |
| 7 | Web UI: sidebar split, workspace picker, memory view | planned |
| 8 | Docs, README, CHANGELOG, end-to-end drive against the predicate | planned |

Shared files (`shared/protocol.ts`, `web/src/state.ts`, `src/serve/*`) are written by one unit at a
time; only the docs unit can run in parallel.

## Trail

| at | unit | decision / result | evidence |
| --- | --- | --- | --- |
| 2026-10-13 | frame | Parked the in-flight agent-management feature (no commits on `feat/agent-management`); its two arena designs stay in `/tmp/opencode/arena-agents/`. | `git worktree list` |
| 2026-10-13 | design | Arena over two structurally distinct designs; base is Candidate 2 (bot ledger, session label, workspace swap). Cross-judge agreed. | `.audit/arena-synthesis.md` |
| 2026-10-13 | unit 1 | Landed the ledger: one atomic file per bot holding memory and turns, pure folds, global `bots/<name>.json`. | commit 317f268; 817 tests green, typecheck+lint green |
| 2026-10-13 | unit 1 verify | Driven against a real temp dir, not only tests: file bytes match, mode 0600, a fresh store instance reloads the memory, and replay for another workspace returns `[]`. | `pnpm exec tsx /tmp/opencode/verify-ledger.mts` -> `mode=600`, `memory=fact: the user's name is X`, `betaReplay=[]` |
