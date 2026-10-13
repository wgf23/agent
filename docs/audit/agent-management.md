# Agent management: detect installed agent CLIs and one-click install

Run: 2026-10-13. Base `97476b9` on the worktree `/tmp/opencode/wt/agents`, branch
`feat/agent-management`. Method: figure-it-out, arena design bakeoff, one owner per unit, each unit
verified against the real artifact before the next. The arena record (two candidate designs,
cross-judge scores, graft list) is `docs/audit/agent-management-arena.md`.

## Done predicate

- `my-agent agents` lists every catalog agent with installed/missing, version, resolved path, and
  whether a rob backend can drive it.
- `my-agent agents install <id>` installs a missing agent through a global npm install, streams
  progress, then re-probes the binary as the source of truth.
- The web panel lists the same and installs on click; the create-bot backend picker no longer
  dead-ends on a missing command.
- Install over HTTP is loopback-only, never uses `sudo`, and never pipes a remote script to a shell.

## Owner decisions (one-way doors)

- Surfaces are CLI plus Web UI. The TUI is out of scope.
- The catalog in `shared/agents.ts` is the single source of truth. The rob command set, the config
  validator, the create-bot picker, the CLI table, and the panel all derive from it.
- Install is npm-global only, loopback-only over HTTP, with an explicit `confirm: true`.

## Unit plan

| # | Unit | Status |
| --- | --- | --- |
| 1 | The catalog as the single source of truth; every command list derived | LANDED a9771f2 |
| 2 | Core: resolve, probe, install job reducer, npm runner, supervisor | LANDED 437163e |
| 3 | Surfaces: CLI group, HTTP routes plus SSE, web panel, create-bot affordance | LANDED 895ca25, 67dcb7a |
| 4 | Probe fixes found in verification: stderr version, npm global bin fallback | LANDED f79dc5f |

## Trail

| at | unit | decision / result | evidence |
| --- | --- | --- | --- |
| 2026-10-13 | design | Arena over two designs; base is Candidate 1 (catalog + supervisor + job lifecycle reducer). Cross-judge agreed 29 to 24. Grafted a global install lock, a version TTL cache with `allSettled`, and the command echo before install. | `docs/audit/agent-management-arena.md` |
| 2026-10-13 | unit 1 | Catalog landed; the four command lists collapsed to one. No user-visible message changed. | commit a9771f2; 802 tests green; drift grep empty; validator message byte-equal to the generated one |
| 2026-10-13 | unit 2 | Core landed: `resolveCommand`, probe, `advance` job reducer, streaming npm runner, `AgentSupervisor`. | commit 437163e; 845 tests green; exact npm argv asserted against a fake npm |
| 2026-10-13 | unit 3 | CLI `agents` group, `/api/agents` routes plus SSE, web panel, create-bot affordance. | commits 895ca25, 67dcb7a; 856 tests green; tsup and Vite builds green |
| 2026-10-13 | verify | Real CLI on this machine lists pi/openode/claude/codex with versions and gemini missing. | `pnpm exec tsx src/index.ts agents` |
| 2026-10-13 | defect | `pi --version` prints to stderr, so the stdout-only probe lost it; and `npmGlobalBinDir` was dead code, so `onPath` could never be false. | `pi --version 2>&1 1>/dev/null` -> `0.73.0`; grep for `npmGlobalBinDir` found only its definition |
| 2026-10-13 | unit 4 | Fixed both: stderr fallback for the version line, and a PATH-first resolve that falls back to the npm global bin dir. | commit f79dc5f; 858 tests green; `pi` row now shows `0.73.0` |
| 2026-10-13 | verify | Installed a missing agent for real through the CLI: streamed npm, saw the mise reshim, then `installed codex-cli 0.162.1 at <path>`. Re-listing detects it. | `my-agent agents install codex --yes`; `my-agent agents` |
| 2026-10-13 | verify | Real HTTP server: `GET /api/agents` returns the real detection; unknown id 400; missing confirm 428; installing an already-installed id 202 with a terminal job and no npm run. | `/tmp/opencode/serve-check.sh` output |

## Verdicts

- **VERIFIED.** Catalog single source of truth; CLI list; real global install of `codex` end to end;
  detection reflecting it; the HTTP surface including the idempotent path; 858 tests, typecheck,
  lint, tsup bundle, Vite bundle.
- **NOT VERIFIED.** The web panel and the create-bot affordance are verified only at the reducer,
  build, and API level. No browser or Playwright/Puppeteer exists in this environment, so the
  rendered UI was never driven. Anyone with a browser should click through `my-agent serve` before
  treating the panel as proven.
- **NOT VERIFIED.** The non-loopback 403 and the two-agents-at-once global lock are covered by tests
  with injected doubles, not live.

## Machine side effect

`@openai/codex` 0.162.1 was installed globally to prove the install path. It is reversible with
`npm uninstall -g @openai/codex`, which returns the machine to five catalog rows with `gemini` and
`codex` missing.
