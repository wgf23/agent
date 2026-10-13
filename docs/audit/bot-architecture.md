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
- **Trigger surface is interval only.** The design first sketched a `wakeRule` union in the ledger; it landed instead as a config-owned `wake: { everyMs, prompt }` block that re-arms from `my-agent.json` on every start, so the schedule is never persisted.
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
| 2 | Wire the ledger into `Rob`: read memory each turn, commit in `finally`, native `remember`/`forget` tools | LANDED bcd83a2 |
| 3 | Session channels: in-memory `ChannelRegistry`, open/close routes, history projected from turns | LANDED 78ef60b |
| 4 | Wake seam: injected `Clock`/`Timer`, interval rule, `[wake:interval]` attribution | LANDED a5c88dd |
| 5 | Retire the fake bot: delete `BotKind`/`BotInfo.kind`, `newChat`/`openChat`, sessions as a top-level list | LANDED 37b7c74 |
| 6 | Workspace selection: `openWorkspace` scope, `WorkspaceHub`, `workspaces.json`, `--workspace` | LANDED 37b7c74 |
| 7 | Web UI: sidebar split, workspace picker, memory view | LANDED a4b54d1 |
| 8 | Docs, README, CHANGELOG, end-to-end drive against the predicate | LANDED (this commit) |

Shared files (`shared/protocol.ts`, `web/src/state.ts`, `src/serve/*`) are written by one unit at a
time; only the docs unit can run in parallel.

## Trail

| at | unit | decision / result | evidence |
| --- | --- | --- | --- |
| 2026-10-13 | frame | Parked the in-flight agent-management feature (no commits on `feat/agent-management`); its two arena designs stay in `/tmp/opencode/arena-agents/`. | `git worktree list` |
| 2026-10-13 | design | Arena over two structurally distinct designs; base is Candidate 2 (bot ledger, session label, workspace swap). Cross-judge agreed. | `.audit/arena-synthesis.md` |
| 2026-10-13 | unit 1 | Landed the ledger: one atomic file per bot holding memory and turns, pure folds, global `bots/<name>.json`. | commit 317f268; 817 tests green, typecheck+lint green |
| 2026-10-13 | unit 1 verify | Driven against a real temp dir, not only tests: file bytes match, mode 0600, a fresh store instance reloads the memory, and replay for another workspace returns `[]`. | `pnpm exec tsx /tmp/opencode/verify-ledger.mts` -> `mode=600`, `memory=fact: the user's name is X`, `betaReplay=[]` |
| 2026-10-13 | unit 2 | Wired the ledger into `Rob`: reads memory each turn, commits in `finally` even on throw, native `remember`/`forget` tools allowed by `robToolRules`. | commit bcd83a2; `test/rob/rob.test.ts` + `memory-tools.test.ts` |
| 2026-10-13 | unit 3 | Made a bot session an ephemeral in-memory channel whose past history replays from the ledger turns; open/close routes. | commit 78ef60b; `test/serve/sessions-http.test.ts` |
| 2026-10-13 | unit 4 | Gave a bot a proactive interval wake through an injected clock and timer; the schedule is config-owned and a turn records `wake: "interval"`. | commit a5c88dd; `test/bot/wake.test.ts` asserts the literal `[wake:interval]` text |
| 2026-10-13 | unit 5 | Retired the fake bot (`BotKind`, `BotInfo.kind`, workspace-as-a-bot) and made the workspace a swappable disposable scope. | commit 37b7c74; `test/serve/workspaces-http.test.ts` |
| 2026-10-13 | unit 6 | Workspace selection: `openWorkspace` scope, `WorkspaceHub`, `workspaces.json`, `--workspace`. | commit 37b7c74; real server switch to `/tmp/ws-b` |
| 2026-10-13 | unit 7 | Web UI: the chat is a plain session list, the bot roster is separate, and a workspace picker drives the switch. | commit a4b54d1; `test/web/state.test.ts`; 928 tests, typecheck+lint+vite build green |
| 2026-10-13 | unit 8 | `scripts/bot-e2e.ts` drives the real server against the real DeepSeek API and proves the four-part predicate; README/CHANGELOG/audit updated. | this commit; `pnpm bot:e2e` -> five PASS lines; 928 tests, typecheck+lint green |

## Verdicts

Proven on the real artifact (a real `node` server, real HTTP, real disk, real DeepSeek turns):

1. **Cross-session, cross-restart continuity.** `scripts/bot-e2e.ts` tells `atlas` a fact, destroys the
   session, kills the server, starts it again, opens a new session, and asks the fact back; the bot
   answers `Zed` from the ledger's memory. This is the predicate's core.
2. **Ledger bytes intact.** The ledger is byte-identical across the restart and parses against
   `botRecordSchema`; `POST /api/sessions/new` never writes memory.
3. **Interval wake.** With no `POST /api/send`, the configured 3000 ms wake commits a turn whose
   `wake` is `"interval"`.
4. **Workspace swap.** `POST /api/workspaces { "root": <other> }` marks the new root active and the
   previous one inactive, and the server answers from the new scope.

Unverified, and named rather than assumed:

- **The rendered web UI.** The chat layout and the workspace picker are covered by
  `test/web/state.test.ts` and the Vite build, but no browser exists in this environment, so the
  pixels on screen and the click-through were not exercised. The server side of the switch above is
  what is proven.
- **Long-run memory pressure.** The e2e run is short; digest eviction under the 128-entry /
  24 000-char caps and the 24-turn ring is covered by unit tests, not by a long real run.
- **The external CLI backends.** `pi`, `opencode`, and `claude` rob backends were not driven here;
  the e2e uses the native backend only.
