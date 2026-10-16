GOAL: Add LSP diagnostics support: a config `lsp` block, a long-lived manager that lazily starts language servers by file extension, and a read-only `diagnostics` tool.

WORKTREE: /tmp/opencode/wt/lsp (branch feat/lsp, based on feat/agent-capabilities which has all prior features). node_modules is a symlink; never run pnpm install.

DESIGN DECISION (already made, implement this shape): a per-run manager that mirrors the MCP manager. `startLspServers({ servers, workspaceRoot })` returns `{ tools, dispose }`; wire `lsp.tools` next to `mcp.tools` at the same call sites and dispose it with the MCP manager. Do not use a module-level singleton.

SCOPE (write): src/lsp/config.ts, src/lsp/client.ts, src/lsp/manager.ts, src/lsp/tool.ts (all new, split as you see fit), src/config/resolve.ts, src/cli/run.ts, src/tui/index.tsx, src/serve/server.ts, src/serve/solo.ts, README.md, CHANGELOG.md, test/lsp/*.test.ts (new), test/fixtures/fake-lsp.mjs (new).
SCOPE (read only): src/mcp/manager.ts, src/mcp/client.ts, src/tools/types.ts, src/config/project-file.ts, src/config/global-file.ts, test/mcp/*.

LSP PRIMER (implement this, do not add a dependency):
- stdio transport. Every message is `Content-Length: <byte length>\r\n\r\n` followed by the UTF-8 JSON body. Read frames by parsing the header block then reading exactly N bytes; accumulate a buffer and it is easy to split messages.
- Requests have an integer `id` and expect a response with the same `id`. Notifications have no `id`. `textDocument/publishDiagnostics` is a server-to-client notification.
- Lifecycle for one server: spawn `command`; send `initialize` request with `{ processId, rootUri, capabilities: {}, initializationOptions }`; on its response send the `initialized` notification; then `textDocument/didOpen` with `{ textDocument: { uri, languageId, version: 1, text } }`. The server then pushes `textDocument/publishDiagnostics` with `{ uri, diagnostics: [{ range: { start: { line, character } }, severity, message, source?, code? }] }`. An empty diagnostics array means the file is clean.
- Use a `file://` URI for the path. Read the file text from disk.
- Shutdown: send `shutdown` request, then the `exit` notification, then kill the child. Never leave a child running after `dispose()`.
- Model the server lifecycle as a small state machine (idle, starting, ready, failed) rather than scattered booleans.

CONFIG:
- Top-level `lsp` block in the project file and the global file, shaped like MCP:
  `{ "lsp": { "servers": { "typescript": { "command": ["typescript-language-server", "--stdio"], "extensions": [".ts", ".tsx"], "env": { "KEY": "v" }, "initialization": { }, "disabled": false } } } }`
- `command` is a non-empty array, `extensions` is a non-empty array, `env` and `initialization` are optional objects, `disabled` is optional. An empty or absent `servers` map means LSP is off. Project servers override global servers by name. A bad entry is a config error naming the file, matching how `mcp` is parsed in src/config/resolve.ts.

TOOL:
- `diagnostics { path: string, severity?: "error" | "warning" | "info" | "hint" }`, readOnly true, `.strict()`.
- Pick the server whose `extensions` match the file's extension (case-insensitive). Unknown extension returns `ok:false` naming the configured extensions.
- Return formatted lines `path:line:col severity message` (1-based line and column), or a clear "no diagnostics" line when the list is empty. Truncate with `truncateOutput`.
- Default the permission to `allow` in src/permissions/rules.ts (read-only, local).
- Start the matching server lazily on first use and reuse it for later calls.

ACCEPTANCE:
- Config parses valid, invalid, disabled, and absent `lsp` blocks; project overrides global by name.
- `test/fixtures/fake-lsp.mjs` speaks the framed protocol and emits diagnostics; a test does a real round-trip through the tool and asserts the literal formatted output (initialize, initialized, didOpen, publishDiagnostics).
- An unknown extension returns `ok:false` naming the extensions.
- A server that never sends diagnostics returns a clear timeout error, not a hang.
- A server that exits early returns a clear error, not a hang.
- The tool is present in the runAgent tool list when LSP is configured, and absent when it is not.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

NOTES: LSP servers run as your user and are not sandboxed (same as MCP). Auto-running diagnostics after `write_file`/`edit_file` is a follow-up, not this unit. Wiring into rob/team is a follow-up.

FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase, do not change MCP behavior.
REPORT: at most 15 lines.
