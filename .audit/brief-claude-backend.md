GOAL: Add a `claude` CLI rob backend (Claude Code) alongside `pi` and `opencode`, so a rob can run on Claude Code with its own role, session, and allow/deny tool rules.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities; all prior units merged). node_modules is a symlink; never run pnpm install.

The real `claude` binary is installed here (2.1.296, `claude --version` works). Probe it yourself with `claude --help` if you need, but the key facts are below. There are no Anthropic credentials, so you cannot run a real turn; test with a fake process.

SCOPE (write): src/rob/claude-backend.ts (new), src/rob/types.ts, src/rob/rob.ts, test/fixtures/fake-claude.mjs (new), test/rob/claude-backend.test.ts (new), test/rob/config.test.ts (extend), README.md, CHANGELOG.md, and any other place that enumerates the `pi`/`opencode` commands (grep for `PI_CLI_COMMAND`, `OPENCODE_CLI_COMMAND`, and the strings "opencode" and "pi" under src/serve and web/ and update the allowed set there too).
SCOPE (read only): src/rob/backend.ts, src/rob/cli-backend.ts, src/rob/opencode-backend.ts, src/rob/tools.ts, test/rob/cli-backend.test.ts, test/rob/helpers.ts, test/rob/opencode-backend.test.ts.

REAL CLI FACTS (observed this session):
- Non-interactive streaming: `claude -p "<prompt>" --output-format stream-json --verbose` prints one JSON object per line, then exits.
- The first line is `{"type":"system","subtype":"init",...,"session_id":"<uuid>","model":...,"tools":[...],"permissionMode":...}`.
- Then `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":...}, {"type":"tool_use",...}],"usage":{...}},"session_id":...}` events, and `{"type":"user",...}` events carrying `tool_result` blocks.
- The last line is `{"type":"result",...,"usage":{"input_tokens":..,"output_tokens":..,"cache_read_input_tokens":..,"cache_creation_input_tokens":..},"total_cost_usd":..,"is_error":<bool>,"result":"<final text>","session_id":...}`.
- No credentials: an `assistant` event with `error":"authentication_failed"` and text "Not logged in · Please run /login", then a `result` with `is_error:true` and exit code 1.
- Relevant flags: `--append-system-prompt <text>`, `--session-id <uuid>` (first turn), `--resume <id>` (later turns), `--permission-mode <mode>`, `--allowedTools <tools...>`, `--disallowedTools <tools...>`, `--model <model>`, `--add-dir <dirs...>`, `--include-partial-messages`.

CONTEXT:
- Model the backend on the existing ones. `createOpencodeBackend` and `createCliBackend` both return a `RobBackend` with `run(turn)` and optional `dispose()`. `TurnResult` is `{ ok:true; text; usage; messages } | { ok:false; error; usage; messages }`, and `usage` is the `UsageTotals` shape (inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, reasoningTokens).
- Dispatch lives in `src/rob/rob.ts` (around line 91): it picks the opencode backend when `command === OPENCODE_CLI_COMMAND`, else the pi backend. Add the claude branch there. Add `CLAUDE_CLI_COMMAND = "claude"` to `src/rob/types.ts` and include it in `CLI_COMMANDS`. `provider`/`model` may be optional for claude like opencode; if `model` is set pass it to `--model`.
- `src/rob/types.ts` `CLI_UNSUPPORTED_TOOLS` stays send_message/delegate; claude inherits that.
- One turn maps to one `claude -p` process. Keep the session id from the first turn's `system` init (or set one yourself with `--session-id`) and pass `--resume <id>` on later turns so the rob remembers.
- Isolation: set `CLAUDE_CONFIG_DIR` to `~/.config/my-agent/claude/<rob>` (mkdir it) so rob sessions do not touch the user's own `~/.claude`. Honor an env override if one already exists in the codebase pattern.
- Permissions: expose only tools whose rob rule resolves to `allow` via `--allowedTools`. Resolve `ask`/`deny` tools to `--disallowedTools` or simply omit them. Interactive approval is NOT bridged in this version; document that limit. Never use `--dangerously-skip-permissions`.
- Errors: a missing `claude` on PATH must produce the same actionable "command not found on PATH" message the pi backend produces, not a raw ENOENT. A `result` with `is_error:true` becomes `TurnResult ok:false` with its `result` text.

ACCEPTANCE:
- `{ "kind": "cli", "command": "claude", ... }` passes config validation; any other unknown command still fails.
- The backend spawns `claude` with `--append-system-prompt <role>`, `--output-format stream-json`, `--verbose`, the allowlisted tools, and either `--session-id` (first turn) or `--resume <id>` (later turns). Assert the exact argv from a fake claude that records it (mirror `test/fixtures/fake-pi.mjs` and `FAKE_PI_ARGV_FILE`).
- Parsing maps a fake stream to `text_delta`, `tool_started`/`tool_finished`, and a `usage` event, and returns the final text plus `UsageTotals` from the `result` line.
- An `is_error:true` result returns `ok:false` carrying the message.
- A missing command reports an actionable message mentioning PATH and not ENOENT.
- `CLAUDE_CONFIG_DIR` is set to a rob-scoped directory.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase, do not use `--dangerously-skip-permissions` or `bypassPermissions`.
REPORT: at most 15 lines.
