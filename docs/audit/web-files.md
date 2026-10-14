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
| M1 | Read-only file tree: `src/serve/files.ts` list + `GET /api/files`, `FileTree` panel with lazy load, hidden/ignored toggles | LANDED e42e3a5 |
| M2 | Download: `GET /api/files/download` streamed, tree download button | LANDED 3f1527f |
| M3 | Upload: `@fastify/multipart` route, target dir, progress, overwrite policy, refresh | LANDED 5d88c2d |
| M4 | Directory browser: `GET /api/fs/dirs` bounded to home + workspace, `WorkspacePicker` modal | PENDING |
| M5 | Structure ops: mkdir / rename / move / delete with confirm and boundary checks | PENDING |
| M6 | Folder zip download: `GET /api/files/archive` | PENDING |
| M7 | Auto refresh on agent writes (`files_changed`) + click-to-read a file | PENDING |
| M8 | Docs, CHANGELOG, e2e phase | PENDING |

## Trail

`docs/audit/web-files-trail.tsv` is the machine trail, one row per unit.
