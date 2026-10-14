# Web file workbench: plan and decision trail

Run: 2026-10-14, overnight. Branch `feat/web-ux`, worktree `/workspace/wt-web-ux`. The
requirement is the owner's draft v0.2 (web file tree, upload/download, filesystem-style
workspace picker). The owner is asleep and asked for the whole requirement, so this runs
autonomously: one unit per milestone, each verified against the real artifact before the next,
each committed and pushed.

Exit condition. Every milestone below has evidence against the real server, real disk, and the
CDP browser, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and the web `tsc && vite build` are
green, and the branch is pushed.

## Locked decisions carried in

- Upload is multipart streaming with `@fastify/multipart` (方案 A). Installed in the worktree.
- The directory browser is bounded to `$HOME` plus the current workspace root, no extra roots.
- P2 is in scope: mkdir / rename / move / delete, auto refresh, click-to-read, and directory zip.

## Milestones

| # | Unit | Status |
| --- | --- | --- |
| M1 | Read-only file tree: `src/serve/files.ts` list + `GET /api/files`, `FileTree` panel with lazy load, hidden/ignored toggles | LANDED 96e6d44 |
| M2 | Download: `GET /api/files/download` streamed, tree download button | LANDED 43af47a |
| M3 | Upload: `@fastify/multipart` route, target dir, progress, overwrite policy, refresh | LANDED 0a9743e |
| M4 | Directory browser: `GET /api/fs/dirs` bounded to home + workspace, `WorkspacePicker` modal | LANDED 53596c6 |
| M5 | Structure ops: mkdir / rename / move / delete with confirm and boundary checks | LANDED 37c0ea2 |
| M6 | Folder zip download: `GET /api/files/archive` | LANDED bea9c2c |
| M7 | Auto refresh on agent writes (`files_changed`) + click-to-read a file | LANDED 9e9cfb9 |
| M8 | Docs, CHANGELOG, e2e phase | LANDED 949a07d |

`pnpm files:e2e` drives the whole workbench against the real server, real disk,
and real HTTP without a provider key: it prints one `PASS` line per phase and
exits `1` on the first failure.

## Trail

`docs/audit/web-files-trail.tsv` is the machine trail, one row per unit.
