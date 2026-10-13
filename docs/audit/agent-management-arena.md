# Arena synthesis: agent management (detect + one-click install)

Base taken: **Candidate 1, "one catalog, one supervisor, two projections"**
(`/tmp/opencode/arena-agents/candidate-1/design.md`).

Cross-judge: `opencode/ling-3.1-flash-free` (the configured cross-judge seat `claude-haiku-5-5` is
rate-limited). Verdict: C1 29, C2 24, base C1. My read agrees.

## Why Candidate 1 is the base

- **Criterion 4, boundary discipline (C1 5, C2 3).** C1's install route is loopback-only, matching the
  existing credential-write rule at `src/serve/server.ts:380`, and requires `confirm: true`. A remote
  token holder cannot start a global npm install. C2 has no loopback check. C1 also refuses to shell
  out for `sudo` or a piped script and asserts that in a test.
- **Criterion 3, data model (C1 5, C2 4).** C1 models the install as a pure lifecycle reducer
  `advance(job, event)` that is total and a no-op once terminal, plus a `Presence` union that keeps
  `installed` separate from `onPath`. C2's install is "a promise with an `onProgress` callback".
- **No rollback.** C1 leaves what npm left on failure. C2 auto-runs `npm uninstall -g <pkg>` on a
  misfired re-probe, which is destructive against a shared global prefix.

## Grafts from Candidate 2

1. **A global install lock.** C1 admits per-id single-flight does not stop two *different* agents from
   running `npm install -g` at once against one prefix. Take C2's serialization: a busy install
   returns a `busy` refusal (409 on the HTTP surface), matching `SettingsService`'s `busy`.
2. **Version-probe TTL cache keyed by resolved path, plus `Promise.allSettled` in `list()`.** C1
   respawns five `--version` probes per `list()` with no cache and no isolation, so one wedged agent
   stalls the panel. Graft a short TTL and `allSettled`.
3. **Echo the exact command before install.** C2's confirmation shows the resolved npm command. Fold
   it into C1's `ApprovalGate` state and the CLI prompt.

## Correction to a machine claim

C1 argued a PATH-only resolve would report a freshly installed `codex` as missing, because
`npm prefix -g`'s `bin/` is not on `PATH`. Measured: `npm` on this box is a mise shim
(`/root/.local/share/mise/shims/npm` -> `mise`), and mise re-shims after `install -g`, so the binary
does land on `PATH`. The npm-global-bin fallback stays as defensive correctness and to keep `onPath`
honest, but it is not load-bearing here. The rationale is corrected in the code comments.

## Dropouts

Seat 1 on `opencode-go/claude-haiku-5-5` failed with "Go usage limit exceeded"; re-dispatched on
`opencode/space-bunny-free`. Cross-judge re-dispatched on `opencode/ling-3.1-flash-free`.

## Owner decisions

- Surfaces: CLI + Web UI. TUI out of scope.
- Catalog is the single source of truth; the rob command set and the create-bot picker derive from it.
- Install is npm-global only, no `sudo`, no piped remote script, loopback-only over HTTP.
