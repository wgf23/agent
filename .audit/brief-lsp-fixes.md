GOAL: Fix the defects a cross-model review found in the LSP client and manager, and add a reproducible real-server check.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities). node_modules is a symlink; never run pnpm install. `typescript-language-server` 6.0.2 and a TypeScript 5.9 workspace at /tmp/lsp-ws are available for the real check.

SCOPE (write): src/lsp/client.ts, src/lsp/manager.ts, src/lsp/tool.ts (only if needed), test/lsp/client.test.ts, test/lsp/tool.test.ts, test/fixtures/fake-lsp.mjs, scripts/lsp-smoke.ts (new), README.md, package.json (only to add a `lsp:smoke` script), CHANGELOG.md.

Each fix needs a test that fails before it and passes after.

F1. Crashed server hangs later calls. Once a server is ready then exits, `ensureStarted()` keeps returning the old resolved `startup` promise, so the next call writes to a dead child and burns the full timeout. On exit or error, clear `startup` and set state failed so the next `ensureStarted()` restarts the server (a fresh child). Test: start, force the child to exit, call diagnostics again, assert it restarts and returns diagnostics (or fails fast with a clear error), not a timeout.

F2. Concurrent same-uri requests clobber the waiter. `requestDiagnostics` stores one waiter per uri, so a second concurrent call for the same file overwrites the first, which then times out. Support a list of waiters per uri and resolve all of them with the same diagnostics. Test with two concurrent calls for one uri.

F3. No document versioning. Every call resends `textDocument/didOpen` with version 1. Track per-uri open state and text: the first call sends `didOpen` with version 1, later calls send `textDocument/didChange` with an incremented version and a full-text change, and `dispose` sends `textDocument/didClose` for every open uri before shutdown. Test: a second call sends `didChange`, not a second `didOpen`.

F4. URI mismatch on symlinks. Build the `file://` uri from the file's real path (`fs.realpath`) so it matches the uri a server publishes for a symlinked file. Test with a symlinked workspace file.

F5. No abort. Thread `ctx.signal` into `requestDiagnostics` so an abort rejects the pending waiter and any pending request promptly with a clear "aborted" error instead of waiting out the timeout. Test: abort mid-wait and assert a fast rejection.

F6. Server-to-client requests all rejected. `workspace/configuration` is requested by some real servers and a `-32601` there can break them. Answer `workspace/configuration` with an array of `null`, one per requested item; keep `-32601` for everything else. Test.

F7. Reproducible real-server check. Add `scripts/lsp-smoke.ts` that starts the real `typescript-language-server` against a temp TypeScript workspace (create a tsconfig and a file with a type error), runs the `diagnostics` tool, and prints the result. If the binary is absent, print a clear "skipped" message and exit 0. Add an `lsp:smoke` script to package.json and document it in README under Development. This is the artifact a reviewer reruns.

Guard: in the frame reader, reject a `Content-Length` that is negative or absurdly large (say over 64 MiB) instead of buffering unboundedly.

ACCEPTANCE:
- All fixes have failing-first tests; the real smoke runs green in this environment.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

FORBIDDEN: no new runtime deps (dev-only is fine), no edits outside SCOPE, no push/rebase, do not weaken existing tests.
REPORT: at most 15 lines.
