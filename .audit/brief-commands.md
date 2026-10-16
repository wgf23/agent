GOAL: Let users define custom slash commands as markdown files; typing `/name args` in the TUI sends the expanded prompt to the model.

WORKTREE: /tmp/opencode/wt/commands (branch feat/commands).

SCOPE (write): src/commands/commands.ts (new), src/commands/load.ts (new), src/tui/App.tsx, src/tui/suggestions.ts, README.md, CHANGELOG.md, test/commands/*.test.ts (new), test/tui/* (extend).
SCOPE (read only): src/tui/state.ts, src/skills/frontmatter.ts (reuse frontmatter parsing if suitable), src/util/paths.ts, src/config/resolve.ts.

CONTEXT:
- Commands are markdown files in `<workspace>/.my-agent/commands/*.md`, each with YAML frontmatter `name` (kebab-case) and one-line `description`, then a prompt body. `$ARGUMENTS` in the body is replaced by the text after the command name; if absent, append the arguments.
- Discovery mirrors src/skills/discover.ts and src/skills/frontmatter.ts. Load once per TUI session.
- TUI: the suggestion menu (src/tui/suggestions.ts) lists built-in slash commands; add the custom ones after them. Selecting or submitting `/name ...` expands to the prompt body and sends it as a user message, instead of treating it as unknown.
- A missing directory or a bad file is skipped, never fatal.
- Web/TUI parity is out of scope this round (TUI only).

ACCEPTANCE:
- `loadCommands(root)` returns entries { name, description, body } and skips invalid files and the built-in names (`help`, `clear`, `compact`, `model`, `allow-all`, `quit`).
- `expandCommand(text, commands)` returns the expanded prompt for a known command with `$ARGUMENTS` substituted, or null for an unknown command. Pure and literal-tested.
- TUI accepts a custom `/name arg` and sends the expanded text; the suggestion menu shows custom commands.
- Tests: unit tests for load + expand; a tui test proving a custom command submits the expanded prompt.
- README documents `.my-agent/commands`; CHANGELOG Unreleased > Added.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
