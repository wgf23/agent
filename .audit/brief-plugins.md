GOAL: Add a plugin system: in-process modules that contribute tools, custom slash commands, and extra system-prompt text, loaded by spec from config.

WORKTREE: /tmp/opencode/wt/plugins (branch feat/plugins, based on feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

DATA SHAPE (implement exactly this):
- src/plugins/types.ts: `export interface PluginContext { workspaceRoot: string }` and
  `export interface MyAgentPlugin { name: string; tools?: Tool[]; commands?: Command[]; systemPrompt?: string; dispose?: () => Promise<void> | void }`.
  Reuse `Tool` from src/tools/types.js and `Command` from src/commands/commands.js (read that file for the exact shape).
- A plugin module is ESM. Its exports are either the plugin object itself or `{ default: MyAgentPlugin }`.

IMPLEMENT:
- src/plugins/load.ts: `loadPlugins(specs: string[], workspaceRoot: string): Promise<{ tools: Tool[]; commands: Command[]; systemPrompt: string; errors: string[]; dispose: () => Promise<void> }>`.
  - A spec starting with `.` or `/` resolves relative to the workspace root; anything else is a bare module specifier resolved by the runtime (node_modules).
  - Import with a dynamic `import()`. Validate the exported object shape (name is a non-empty string; tools is an array of objects with a `name` and an `execute`; commands is an array of command specs). One malformed plugin is reported in `errors` and skipped; it never stops the others.
  - Reject a plugin whose tool name collides with a built-in registry name or with an already-loaded plugin tool, with a clear message naming both.
  - A plugin that throws on import is caught and reported, not fatal.
  - `systemPrompt` values are joined with blank lines.
- Config: a top-level `plugins` array of strings in the project file and the global file, parsed in src/config/resolve.ts the same way `search`/`mcp` are. Project and global merge and dedupe by spec string. Bad entries are a config error naming the file.
- Wiring (mirror how `extraTools` and custom commands are already threaded): load plugins once per process and pass `plugin.tools` at the same call sites as `mcp.tools` (src/cli/run.ts, src/tui/index.tsx, src/serve/server.ts), append `plugin.systemPrompt` to `runAgent`'s `extraInstructions` (combine with any existing value), and add `plugin.commands` to the TUI custom-command list (`setCustomCommands`), merged with the file-based custom commands. Call `dispose` at the same points the MCP manager is disposed.

ACCEPTANCE:
- A fixture plugin at test/fixtures/fake-plugin.mjs exporting a tool, a command, and a systemPrompt is loaded; the tool is callable through `executeTool` and returns its literal output; the command and systemPrompt are present in the returned bundle.
- A malformed plugin (missing name, or a tool without execute) lands in `errors` and is skipped; the good plugins still load.
- A plugin tool whose name equals a built-in (`bash`) is rejected with a message naming the collision.
- A plugin that throws on import is caught into `errors`.
- Config parses `plugins`, merges project and global, and dedupes.
- With plugins configured, the plugin tool is present in the `runAgent` tool list; with none, nothing changes.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

NOTES: plugins are trusted code that runs in-process with full privileges; document that clearly in README under a Plugins section, with an example plugin file and the `plugins` config. TypeScript plugins are out of scope (JS/ESM only).

FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
