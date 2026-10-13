# Web bot surface: plan and decision trail

Run: 2026-10-13. Base `0058473` on the worktree `/tmp/opencode/wt/web-ux`, branch
`feat/web-ux`, stacked on `feat/bot-architecture` so PR 5 stays exactly as reviewed.
Method: one owner per unit, each unit verified against the real artifact before the next,
and the committed `scripts/bot-e2e.ts` is the reproducible drive.

The plan is one unit per file group over the server surface, the client data layer, and the
panels, then a final unit that drives all four new surfaces on a real server and writes this
trail. Shared files (`shared/protocol.ts`, `src/serve/*`, `web/src/*`) are written by one unit
at a time.

## Done predicate

Falsifiable on this box, with a real `node` process, real HTTP, real disk, and real DeepSeek
turns, by `pnpm bot:e2e` (nine phases):

1. `GET /api/bots/:bot/transcript` returns the bot's session id, its messages replayed from the
   ledger (including the ask a prior phase sent), and its session summaries.
2. `GET /api/bots/:bot/memory` lists a `kind: "fact"` entry; `POST /api/bots/:bot/memory/forget
   {id}` removes it from the API and from the ledger's memory on disk.
3. `POST /api/bots/:bot/wake {everyMs, prompt}` writes the new schedule to
   `<workspace>/my-agent.json` and re-arms the live timer, proven by a turn committed *after* the
   call that carries the new `[wake:interval]` prompt.
4. Creating a bot session emits `bot_sessions` for that bot and never a chat `sessions` event,
   even while the interval timer runs: the defect fix that a bot's list replaced the chat's.

## Owner decisions (one-way doors, answered up front)

- **A bot's session list gets its own event.** `{ type: "bot_sessions"; bot; sessions;
  currentSessionId }`; the existing `{ type: "sessions" }` stays chat-only. This is the defect
  fix: `TeamHub.emitSessions` previously emitted the chat's event with the bot's list, and the
  client replaced the chat's list with it.
- **The transcript is fetched on demand.** It is not bundled into `hello`, so a large bot roster
  does not inflate every snapshot. One read returns both the current transcript and the bot's
  session summaries, so the sidebar needs no second request.
- **Memory is editable outside a turn.** `store.saveMemory` applies a memory-only delta through
  the same atomic writer; no fake turn is synthesized.
- **The wake schedule stays config-owned.** Setting it writes `<workspace>/my-agent.json` and
  re-arms the live timer; it is never copied into the ledger.
- **An unanswered approval expires and is denied**, so a proactive wake cannot hang a turn
  forever (default 300 s; unit-tested with an injected scheduler).

## Unit plan

| # | Unit | Status |
| --- | --- | --- |
| 1 | Server surface: the `bot_sessions` event, `GET .../transcript`, `GET .../memory`, `POST .../memory/forget`, `POST .../wake`, `BotTranscriptResponse.sessions`, `store.saveMemory`, `Team.setWake`, `setRobWake`, approval timeout | LANDED d3d5791 |
| 2 | Client data layer: per-bot `botSessions`/`botActiveSession`/`memory`, the `auth_error` action, token-aware api calls, `selectBot`/`forgetMemory`/`setWake`/`closeBotSession` | LANDED 18c9f4a |
| 3 | Panels: the bot session list (create/open/close), the memory panel with delete, the wake tab, the auth banner naming `?token=` | LANDED 03bd557 |
| 4 | E2E phases 6–9, the README/CHANGELOG, and this audit trail | LANDED (this commit) |

## Trail

The full decision trail is `docs/audit/web-ux-trail.tsv` (also `.audit/web-ux.tsv`), one row per
unit plus a final `done` row, in the same `ts · phase · decision · why · evidence · result` shape
as `docs/audit/bot-architecture-trail.tsv`.

| at | unit | decision / result | evidence |
| --- | --- | --- | --- |
| 2026-10-13 | unit 1 | Bot surface on the server: `bot_sessions`, the four routes, a memory-only write, a live wake re-arm, and an approval timeout. | commit d3d5791; `test/serve/bot-routes-http.test.ts`, `test/serve/team.test.ts` |
| 2026-10-13 | unit 2 | Per-bot client data layer keyed by name, so a bot's list cannot touch the chat's, and a 401 becomes `authError`. | commit 18c9f4a; `test/web/state.test.ts`, `test/web/api.test.ts` |
| 2026-10-13 | unit 3 | The panels: bot session list, memory delete, wake tab, and the auth banner. | commit 03bd557; vite build green; rendered UI unverified |
| 2026-10-13 | unit 4 | `scripts/bot-e2e.ts` drove the four surfaces on the real server; phase 9 was shown to fail under the old `sessions` emit, then reverted; README/CHANGELOG/audit written. | this commit; `pnpm bot:e2e` nine PASS |

## Verdicts

Proven on the real artifact (a real `node` server, real HTTP, real disk, real DeepSeek turns) by
`pnpm bot:e2e`, which exits 0 with nine `PASS` lines:

1. **Transcript reloads from the ledger.** After phase 5's workspace switch disposed the scope and
   with it the in-memory channel, phase 6 lists the bot's sessions, re-opens the session id that
   recorded the phase-3 ask, and the route replays that session from the ledger. The replayed
   messages contain the ask (case-insensitive `what is my name`) and the response carries at least
   one session summary.
2. **Memory read and delete.** Phase 7 reads a `kind: "fact"` entry whose text contains `Zed`,
   forgets it by id, re-reads the API and finds it gone, and parses the on-disk ledger to assert no
   memory entry (and no `supersedes` reference) carries the id.
3. **Wake set live.** Phase 8 posts `{everyMs: 2500, prompt: "Say the single word: tock"}`, asserts
   `<workspace>/my-agent.json` now carries that `wake` block, and waits for a turn committed after
   the call whose recorded user text is `[wake:interval] Say the single word: tock`. Only a
   re-armed live timer can produce that turn; writing the file alone would not.
4. **Collision fix.** Phase 9 opens `/api/events`, posts `/api/sessions/new {bot: "atlas"}`, asserts
   the first session event is `bot_sessions` for `atlas`, and asserts that through the next real
   interval tick no chat `sessions` event arrives. Falsified by hand: making `TeamHub.emitSessions`
   emit the chat `sessions` event again makes phase 9 fail; reverting it makes the run green again.

## Known limits and what stays unverified

Named rather than assumed:

- **The rendered browser UI was never driven.** There is no browser in this environment. The
  panels are covered by the reducer and api tests and by the Vite build, but the pixels, the tab
  switching, and the click-through were not exercised. The server side of each route, driven over
  real HTTP, is what the e2e proves.
- **The on-disk memory check is a memory check, not a raw-bytes check.** The `remember` tool
  records `Remembered as <id>.` in the turn's tool output, so the phase-1 memory id can never
  vanish from the ledger's `turns`; what phase 7 proves is that the id is gone from `memory` (both
  as an entry and as a `supersedes` target). A raw `not.toContain` is only possible when no turn
  recorded the id, as in the unit test's seeded case.
- **Phase 6 re-opens the ask's session first.** The workspace switch in phase 5 replaces the
  in-memory session label, so the session that is current when phase 6 starts is a fresh one. The
  route returns whichever session is current when it is called; the test makes the ledger session
  current with `POST /api/sessions/open` and then reads it. That is itself part of the reload
  story, not a workaround for a route bug.
- **Memory is global by design.** A fact one workspace teaches a bot reaches that bot in every
  other workspace; the delete path was verified, the global reach was not re-driven here.
- **The approval timeout is unit-tested, not driven live.** No phase leaves an approval
  unanswered against the real server; the timeout is covered by `test/rob/approvals.test.ts` with
  an injected scheduler.
- **External-CLI backends were not driven at all**, and the interval wake remains the only
  trigger. Both are unchanged from the bot-architecture run.
