GOAL: Fix the real defects a cross-model review found in the plugin loader and the Windows sandbox. No new features.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/plugins/load.ts, src/plugins/types.ts, src/config/resolve.ts, src/cli/run.ts, src/tui/index.tsx, src/tui/App.tsx, src/serve/server.ts, src/sandbox/windows.ts, src/sandbox/windows-helper.ps1, src/sandbox/detect.ts, test/plugins/*, test/sandbox/*, README.md, CHANGELOG.md.
SCOPE (read only): src/tools/registry.ts, src/tools/types.ts, src/commands/commands.ts, src/util/paths.ts.

Each fix needs a failing-first test where the behavior is testable on Linux.

WINDOWS

W1. The process cap is inert and the helper has failure/timeout gaps. In windows-helper.ps1: set `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (0x8) together with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so `ActiveProcessLimit` actually applies; add a bounded `WaitForExit` that kills the job and exits non-zero on timeout; if `AssignProcessToJobObject` fails, print the Win32 error and exit with a clear message instead of continuing; and stop corrupting commands that contain quotes or a trailing backslash by writing the command to a temp `.cmd` file and running that, or another robust quoting method. (The helper cannot run here; keep the change minimal and correct by inspection.)

W2. `findExecutable` can return a directory. In src/sandbox/detect.ts, confirm a candidate is a file (`statSync().isFile()`), and on win32 also try the `PATHEXT` extensions when the candidate has none. Unit-test with a temp dir that contains a directory named `pwsh` and a real file, asserting the directory is rejected.

W3. Documentation states unverified behavior as fact. Reword README and CHANGELOG so the Windows backend is described as unverified, the process cap and kill behavior read as intended rather than proven, and it is explicit that filesystem and network are not isolated and `require` refuses.

PLUGINS

P1. Tool and command validation is weaker than the contract. In load.ts, require `description` to be a string and `readOnly` to be a boolean on a tool (or default `readOnly` to false and reject a missing description), and validate a command's fields against the `Command` shape. A violation is a per-plugin error, not a silent `undefined` sent to the provider.

P2. Command collisions are unchecked. Reject a plugin command whose name equals a built-in command, an existing file-based custom command, or another plugin's command, mirroring the tool collision check and naming the collision.

P3. Duplicate specs within one layer are not deduped. Dedupe inside a single config layer as well as across global and project, so the same spec listed twice does not load twice and produce a misleading collision error.

P4. Disposal is all-or-nothing. Use `Promise.allSettled` (or per-plugin catch) so one throwing disposer cannot reject the run's `finally` and change the exit code; collect failures into the errors list.

P5. Bare specifier resolution is wrong for a global install. Resolve a bare specifier from the workspace root (e.g. `createRequire(path.join(workspaceRoot, "package.json"))`), so a plugin installed in the workspace resolves; keep relative specs relative to the workspace; treat an absolute path (including a Windows drive-letter path) as a path, not a bare specifier; and reject a relative spec that escapes the workspace root.

P6. `systemPrompt` replaces instead of merging. Merge plugin `systemPrompt` with any existing `extraInstructions` (append with a blank line) rather than overwriting it.

P7. Two tests prove little. `test/sandbox/detect.test.ts` "caches per probe object" must assert the returned plan, not only probe call counts. Add a plugin test where a plugin tool throws at execute time and the agent receives a tool error rather than crashing.

ACCEPTANCE: failing-first tests for every testable fix; `pnpm test`, `pnpm typecheck`, `pnpm lint` green.
FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase, do not weaken existing tests.
REPORT: at most 15 lines.
