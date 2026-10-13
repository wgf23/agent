# my-agent

A terminal coding agent powered by DeepSeek (OpenAI-compatible API). It streams answers, reads and edits files, runs commands, fetches web pages, and asks for permission before anything risky. TypeScript, Node 20+.

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
- `my-agent serve` starts the local web UI in a browser (see [Web UI](#web-ui)).
- `my-agent run "list the ts files and summarize package.json"` runs headlessly and streams the answer to stdout.
- `my-agent "..."` does the same as `run`.
- `--yes` auto-approves every tool call. Without it, headless mode denies any tool that needs approval and keeps going.
- `-m, --model <spec>` picks a model, for example `deepseek/deepseek-v4-pro` or `openai/gpt-4o`.
- `--max-steps <n>` caps the agent loop.
- `--max-cost <usd>` stops a run once the accumulated dollar cost exceeds the cap, in both headless mode and the TUI. No cap by default.
- `--output-format json` writes one JSON object per agent event plus a final `summary` object to stdout for scripting and CI; the default `text` streams the answer as before.
- `--image <path>` attaches an image to the prompt, as a base64 `image_url` content part the model receives alongside your text. Repeatable. Supports `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp`, and rejects a missing file, an unsupported extension, or a file over 8 MiB before the run starts. A message is capped at 8 images and 20 MiB of base64 data, so an over-cap attachment is rejected before the provider is called.
- `--continue` resumes the newest saved session for this workspace. `--session <id>` picks a specific one. Sessions are saved after every turn under `~/.local/share/my-agent/sessions/`, and `my-agent sessions list` prints them for the current workspace.
- `my-agent sessions fork <id>` copies a saved session into a new one and prints the new id. `--at <n>` keeps only the first `n` messages of the fork.
- `my-agent --version` prints the version.
- `my-agent config` prints the resolved provider, model, baseURL, maxSteps, and where each value came from. It never prints the key; it prints `set (env)`, `set (credentials)`, or `missing`.
- `my-agent setup` stores an API key and writes the provider, model, and endpoint to the global config file.
- `my-agent init` drafts an `AGENTS.md` for the current workspace from a scan of `package.json`, `README.md`, and the top-level files, then one model call. It writes `<workspace>/AGENTS.md` and prints the path. If the file already exists it refuses unless you pass `--force`.

## TUI

Slash commands: `/help`, `/clear`, `/compact`, `/model`, `/allow-all`, `/image`, `/quit`.

Keys:

- `Enter` submits.
- `Ctrl+J` inserts a newline (multiline input).
- `Ctrl+A` toggles allow-all.
- `Esc` cancels the running turn.
- `Ctrl+C` quits.
- `Ctrl+O` toggles tool output.
- `Ctrl+T` toggles the reasoning fold.
- `Up`/`Down` walk the input history (single-line input only).

`/allow-all` toggles a run-wide switch that answers every permission request with allow once, so the model never stops for the dialog; `/allow-all on` and `/allow-all off` set it explicitly, and `Ctrl+A` toggles it. The status row shows an `allow-all` marker while it is on, a dangerous call it approves prints one line, `allow-all: auto-approved dangerous <tool> <subject>`, to the transcript, and the running dollar cost next to the token counts. Deny rules still win, nothing is written to `my-agent.json`, and the switch is per-run. It dies with the process and never persists. In team mode one switch covers every rob. `--yes` behavior is unchanged.

Typing `@` completes workspace file names, and accepting one inserts it into the sentence. Sending the message expands each `@path` into a `Referenced files` block so the model sees the contents without reading the file again.

`/compact` summarizes the older messages into a `[compacted summary]` and keeps the recent ones. Automatic compaction runs before a turn when the context estimate exceeds `compaction.thresholdTokens` (default 100000) and `compaction.auto` is true. The summary is saved with the session, so `--continue` keeps it. `/clear` ends the current session and starts a new one, and the `· session <id>` line tells you which session you are in.

## Web UI

If you would rather not use the terminal, `my-agent serve` starts a local web client and prints its URL:

```bash
my-agent serve            # http://127.0.0.1:4317
my-agent serve --open     # also open the browser
```

```bash
my-agent serve [--port <port>] [--host <host>] [--open] [-m <model>] [--max-steps <n>]
```

The server binds `127.0.0.1` by default and has no authentication. When you bind a non-loopback host (`my-agent serve --host 0.0.0.0`), it generates a random token at startup, requires it on every `/api/*` request (as a `?token=` query parameter or an `Authorization: Bearer` header), and answers a missing or wrong token with `401`. The startup line prints the URL with the token appended, so you can open the UI on another machine. Loopback binds keep their no-auth behavior. The client streams answers token by token, renders Markdown and tool cards, folds reasoning, and shows the same permission dialog (`Allow once` / `Always allow` / `Deny`) and allow-all switch as the TUI. `Stop` cancels the running turn without ending the session, and a message sent mid-turn is queued and injected at the next step.

The sidebar has two areas. The **工作区** area is the default assistant, a plain chat whose sessions are saved and listed like the TUI. The **Rob** area holds the rob roster: click `＋ 创建 Bot`, fill in a name, role, optional model, and backend, and it is written to `my-agent.json` and starts running immediately. A rob is separate from the workspace chat and never replaces it, and an existing `robs` list in `my-agent.json` shows up here too. `assistant` is reserved for the workspace and cannot be used as a rob name.

The **Bot 广场** view lists the robs with their status, and shows rob-to-rob DMs and allow-all notices. Rob transcripts are in memory only for now, and rob tools are sandboxed like the rest of the agent.

The server also starts with **no API key at all**. Open Settings (the gear in the top bar) to choose a provider preset, model, an optional custom base URL and API key environment, and the key itself. The key is saved to `~/.config/my-agent/credentials.json` (`0600`) and the non-secret settings to `config.json`, and the next turn uses the new provider immediately with no restart. Until a key is configured the composer is disabled and a send is refused with a clear message, so you can install and open the UI before you have a key.

Build both the CLI and the web client with `pnpm build`. For hot-reload development, run `pnpm dev serve` in one terminal and `pnpm web:dev` in another, then open the Vite URL (`http://localhost:5173`), which proxies `/api` to the server on 4317.

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

Global file `~/.config/my-agent/config.json` accepts the `provider`, `compaction`, `sandbox`, `search`, and `mcp` blocks. It cannot set `permissions` or `robs`; those come only from the project file:

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

### Search

`web_search` queries a web search provider and returns a numbered list of titled snippets. Configure it with a top-level `search` block in `my-agent.json` or the global config:

```json
{
  "search": {
    "provider": "brave",
    "apiKeyEnv": "BRAVE_API_KEY",
    "baseURL": "https://api.search.brave.com/res/v1/web/search"
  }
}
```

- `provider` is `"brave"` (default), `"tavily"`, or `"searxng"`.
- `apiKeyEnv` names the environment variable that holds the key. It defaults to `BRAVE_API_KEY` for brave and `TAVILY_API_KEY` for tavily. Searxng is keyless and ignores it.
- `baseURL` overrides the provider endpoint. Searxng has no built-in endpoint, so a self-hosted instance must set it.

The project file overrides the global file field by field, and both override the built-in defaults. A missing key (or a searxng without `baseURL`) returns a clear error naming the setting to add and the variable to set.

### Semantic search

`semantic_search` builds a local vector index of the workspace and answers a query by meaning. Configure it with a top-level `embeddings` block in `my-agent.json` or the global config; without it the tool is not registered:

```json
{
  "embeddings": {
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "apiKeyEnv": "OPENAI_API_KEY",
    "dimensions": 1536
  }
}
```

- `baseURL`, `model`, and `apiKeyEnv` are required; `dimensions` is optional.
- The index lives at `~/.local/share/my-agent/index/<project>/index.json`, and `MY_AGENT_INDEX_DIR` overrides that base.
- Files are chunked 40 lines with 10 lines of overlap, embedded in batches of 64 through `POST {baseURL}/embeddings`, and unchanged files are reused by mtime and size. A changed model or dimensions rebuilds the index, the index is only written when a file was actually added, removed, or edited, and writes are atomic and serialized per index. The embeddings call has a 30 s timeout and honors the turn's abort signal.
- The walk honors root and nested `.gitignore` files and always excludes a secret denylist (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.npmrc`, `credentials.json`, `*.kdbx`) before any text is embedded. When the workspace exceeds the 5000-file cap, the index keeps the first 5000 and the search output is prefixed with a truncation warning.
- Search embeds the query and returns the top `k` (default 5, max 20) chunks as `<path>:<startLine>-<endLine> (score 0.xx)` with the chunk text. The tool defaults to `ask`, and a missing key names the `apiKeyEnv` variable.

## Tools

`web_fetch` retrieves one `http` or `https` URL and returns the body. Other schemes are rejected before any request. `format` is `markdown` (the default), `text`, or `html`. `markdown` and `text` strip HTML tags to readable text. `html` returns the response body unchanged. The result is cut at 2000 lines or 50 KB, the same limits as file reads. `timeout_ms` defaults to 30000, must be at least 1, and cannot be higher than 120000. A non-2xx status, an invalid URL, a network failure, a timeout, or an abort returns an error.

`web_search` runs a query against the configured search provider and returns a numbered list of result titles, URLs, and snippets. It reads the `search` block (see Search above); a missing key or a searxng without a base URL returns an error, and the result is truncated like file reads. `count` defaults to 5 and must be between 1 and 20.

## Permissions

Each tool maps to an action: `allow`, `ask`, or `deny`. A tool can also take an ordered list of `{ "pattern", "action" }` rules; the first matching pattern wins. `*` is a wildcard, so `git status*` matches `git status` and `git status --short`.

Defaults: `read_file`, `glob`, `grep`, and `diagnostics` are allowed; `write_file`, `edit_file`, `bash`, `web_fetch`, `web_search`, `semantic_search`, and `task` ask.

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

On Windows the Linux probes are skipped. Detection looks for `pwsh` then `powershell.exe` on `PATH` and, if neither is found, reports `none`. See the Windows subsection below.

The backend is detected once per process.

### Windows

On Windows the backend is a PowerShell helper that runs the command inside a Windows Job Object. This backend has never been run on a real Windows host; it is unverified, so test it before relying on it. The helper writes itself once per process to `<tmp>/my-agent-sandbox-<uid>/windows-helper.ps1` and is intended to:

- Create a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so every process in the tree is killed when the job handle closes.
- Cap the job at 64 active processes.
- Write the command to a temporary `.cmd` file and run it through `cmd.exe` from the workspace root via `pwsh` (or `powershell.exe`), exiting with the command's code and killing the job if the command does not exit within a bounded timeout.

It is intended to enforce process-tree lifecycle and the process cap only. It does **not** isolate the filesystem and does **not** block the network, so `sandbox.mode = "require"` refuses to run on Windows rather than pretend otherwise, and `auto` attaches a warning to the tool output.

### Sandbox limits

- Landlock mediates file access and TCP only. UDP and every other protocol are not covered; bubblewrap covers the whole network namespace.
- Only the `bash` tool is sandboxed. `read_file`, `write_file`, and `edit_file` are not.
- `opencode`, `pi`, and `claude` rob backends run their own agent and are not sandboxed by this layer.
- macOS falls back to no sandbox until a seatbelt backend exists.

## MCP

my-agent can use tools from [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio. Configure them in `my-agent.json` or the global config:

```json
{
  "mcp": {
    "servers": {
      "memory": { "command": ["npx", "-y", "@modelcontextprotocol/server-memory"] }
    }
  }
}
```

Each server takes `command` (the executable and its arguments) and an optional `env` object merged over the process environment. The server starts with the workspace root as its working directory. Project servers merge over global servers by name. Server names use letters, digits, `_`, and `-`; a bad name, an empty command, or a non-stdio entry that sets `url`, `transport`, or `type` is a config error. Only the stdio transport is supported for now.

Every server tool is namespaced `mcp__<server>__<tool>`, with any character outside `[A-Za-z0-9_-]` replaced by `_`. The `memory` server's `create_entities` becomes `mcp__memory__create_entities`. A tool name that collides with an existing tool disables that whole server and prints a notice.

MCP tools default to `ask`, so the dialog approves them like `bash`, and "allow always" persists the exact `mcp__...` name to `my-agent.json`. A server that fails to start prints `mcp <server>: <error>` and does not stop the others. Headless runs print `[mcp] <server>: N tools` for each connected server; the TUI shows the same counts as transcript lines.

Servers run as your user with the same environment and are not sandboxed by the `bash` sandbox. Team mode connects them once per run: every native rob receives the configured tools, and the connection set is disposed when the team stops. A `cli` rob (`pi`, `opencode`, or `claude`) runs its own tool registry and uses its own MCP configuration instead. A sub-agent a rob starts through `delegate` does not receive MCP tools.

## LSP

my-agent can run a language server and surface its diagnostics. Configure a top-level `lsp` block in `my-agent.json` or the global config:

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx"]
      }
    }
  }
}
```

Each server takes `command` (the executable and its arguments) and `extensions` (the file extensions it owns, matched case-insensitively), plus optional `env`, `initialization`, and `disabled` flags. The server starts lazily on the first file whose extension it owns and is reused afterwards. A server marked `disabled` is ignored, and project servers merge over global servers by name. An empty or absent `servers` map means LSP is off.

The read-only `diagnostics` tool runs the matching server on a file and returns its diagnostics as `<path>:<line>:<col> <severity> <message>` lines, or a `no diagnostics` line when the file is clean. It filters by `severity` (`error`, `warning`, `info`, or `hint`) when asked, and an unknown extension returns an error naming the configured extensions. Servers run as your user with the same environment and are not sandboxed by the `bash` sandbox, and they shut down cleanly when the run ends.

## Hooks

A project can run a shell command before or after each tool call. Configure a top-level `hooks` block in `<workspace>/my-agent.json`:

```json
{
  "hooks": {
    "preToolUse": [
      { "match": "bash", "command": "node scripts/check.mjs" }
    ],
    "postToolUse": [
      { "match": "*", "command": "node scripts/audit.mjs" }
    ]
  }
}
```

Each entry has a `match` glob against the tool name (`*` matches every tool, exact names match themselves) and a `command` run through the system shell with the workspace root as the working directory. The command receives one JSON object on stdin, `{ "hook": "preToolUse", "tool": "<name>", "args": <args> }`, and the tool name is also exported as `MY_AGENT_TOOL`.

A `preToolUse` hook that exits zero lets the call proceed. A non-zero exit blocks the tool, and the tool result becomes `ok: false` whose reason is the hook's trimmed stdout, or a default message when stdout is empty. Pre hooks run before authorization, so a hook denial is reported even for a call that also needs approval. A `postToolUse` hook runs after the tool finishes and its output is ignored, so it never changes the result. A hook that cannot be spawned blocks the pre case and is ignored for the post case. Hooks come only from the project file; the global config does not accept them.

Team robs run the same hooks as the solo agent. A native rob applies the project hooks to its own tool calls and to the sub-agents it starts through `delegate`. A `cli` rob runs its own external process and tool registry, so it does not receive these hooks.

## Plugins

A plugin is an in-process ESM module that contributes tools, slash commands, and extra system-prompt text. Configure its module specifiers in a top-level `plugins` array in `my-agent.json` or the global config:

```json
{
  "plugins": ["./my-plugin.mjs", "my-agent-plugin-time"]
}
```

A spec starting with `.` or `/` resolves relative to the workspace root; anything else is a bare package name resolved from `node_modules`. Project and global specs merge and dedupe by spec string.

A plugin module exports either the plugin object itself or `{ "default": plugin }`:

```js
// my-plugin.mjs
export default {
  name: "my-plugin",
  tools: [
    {
      name: "hello",
      description: "Return a greeting.",
      readOnly: true,
      async execute(args) {
        return { ok: true, output: `hello ${args.name}` };
      },
    },
  ],
  commands: [
    { name: "hello", description: "Say hello", body: "Say hello to $ARGUMENTS." },
  ],
  systemPrompt: "You answer in the style of the workspace plugin.",
  async dispose() {
    // release resources this plugin holds
  },
};
```

Plugin tools join the agent's tool list alongside the built-ins and MCP tools, and their `execute` runs in-process with the agent's full privileges. A plugin's `systemPrompt` is appended to the agent's extra instructions (multiple plugins join with blank lines), and its `commands` show up in the TUI slash-command menu after the file-based custom commands. A plugin's `dispose` runs when the process stops, at the same points the MCP server connections are disposed.

Plugins are trusted code. They run in-process with full access to your machine and workspace, outside the bash sandbox, so only load plugins you trust. A plugin that fails to import, is missing a `name`, or has a tool without an `execute` is reported and skipped and never stops the other plugins. A plugin tool whose name collides with a built-in tool or another plugin's tool is rejected with a message naming both. TypeScript plugins are out of scope for now: plugins are plain JavaScript (ESM).

## AGENTS.md

If `<project root>/AGENTS.md` exists, its contents are added to the system prompt. It is read from the project root only. `my-agent init` drafts one for you from a scan of the workspace; it refuses to overwrite an existing file unless you pass `--force`.

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

## Custom commands

Define your own slash commands as markdown files under `<workspace>/.my-agent/commands`. Each file starts with the same YAML frontmatter as a skill (`name` in lowercase kebab-case, one-line `description`), and the body is the prompt the model receives:

```markdown
---
name: greet
description: Greet someone by name
---
Say hello to $ARGUMENTS.
```

Typing `/greet Ada` sends `Say hello to Ada.`. `$ARGUMENTS` is replaced by the text after the command name; a body without it appends the arguments. The suggestion menu lists custom commands after the built-ins, and the names cannot reuse the built-in commands (`help`, `clear`, `compact`, `model`, `allow-all`, `quit`). A missing directory or a malformed file is skipped.

## Task

The `task` tool lets the solo agent delegate one self-contained sub-task to a fresh sub-agent and receive only its final text. The sub-agent inherits the parent's provider, model, workspace, permissions, and thinking, and it gets the standard tools but no `task` tool, so it cannot recurse. Its events never stream to your transcript; only the final text returns, capped at 4000 characters. `task` is available in headless runs, the TUI, and the web UI, and it asks for approval by default like `bash`.

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
- `command: "claude"` runs Claude Code, one `claude -p` process per turn. The first turn passes a fresh `--session-id` and later turns `--resume` it, so the rob remembers its history. Its config lives under `~/.config/my-agent/claude/<name>/` (via `CLAUDE_CONFIG_DIR`, overridable with `MY_AGENT_CLAUDE_CONFIG_DIR`) so rob sessions stay out of your own `~/.claude`. `model` is optional; set it to pin a Claude Code model alias. Tools that resolve to `allow` are exposed with `--allowedTools`, and `ask` and `deny` tools are denied with `--disallowedTools`. Interactive approval is not bridged, so an `ask` tool is treated as denied rather than surfaced in the approval dialog.

`send_message` and `delegate` are native-only. Listing either in a `cli` rob's `permissions` is a config error.

## Known limits

- `bash` is sandboxed on Linux when a backend is available (see Sandbox). Without bubblewrap or a Landlock-capable `python3`, and on macOS and Windows, it falls back to no sandbox and warns; that is why it asks first.
- `bash` runs through the system shell. On Windows that is `cmd.exe`, so POSIX commands (`ls`, `grep`, `printf`, and similar) will not work there.
- Context compaction summarizes the older messages with one extra model call when the estimate exceeds the threshold. Reasoning blocks are not part of the estimate because the provider drops them from outbound requests.
- Sessions are saved so `--continue` resumes them. The compaction summary is a `user` message tagged `[compacted summary]`; it persists, but the model must keep the facts it needs in that summary.
- Robs that use a `cli` backend (`pi`, `opencode`, or `claude`) cannot send private messages (`send_message`) or start sub-agents (`delegate`). Listing either tool in their `permissions` is a config error. The `pi` and `opencode` backends route `ask`-level tools through the rob's authorizer and the shared approval queue; the `claude` backend has no approval bridge, so its `ask` tools are denied instead. The `pi` backend relies on its approval extension loading: if the extension loads without registering its `tool_call` hook those tools run unapproved, and a failed load stops the run. An `opencode` permission request carries only opencode's action and resource, so a request that cannot be mapped back to one of the six tools is rejected, and for the shared `edit` action the bridge authorizes as `write_file` or `edit_file`, whichever the rob's rules resolve to ask.
- CLI backends are `pi`, `opencode`, and `claude`. `codex` and `kimi` are not implemented.

## Development

```bash
pnpm dev            # run from source
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm lsp:smoke      # run the real typescript-language-server and print diagnostics
```

`pnpm lsp:smoke` starts the real `typescript-language-server` against a throwaway TypeScript workspace that contains one type error, runs the `diagnostics` tool, and prints the result. It prints `skipped: ...` and exits 0 when the binary is not on `PATH`.
