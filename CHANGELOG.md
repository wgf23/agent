# Changelog

## Unreleased

### Added

- Persistent `opencode` CLI backend for robs: a private long-lived `opencode serve` process with one session per rob, mid-turn `steer` interjections, and SIGTERM teardown on stop. Configure with `{ "kind": "cli", "command": "opencode", "provider": "deepseek", "model": "deepseek-v4-flash" }`.
- Interactive `my-agent setup` wizard and first-run TUI setup that stores an API key in `~/.config/my-agent/credentials.json`, with environment variables taking precedence.

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
