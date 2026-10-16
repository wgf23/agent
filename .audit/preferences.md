# Standing orders: agent-features program

1. Work ONLY inside your assigned worktree (/tmp/opencode/wt/<name>). The main checkout /workspace/my-agent is read-only to you.
2. node_modules is a symlink to the main checkout. Never run `pnpm install`, `npm install`, or `pnpm add`.
3. All three must pass from your worktree root: `pnpm test` (vitest run), `pnpm typecheck` (tsc --noEmit), `pnpm lint` (biome check .).
4. Match the surrounding style: tabs for indent, ESM `.js` import specifiers, zod schemas, small focused modules. Read 2-3 neighboring files before writing.
5. Do not add runtime dependencies and do not edit package.json dependencies.
6. Tests call code the way users do and assert literal expected values. No test that still passes if the code under test returns undefined.
7. Commit on your branch with a conventional-commit message (`feat: ...`). Do not push, do not rebase, do not touch other branches.
8. Update README.md and CHANGELOG.md only for the feature in your scope.
9. Never edit files outside your SCOPE. If you need a change outside SCOPE, stop and report it instead.
10. Report: status, branch, head SHA, files changed, exact commands run with outcomes, deviations, follow-ups.
