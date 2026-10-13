# Changelog

## Unreleased

### Added

- `web_fetch` tool. The agent can retrieve an `http` or `https` URL during a turn. `markdown` and `text` return readable text with HTML tags stripped, and `html` returns the raw body. A non-2xx status, a bad URL, a network error, a timeout, or an abort returns an error. The tool asks for permission by default.
- `web_search` tool. The agent can query a configured search provider (brave, tavily, or searxng) and get a numbered list of titled result snippets. It reads a top-level `search` block (`provider`, `apiKeyEnv`, `baseURL`) from `my-agent.json` or the global config, defaults to brave, and returns an error naming the missing setting when the provider is unconfigured. The tool asks for permission by default.
- Dollar cost tracking and a run budget. The headless `[usage]` line and the TUI status row now report the accumulated cost in USD, computed from per-model input, output, and cache-read rates (`deepseek-flash` and `deepseek-v4-pro` have prices; unknown models cost 0). `--max-cost <usd>` on the root command and the `run` subcommand stops a run with a `budget` done reason once the cost exceeds the cap, and exits non-zero. No cap by default.
- `task` tool for the solo agent. It delegates one self-contained sub-task to a fresh sub-agent and returns only its final text, capped at 4000 characters. The sub-agent inherits the parent's provider, model, workspace, permissions, and thinking, and receives the standard tools without `task`, so it cannot recurse (hard depth cap of 1). A rejected sub-agent run becomes a tool error instead of throwing. Available in headless runs, the TUI, and the web UI, and it defaults to `ask`.
- `my-agent sessions fork <id>` copies a saved session into a new one with a fresh id, carrying over its messages and model, and prints the new id. `--at <n>` truncates the fork to the first `n` messages. An unknown id prints a clear error and exits non-zero.
- Token auth for non-loopback web binds. `my-agent serve` on a host other than `127.0.0.1`, `::1`, or `localhost` generates a random token at startup, requires it on every `/api/*` request (a `?token=` query parameter or an `Authorization: Bearer` header), answers a missing or wrong token with `401`, and prints the startup URL with the token appended. Loopback binds are unchanged and need no token.
- Local web UI. `my-agent serve` starts a loopback HTTP server and a browser client that streams answers, renders Markdown and tool cards, folds reasoning, and shows the same permission dialog and allow-all switch as the TUI. `Stop` cancels the running turn with `Rob.abortTurn`/`Team.interrupt` and keeps the session alive, a message sent mid-turn is queued and injected at the next step, and the default assistant is a persistent session chat. The rob area is separate: create a rob from the sidebar or the Bot 广场, it is appended to `my-agent.json` and starts running, and the panel shows per-rob status, DMs, and notices. `assistant` is reserved for the workspace chat.
- Keyless web start and an in-app Settings dialog. `my-agent serve` starts and serves the UI with no API key configured anywhere, and the Settings dialog sets the provider preset, model, an optional custom base URL and key environment, and the API key. The key goes to the existing `credentials.json` (`0600`) and the rest to `config.json`, and the provider is rebuilt in place so the next turn uses it with no restart. The key is never sent back to the browser, never written to `config.json`, and never logged, and `POST /api/settings` is refused when the server is bound to a non-loopback host.
- Model Context Protocol (MCP) servers over stdio. A top-level `mcp.servers` map in `my-agent.json` or the global config starts each server, exposes its tools as `mcp__<server>__<tool>`, and asks before running one by default. A failing server prints `mcp <server>: <error>` and never stops the others. Servers run as your user and are not sandboxed, and only stdio is supported.
- Native team robs receive the configured MCP tools. One connection set serves the whole team run and is disposed when the team stops. An `mcp__...` call from a rob goes through that rob's authorizer, so it asks by default and shows in the approval dialog with the rob's name. A `cli` rob (`pi` or `opencode`) runs its own tool registry and uses its own MCP configuration instead, and a `delegate` sub-agent does not receive MCP tools.
- Persistent `opencode` CLI backend for robs: a private long-lived `opencode serve` process with one session per rob, mid-turn `steer` interjections, and SIGTERM teardown on stop. Configure with `{ "kind": "cli", "command": "opencode", "provider": "deepseek", "model": "deepseek-v4-flash" }`.
- OS-level sandboxing for the `bash` tool, configured by a top-level `sandbox` block (`mode`, `network`, `writablePaths`). The backend is chosen in priority order: bubblewrap (`bwrap`), then Landlock through `python3`, then none. `auto` warns and runs unsandboxed when no backend exists, `require` refuses, and `off` disables the sandbox. The sandbox denies TCP by default and limits writes to the workspace, the temp directory, and `writablePaths`. Only the `bash` tool is sandboxed.
- `opencode` robs now expose `ask`-level tools and answer each opencode `permission.asked` request through the rob's authorizer and the shared FIFO approval queue, so the dialog shows the rob's name and `allow once` / `allow always` / `deny` behave like every other rob. A pending request is rejected on turn abort or dispose so opencode never blocks on a stopped server.
- Interactive `my-agent setup` wizard and first-run TUI setup that stores an API key in `~/.config/my-agent/credentials.json`, with environment variables taking precedence.
- Runtime allow-all mode in the TUI: `/allow-all` (or `Ctrl+A`) toggles a run-wide switch that grants every permission request, `/allow-all on` and `/allow-all off` set it explicitly, an `allow-all` marker appears in the status row while it is on, and each dangerous call it approves prints one `allow-all: auto-approved dangerous <tool> <subject>` line to the transcript. Deny rules still win, nothing persists to `my-agent.json`, one switch covers every rob, and `--yes` is unchanged.
- Session persistence. The TUI and headless runs save the transcript after every turn under `~/.local/share/my-agent/sessions/<project>/`, and `--continue` (newest) or `--session <id>` resumes one. `my-agent sessions list` prints them and `/clear` ends the current session to start a new one.
- Context compaction. `/compact` summarizes the older messages into a `[compacted summary]` and keeps the recent ones; automatic compaction runs before a turn when the context estimate exceeds `compaction.thresholdTokens` (default 100000) with `compaction.auto` on. The summary is a persisted `user` message, so a resumed session keeps it, and the TUI shows a `compacted summary (N chars)` line instead of the raw text.
- `@file` mentions. Typing `@` completes workspace files with an anchored accept that replaces only the token, and sending a message expands each resolvable `@path` into a bounded `Referenced files` block so the model does not need a separate read.
- Tool-lifecycle hooks. A top-level `hooks` block in `my-agent.json` runs a shell command before (`preToolUse`) or after (`postToolUse`) each tool call, matched by a tool-name glob (`*` matches all). A pre hook exiting non-zero blocks the tool with its stdout as the reason; a post hook runs after the tool and never changes the result.
- Custom slash commands. Markdown files in `<workspace>/.my-agent/commands/*.md` define a command with YAML frontmatter (`name` in kebab-case, one-line `description`) and a prompt body. Typing `/name args` sends the expanded prompt, substituting `$ARGUMENTS` (or appending the arguments when the body has none), and the suggestion menu lists custom commands after the built-ins. The built-in names are skipped and a missing directory or malformed file is ignored.
- Machine-readable headless output. `my-agent run --output-format json "..."` (and the root `my-agent --output-format json "..."`) writes one JSON object per agent event plus a final `{"type":"summary",...}` object to stdout for scripting and CI, and suppresses the human text and `[tool]`/`[reasoning]`/`[usage]`/`[done]` stderr lines. The default `text` mode is unchanged, and exit codes are the same.
- `my-agent init`. Drafts an `AGENTS.md` for the current workspace from a scan of `package.json`, `README.md`, and the top-level file listing, then one model call whose `text_delta` events are concatenated and written to `<workspace>/AGENTS.md`. It prints the path on success, refuses to overwrite an existing file unless `--force` is passed, and reports the existing missing-key message without calling the model when no API key is configured.

### Changed

- Rob `opencode` backends now run isolated under `~/.config/my-agent/opencode/<name>/` and receive the configured provider key as its environment variable, so rob sessions stay out of your own opencode data and a key stored with `my-agent setup` authenticates the child without exporting anything.
- An `opencode` action is exposed as a blanket `allow` only when its rules cannot resolve any subject to something else: a scalar `allow`, or a list of catch-all `allow` entries. A pattern-specific, `deny`, or `ask` entry gates the action as `ask` instead, closing a bypass where `[{ "pattern": "rm *", "action": "deny" }, { "pattern": "*", "action": "allow" }]` was translated to an unconditional allow. `write_file` and `edit_file` share opencode's `edit` action and merge most-restrictively.
- Tool-lifecycle hooks now fire on rob and team turns, not only the solo paths. A native rob applies the project hooks to its own tool calls and to the sub-agents it starts through `delegate`; a `cli` rob runs its own external registry and keeps its own hooks.

### Fixed

- A `cli` rob now receives the resolved provider key in its environment, so `pi` authenticates from a key stored with `my-agent setup` or the web Settings dialog instead of reporting "No API key found".
- A `cli` rob whose command is not on `PATH` is rejected at creation, and an already-saved one reports an actionable "command not found on PATH" message instead of the raw `spawn <cmd> ENOENT`.

## 0.1.0 - 2026-10-11

### Added

- Provider layer for OpenAI-compatible APIs, with DeepSeek as the default preset and configurable `baseURL`, thinking, and reasoning effort.
- Six tools: `read_file`, `write_file`, `edit_file`, `bash`, `glob`, and `grep`, with workspace path safety and output truncation.
- Agent loop that streams text and reasoning, runs read-only tools in parallel, retries rate limits and server errors, trims context by size, and honors cancellation.
- Headless run (`my-agent run "..."`) with streaming output and exit codes.
- TUI with streaming messages, tool cards, diffs for file edits, a reasoning fold, an input history, and a status bar.
- Permission rules with interactive approval and persistence to the project file, including dangerous-command detection.
- Config precedence across CLI flags, environment variables, the project file, the global file, and built-in defaults.
- Friendly errors for a missing key, an unknown model, network failures, and rate limits.
- Packaging to `dist/index.js` with a `my-agent` bin entry.

### Known limits

- `bash` is not sandboxed.
- Context is trimmed by size, not summarized.
- The TUI has no sessions.
- Windows and macOS are not verified by hand.
