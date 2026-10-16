GOAL: Fix the real defects a cross-model review found in the semantic index and image input. No new features.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/semantic/index.ts, src/semantic/embedder.ts, src/semantic/tool.ts, src/util/gitignore.ts, src/util/image.ts, src/cli/run.ts, src/index.ts (only the `--image` collect cap), test/semantic/*, test/util/* (gitignore/image), test/cli/run.test.ts, README.md, CHANGELOG.md.
SCOPE (read only): src/util/file-lock.ts, src/config/resolve.ts, test/helpers/*.

Each fix needs a failing-first test.

SEMANTIC

F1. Dimension mismatch scored on a prefix. `cosineSimilarity` truncates to `Math.min(a.length, b.length)`, so a query vector of the wrong length silently scores a prefix. Require equal length and return an error (or throw caught into an `ok:false`) when a query vector and a chunk vector differ in length. Also fail the build when the embedder returns vectors whose length is not `dimensions`.

F2. Missing or zero vectors persisted. `embedded[index] ?? []` stores an empty vector that always scores 0 and is written to disk. Validate that the embedder returned exactly one vector per chunk and that none is empty; on a mismatch, return a clear error and do not write the index.

F3. No timeout, no abort on the embeddings call. In src/semantic/embedder.ts, the `fetch` has no timeout and ignores the turn signal. Add `AbortSignal.timeout` (default 30000 ms, overridable) combined with `ctx.signal`, and thread the signal from the tool. A hung endpoint must fail with a clear timeout or aborted message, not stall the turn.

F4. Full rewrite per query and no write lock. Only write the index when something actually changed; skip the write when no file was added, removed, or edited. Serialize writers with the existing `src/util/file-lock.ts` so two runs sharing the index do not both re-embed and clobber. When the file walk exceeds the file cap, keep the cap but print or return a clear truncation warning.

F5. Ignored and secret files can leave the machine. `src/util/gitignore.ts` honors only the root `.gitignore`, so nested ignore rules are not applied, and `semantic_search` ships file text to a third-party embeddings endpoint. Honor nested `.gitignore` files where practical, and always exclude a secret denylist regardless of gitignore (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.npmrc`, `credentials.json`, `*.kdbx`). Test that a nested-ignored file and a denylisted file are never embedded.

IMAGE

F6. Unbounded image bytes. `UserMessage.images` base64 is persisted in the session and replayed in history on every later turn, and `--image` has no count cap. Cap the number of images per message (8) and the total base64 bytes per message (say 20 MiB), in the shared helper `src/util/image.ts` and the CLI `--image` collect. Reject over-cap input with a clear message before the provider is called. Test both caps.

F7. Disk-reuse is unproven. The README claims unchanged files are reused by mtime and size, but the test only proves reuse inside one in-memory tool instance. Add a test that builds the index, then creates a second tool instance over the same index dir and workspace, and asserts the embedder is not called again for unchanged files.

OUT OF SCOPE (note as follow-ups, do not do): replaying image bytes every turn is inherent to multi-turn vision, so it stays with a cap and a doc note; magic-byte media-type sniffing; an absolute index size cap beyond the file cap.

ACCEPTANCE: every fix has a failing-first test; `pnpm test`, `pnpm typecheck`, `pnpm lint` green.
FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase, do not weaken existing tests.
REPORT: at most 15 lines.
