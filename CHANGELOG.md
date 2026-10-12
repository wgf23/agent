# Changelog

## Unreleased

### Added

- `my-agent sessions fork <id>` copies a saved session into a new one with a fresh id, carrying over its messages and model, and prints the new id. `--at <n>` truncates the fork to the first `n` messages. An unknown id prints a clear error and exits non-zero.
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

### Changed

- Rob `opencode` backends now run isolated under `~/.config/my-agent/opencode/<name>/` and receive the configured provider key as its environment variable, so rob sessions stay out of your own opencode data and a key stored with `my-agent setup` authenticates the child without exporting anything.
- An `opencode` action is exposed as a blanket `allow` only when its rules cannot resolve any subject to something else: a scalar `allow`, or a list of catch-all `allow` entries. A pattern-specific, `deny`, or `ask` entry gates the action as `ask` instead, closing a bypass where `[{ "pattern": "rm *", "action": "deny" }, { "pattern": "*", "action": "allow" }]` was translated to an unconditional allow. `write_file` and `edit_file` share opencode's `edit` action and merge most-restrictively.

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
