# Gate proposals: the items this run did not implement

Each entry names the smallest first step and the unblocking condition. Nothing here is started.

## Blocked on resources (cannot verify on this machine)

- **npm publish.** Unblock: an npm token. Then `pnpm build && npm publish --access <x>`. Also flip
  `"private": true` to false and set the real `repository`/`license`. Irreversible, so it pauses
  for the owner.
- **web_search tool.** Needs a search backend + key. First step: pick one (Brave / Tavily / Exa),
  add `provider.searchApiKeyEnv` to config, then implement like web_fetch (same truncation,
  permission `ask`, stubbed-fetch tests).
- **claude / codex / kimi CLI rob backends.** Binaries absent, so their non-interactive output
  cannot be probed. Repeat the `docs/design/pi-capabilities.md` method per tool: confirm non-
  interactive mode, event shape, permission channel, session resume. Only then write a backend.
- **macOS / Windows sandbox.** No host to test. macOS: seatbelt (`sandbox-exec`) profile that
  read-only-binds the FS and denies network, mirroring the bubblewrap plan. Windows: a Job Object
  with a restricted token, or accept "no sandbox, warn" (current behavior).

## Multi-week design programs

- **image / multimodal input.** Data shape first: change `UserMessage.content` from `string` to
  `(TextPart | ImagePart)[]`, add an `ImagePart { type:"image"; mediaType; dataBase64 }`, teach the
  provider to emit OpenAI image parts, and add paste/drop in the TUI and web composer. DeepSeek's
  vision model (`deepseek-v4-flash-vision-exp`) is the target. Largest risk is provider/gateway
  support; prototype one screenshot round-trip before the UI work.
- **LSP diagnostics.** Add an `lsp` config block, one client per language server, and a `diagnostics`
  tool (or a post-edit hook) that returns file diagnostics. Start with a single server (tsserver)
  and one tool returning `file:line: message`. Hooks (shipped this run) are the natural attach point.
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
