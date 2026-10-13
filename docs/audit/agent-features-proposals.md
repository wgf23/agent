# Gate proposals: the items this run did not implement

Each entry names the smallest first step and the unblocking condition. Nothing here is started.

## Blocked on resources (cannot verify on this machine)

- **npm publish.** Unblock: an npm token. Then `pnpm build && npm publish --access <x>`. Also flip
  `"private": true` to false and set the real `repository`/`license`. Irreversible, so it pauses
  for the owner.
- **web_search tool.** DONE this run as a config-driven tool (brave / tavily / searxng). Set a
  top-level `search` block. Live query unverified here, since this machine has no search key and
  no general internet; tests stub the network.
- **claude CLI rob backend.** DONE this run. Install `@anthropic-ai/claude-code` (done, 2.1.296),
  probe it, then run a rob with `{ "kind": "cli", "command": "claude" }`. Real spawn and args are
  proven; a successful real turn needs Anthropic credentials, which this machine lacks. Interactive
  approval is not bridged, so only `allow` tools are exposed.
- **codex / kimi CLI rob backends.** Binaries absent, so their non-interactive output
  cannot be probed. Repeat the `docs/design/pi-capabilities.md` method per tool: confirm non-
  interactive mode, event shape, permission channel, session resume. Only then write a backend.
- **macOS / Windows sandbox.** No host to test. macOS: seatbelt (`sandbox-exec`) profile that
  read-only-binds the FS and denies network, mirroring the bubblewrap plan. Windows: a Job Object
  with a restricted token, or accept "no sandbox, warn" (current behavior).

## LSP diagnostics (landed, v1)

Implemented on `feat/lsp` and merged. A top-level `lsp` block:

```json
{ "lsp": { "servers": { "typescript": { "command": ["typescript-language-server", "--stdio"], "extensions": [".ts", ".tsx"] } } } }
```

starts that server lazily on the first matching file and exposes a read-only `diagnostics` tool
returning `<path>:<line>:<col> <severity> <message>`. Verified against the real
`typescript-language-server`, which surfaced a real bug the fake server hid: it publishes nothing
unless the client advertises `workspaceFolders` and the `textDocument.publishDiagnostics`
capability, and it rejects a language id of `ts` (it needs `typescript`). All three are fixed and
locked by tests. Not yet done: auto-run diagnostics after edits, and LSP for rob/team.

## Multi-week design programs still open

- **image / multimodal input.** Data shape first: change `UserMessage.content` from `string` to
  `(TextPart | ImagePart)[]`, add an `ImagePart { type:"image"; mediaType; dataBase64 }`, teach the
  provider to emit OpenAI image parts, and add paste/drop in the TUI and web composer. DeepSeek's
  vision model (`deepseek-v4-flash-vision-exp`) is the target. Largest risk is provider/gateway
  support; prototype one screenshot round-trip before the UI work.
- **Semantic code index.** Embed file chunks into a local store, add a `semantic_search` tool.
  Needs an embedding provider decision (local vs API). Prototype on a mid-size repo and measure
  whether it beats grep before building it.
- **Plugin system.** Define a plugin contract (a module exporting tools, hooks, providers, and
  commands), a loader from config, and a trust/permission story. Hooks + custom commands + MCP
  already cover most of the extension surface, so scope the plugin API to what those cannot do.
- **native Anthropic adapter.** A second provider implementing the same `Provider` interface with
  Anthropic message/tool blocks and SSE. The interface is already provider-neutral, so this is
  additive. Prototype the tool-call round trip first.
- **MCP HTTP / SSE transport.** Extend `mcp.servers` entries with `url` + `transport: "http"` and
  reuse the tool mapping. stdio is done; this is a transport branch in the manager.

## Smaller follow-ups

Landed in this run (see the branch `feat/agent-capabilities`): **web auth token** on non-loopback
binds, **`sessions fork <id> [--at n]`**, and **`my-agent init`** to draft `AGENTS.md`. The trail
rows 11-15 record them. The rest below are still open.

- **rob session persistence.** Persist rob history through `session/store.ts` keyed by rob name;
  web-client.md already lists the in-memory limit.
- **checkpoint / rewind.** Snapshot edited files to a session-scoped dir before each write; add
  `/rewind`. Git already covers the worst case, so this is convenience.
- **diff preview before apply.** In the approval dialog, render the pending diff and add a
  "show diff" step for `write_file`/`edit_file`.
- **jsdom component tests** for the web client.
