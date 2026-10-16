GOAL: Add a Windows `bash` sandbox backend: platform detection, a plan branch, and a shipped PowerShell helper that uses a Windows Job Object for process-tree lifecycle. It is UNVERIFIED on a real Windows host (none exists here); the user will test it.

WORKTREE: /tmp/opencode/wt/windows (branch feat/windows-sandbox, based on feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

DESIGN (implement this shape):
- `BackendPlan` in src/sandbox/detect.ts gains `{ backend: "windows"; pwsh: string }`.
- Detection is platform-gated: only on `process.platform === "win32"` do the probes look for `pwsh` then `powershell.exe` on PATH; if neither is found, fall through to `{ backend: "none"; reason }`. Keep the Linux probes (bwrap, python/landlock) exactly as they are and only run them on non-win32, so Linux tests and behavior stay unchanged. Expose the probes so tests inject fakes.
- src/sandbox/index.ts `planSandboxedBash`: add the `windows` branch.
  - `mode: "off"` keeps today's unsandboxed `cmd.exe` argv.
  - `mode: "auto"` with `backend: "windows"`: run via the helper, and always attach a `warning` that Windows does not yet isolate the filesystem or block network.
  - `mode: "require"` with `backend: "windows"`: refuse with a clear reason, because the Windows backend only manages process lifecycle, not filesystem or network isolation. Do not pretend otherwise.
  - The plan argv calls the helper: `[pwsh, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", <helperPath>, "-Command", <command>, "-Cwd", <workspaceRoot>]`.
- src/sandbox/windows.ts: `windowsArgv(...)` mirroring `bwrapArgv`/`landlockArgv`, plus a `windowsHelperPath()` that ships `src/sandbox/windows-helper.ps1` (copy the pattern landlock uses for its python helper, read it and write it to a private temp dir if you prefer a file on disk; keep it simple and testable).
- src/sandbox/windows-helper.ps1: creates a Job Object via `Add-Type` P/Invoke with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and an active-process cap, starts `cmd.exe /d /s /c <command>` with the given working directory, assigns the child to the job, waits, and exits with the child's code. Best-effort; it must fail loudly if the P/Invoke or job creation fails, never fall back silently.

ACCEPTANCE:
- Unit tests (pure, injected probes) cover: win32 detection returns `windows` when a pwsh is present and `none` otherwise; the windows plan argv shape for off/auto/require; the auto warning text; the require refusal text.
- Linux detection and planning are unchanged and every existing sandbox test still passes.
- README gets a Windows subsection that states plainly: what is enforced (job-object lifecycle, child-process cap), what is NOT (filesystem and network isolation), that `require` refuses on Windows, and that it is unverified on a real host.
- CHANGELOG Unreleased > Added.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

FORBIDDEN: no new runtime deps, no edits outside SCOPE (`src/sandbox/*`, `src/tools/bash.ts` only if a Windows-kill change is truly needed, README, CHANGELOG), no push/rebase, and never claim filesystem or network enforcement that is not implemented.
REPORT: at most 15 lines.
