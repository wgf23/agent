# my-agent

A terminal coding agent powered by DeepSeek (OpenAI-compatible API). It streams answers, reads and edits files, runs commands, and asks for permission before anything risky. TypeScript, Node 20+.

## Install

Not published yet. Build and link it locally:

```bash
pnpm install
pnpm build
npm link
```

This puts `my-agent` on your PATH. Undo it with `npm unlink -g my-agent`.

## Quick start

```bash
my-agent setup      # store an API key in ~/.config/my-agent/credentials.json
my-agent            # interactive TUI
```

`my-agent setup` runs on its own, and the TUI starts it automatically the first time you open it without a key. If you would rather not store a key, set `DEEPSEEK_API_KEY` and skip setup.

## Modes

- `my-agent` opens the TUI.
- `my-agent run "list the ts files and summarize package.json"` runs headlessly and streams the answer to stdout.
- `my-agent "..."` does the same as `run`.
- `--yes` auto-approves every tool call. Without it, headless mode denies any tool that needs approval and keeps going.
- `-m, --model <spec>` picks a model, for example `deepseek/deepseek-v4-pro` or `openai/gpt-4o`.
- `--max-steps <n>` caps the agent loop.
- `--continue` resumes the newest saved session for this workspace. `--session <id>` picks a specific one. Sessions are saved after every turn under `~/.local/share/my-agent/sessions/`, and `my-agent sessions list` prints them for the current workspace.
- `my-agent --version` prints the version.
- `my-agent config` prints the resolved provider, model, baseURL, maxSteps, and where each value came from. It never prints the key; it prints `set (env)`, `set (credentials)`, or `missing`.
- `my-agent setup` stores an API key and writes the provider, model, and endpoint to the global config file.

## TUI

Slash commands: `/help`, `/clear`, `/compact`, `/model`, `/allow-all`, `/quit`.

Keys:

- `Enter` submits.
- `Ctrl+J` inserts a newline (multiline input).
- `Ctrl+A` toggles allow-all.
- `Esc` cancels the running turn.
- `Ctrl+C` quits.
- `Ctrl+O` toggles tool output.
- `Ctrl+T` toggles the reasoning fold.
- `Up`/`Down` walk the input history (single-line input only).

`/allow-all` toggles a run-wide switch that answers every permission request with allow once, so the model never stops for the dialog; `/allow-all on` and `/allow-all off` set it explicitly, and `Ctrl+A` toggles it. The status row shows an `allow-all` marker while it is on, and a dangerous call it approves prints one line, `allow-all: auto-approved dangerous <tool> <subject>`, to the transcript. Deny rules still win, nothing is written to `my-agent.json`, and the switch is per-run. It dies with the process and never persists. In team mode one switch covers every rob. `--yes` behavior is unchanged.

Typing `@` completes workspace file names, and accepting one inserts it into the sentence. Sending the message expands each `@path` into a `Referenced files` block so the model sees the contents without reading the file again.

`/compact` summarizes the older messages into a `[compacted summary]` and keeps the recent ones. Automatic compaction runs before a turn when the context estimate exceeds `compaction.thresholdTokens` (default 100000) and `compaction.auto` is true. The summary is saved with the session, so `--continue` keeps it. `/clear` ends the current session and starts a new one, and the `· session <id>` line tells you which session you are in.

## Configuration

Precedence, highest first: command-line flags, environment variables, the project file `<workspace>/my-agent.json`, the global file `~/.config/my-agent/config.json`, built-in defaults.

Environment variables supply a key and one model override. A key can also come from the credentials file (see below):

- `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` (or the variable named by `apiKeyEnv`). An environment variable wins over a stored key.
- `MY_AGENT_MODEL` overrides the model.
- `MY_AGENT_DEBUG` adds a raw SDK error line to provider failures.

Project file `<workspace>/my-agent.json`:

```json
{
  "provider": {
    "preset": "deepseek",
    "model": "deepseek-flash",
    "thinking": "enabled",
    "reasoningEffort": "high",
    "baseURL": "https://api.deepseek.com",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "maxSteps": 25
  },
  "permissions": {
    "bash": [
      { "pattern": "git status*", "action": "allow" },
      { "pattern": "rm *", "action": "deny" }
    ],
    "write_file": "ask"
  }
}
```

Global file `~/.config/my-agent/config.json` accepts the `provider` block only. It cannot set `permissions`; permission rules come only from the project file:

```json
{
  "provider": {
    "preset": "openai",
    "apiKeyEnv": "OPENAI_API_KEY",
    "thinking": "disabled"
  }
}
```

Keys are not allowed in either file. A file with an `apiKey` field is rejected; use `my-agent setup` to store the key instead. `thinking` and `reasoningEffort` are DeepSeek options; they are only sent when the `deepseek` preset is active.

### Credentials

`my-agent setup` (and the TUI's first run without a key) stores keys in `~/.config/my-agent/credentials.json`:

```json
{
  "keys": {
    "DEEPSEEK_API_KEY": "sk-..."
  }
}
```

The directory is created `0700` and the file `0600`. The key is looked up by the resolved `apiKeyEnv` name. Resolution order for the key: the environment variable first, then the credentials file. A corrupt file is an error and names the file rather than silently ignoring it. The key value is never printed.

## Permissions

Each tool maps to an action: `allow`, `ask`, or `deny`. A tool can also take an ordered list of `{ "pattern", "action" }` rules; the first matching pattern wins. `*` is a wildcard, so `git status*` matches `git status` and `git status --short`.

Defaults: `read_file`, `glob`, and `grep` are allowed; `write_file`, `edit_file`, and `bash` ask.

In the TUI, the dialog offers `y` allow once, `a` allow always, and `n` deny. Allow always appends a rule to `<workspace>/my-agent.json`. Dangerous commands (`rm -rf`, `sudo`, `curl ... | sh`, force push, and similar) are flagged and cannot be remembered as a standing rule.

## Sandbox

`bash` can run inside an OS sandbox. The resolved settings live in the same two files as the rest of the config:

```json
{
  "sandbox": {
    "mode": "auto",
    "network": false,
    "writablePaths": ["/some/extra/dir"]
  }
}
```

- `mode` is `"auto"` (default), `"require"`, or `"off"`. `auto` uses the best backend and warns on stderr and in the tool output when none exists. `require` refuses to run the command when no backend exists and tells you to install bubblewrap or switch mode. `off` runs the command with no sandbox at all.
- `network` defaults to `false`; the sandbox denies TCP (and, under bubblewrap, the whole network namespace).
- `writablePaths` defaults to `[]`. The workspace root and the system temp directory are always writable; add other absolute paths here.

The project file overrides the global file field by field, and both override the built-in defaults. The global file accepts a `sandbox` block.

Backend priority:

1. **bubblewrap** (`bwrap`) when the binary is on `PATH`. It read-only binds `/`, binds the workspace root and each writable path over it, mounts a fresh `/tmp`, `/dev`, and `/proc`, drops the network namespace unless `network` is true, and runs `/bin/sh -c <command>` with `--chdir` at the workspace root.
2. **Landlock** (Linux 5.13+) when `python3` is on `PATH` and its Landlock ABI probe succeeds. A helper script installs a ruleset that allows read and exec everywhere, write only in the writable roots, and denies TCP unless `network` is true. The helper is written once per process to `<tmp>/my-agent-sandbox-<uid>/landlock_helper.py` (directory `0700`, file `0600`).
3. **none** when neither is available. `auto` runs unsandboxed with a warning; `require` refuses.

The backend is detected once per process.

### Sandbox limits

- Landlock mediates file access and TCP only. UDP and every other protocol are not covered; bubblewrap covers the whole network namespace.
- Only the `bash` tool is sandboxed. `read_file`, `write_file`, and `edit_file` are not.
- `opencode` and `pi` rob backends run their own agent and are not sandboxed by this layer.
- macOS and Windows fall back to no sandbox until a seatbelt backend exists.

## AGENTS.md

If `<project root>/AGENTS.md` exists, its contents are added to the system prompt. It is read from the project root only.

## Skills

A skill is an npm package that ships a directory containing `SKILL.md`. The file starts with YAML frontmatter holding `name` (lowercase kebab-case) and a one-line `description`; the rest is markdown instructions for the model. The package points at the directory with a top-level `my-agent-skill` field:

```json
{
  "name": "my-greeting-skill",
  "version": "1.0.0",
  "my-agent-skill": "."
}
```

Installed skills are listed in the system prompt under `## Skills`, and the model loads one on demand with the read-only `load_skill` tool.

```bash
my-agent skill add <spec>   # install from npm or a local directory
my-agent skill list         # one row per skill: name, package, version, description, path
my-agent skill remove <name>
```

Skills install into `~/.config/my-agent/skills`, which acts as an npm project (my-agent creates its `package.json`). Set `MY_AGENT_SKILLS_DIR` to use a different prefix; tests and sandboxes point it at a temp directory. npm runs with `--ignore-scripts --no-audit --no-fund`. A package that does not declare a valid skill is uninstalled again.

## Robs

A `my-agent.json` can define a team of robs. Each rob runs its own agent with its own role, permissions, and history. In the TUI, `@name <task>` dispatches work, and `@name <text>` sent while the rob is busy interjects mid-turn.

```json
{
  "robs": [
    { "name": "planner", "role": "coordinate the others" },
    {
      "name": "reviewer",
      "role": "review code",
      "backend": {
        "kind": "cli",
        "command": "opencode",
        "provider": "deepseek",
        "model": "deepseek-v4-flash"
      },
      "permissions": { "read_file": "allow", "bash": "allow" }
    }
  ]
}
```

A rob is `native` by default. A `cli` rob hands each turn to an external agent program:

- `command: "pi"` runs pi; `provider` and `model` are required. It keeps one pi session per rob under `.my-agent/pi-sessions/<name>` and bridges approvals through a pi extension.
- `command: "opencode"` runs a private, long-lived `opencode serve` process with one persistent session per rob, on its own random local port and password. Its data and state live under `~/.config/my-agent/opencode/<name>/` (via `XDG_DATA_HOME` and `XDG_STATE_HOME`), so rob sessions never appear in your own opencode session list and never contend with your own server for the SQLite database. `provider` and `model` are optional; set both to pin an opencode model that exists in your own opencode setup. The configured provider key (the `apiKeyEnv` value) is forwarded to the child as its environment variable, so a key stored with `my-agent setup` works without exporting anything. Every turn reuses the same session, so the rob remembers earlier messages. Messages that arrive while a turn is running are delivered as `steer` prompts, so an interjection redirects the running turn instead of waiting for the next one. A tool that resolves to `ask` is exposed as an opencode `ask` rule, and every opencode permission request is answered through the rob's own authorizer and the shared approval queue, so you approve it in the same dialog as the rest of the team.

`send_message` and `delegate` are native-only. Listing either in a `cli` rob's `permissions` is a config error.

## Known limits

- `bash` is sandboxed on Linux when a backend is available (see Sandbox). Without bubblewrap or a Landlock-capable `python3`, and on macOS and Windows, it falls back to no sandbox and warns; that is why it asks first.
- `bash` runs through the system shell. On Windows that is `cmd.exe`, so POSIX commands (`ls`, `grep`, `printf`, and similar) will not work there.
- Context compaction summarizes the older messages with one extra model call when the estimate exceeds the threshold. Reasoning blocks are not part of the estimate because the provider drops them from outbound requests.
- Sessions are saved so `--continue` resumes them. The compaction summary is a `user` message tagged `[compacted summary]`; it persists, but the model must keep the facts it needs in that summary.
- Robs that use a `cli` backend (`pi` or `opencode`) cannot send private messages (`send_message`) or start sub-agents (`delegate`). Listing either tool in their `permissions` is a config error. Both `cli` backends route `ask`-level tools through the rob's authorizer and the shared approval queue. The `pi` backend relies on its approval extension loading: if the extension loads without registering its `tool_call` hook those tools run unapproved, and a failed load stops the run. An `opencode` permission request carries only opencode's action and resource, so a request that cannot be mapped back to one of the six tools is rejected, and for the shared `edit` action the bridge authorizes as `write_file` or `edit_file`, whichever the rob's rules resolve to ask.
- CLI backends are `pi` and `opencode`. `claude`, `codex`, and `kimi` are not implemented.

## Development

```bash
pnpm dev            # run from source
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
