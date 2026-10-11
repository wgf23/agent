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
export DEEPSEEK_API_KEY=sk-...
my-agent            # interactive TUI
```

## Modes

- `my-agent` opens the TUI.
- `my-agent run "list the ts files and summarize package.json"` runs headlessly and streams the answer to stdout.
- `my-agent "..."` does the same as `run`.
- `--yes` auto-approves every tool call. Without it, headless mode denies any tool that needs approval and keeps going.
- `-m, --model <spec>` picks a model, for example `deepseek/deepseek-v4-pro` or `openai/gpt-4o`.
- `--max-steps <n>` caps the agent loop.
- `my-agent --version` prints the version.
- `my-agent config` prints the resolved provider, model, baseURL, maxSteps, and where each value came from. It never prints the key; it prints `set` or `missing`.

## TUI

Slash commands: `/help`, `/clear`, `/model`, `/quit`.

Keys:

- `Enter` submits.
- `Ctrl+J` inserts a newline (multiline input).
- `Esc` cancels the running turn.
- `Ctrl+C` quits.
- `Ctrl+O` toggles tool output.
- `Ctrl+T` toggles the reasoning fold.
- `Up`/`Down` walk the input history (single-line input only).

## Configuration

Precedence, highest first: command-line flags, environment variables, the project file `<workspace>/my-agent.json`, the global file `~/.config/my-agent/config.json`, built-in defaults.

Environment variables supply keys and one model override. They are never read from a file:

- `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` (or the variable named by `apiKeyEnv`).
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

Keys are not allowed in either file. A file with an `apiKey` field is rejected; put the key in an environment variable instead and point `apiKeyEnv` at it. `thinking` and `reasoningEffort` are DeepSeek options; they are only sent when the `deepseek` preset is active.

## Permissions

Each tool maps to an action: `allow`, `ask`, or `deny`. A tool can also take an ordered list of `{ "pattern", "action" }` rules; the first matching pattern wins. `*` is a wildcard, so `git status*` matches `git status` and `git status --short`.

Defaults: `read_file`, `glob`, and `grep` are allowed; `write_file`, `edit_file`, and `bash` ask.

In the TUI, the dialog offers `y` allow once, `a` allow always, and `n` deny. Allow always appends a rule to `<workspace>/my-agent.json`. Dangerous commands (`rm -rf`, `sudo`, `curl ... | sh`, force push, and similar) are flagged and cannot be remembered as a standing rule.

## AGENTS.md

If `<project root>/AGENTS.md` exists, its contents are added to the system prompt. It is read from the project root only.

## Known limits

- `bash` is not sandboxed. It runs with your user's permissions; that is why it asks first.
- The context is not summarized. When it grows past the budget, older tool output is replaced with a placeholder.

## Development

```bash
pnpm dev            # run from source
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
