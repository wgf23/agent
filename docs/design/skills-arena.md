# Skills arena: npm-installable skills

One page on choosing and integrating the skills candidate. The arena ran two
candidates from the same base commit `f028cdb`. Both are single-commit branches
with a shared `RATIONALE.md`.

## Base: candidate 1

Base is candidate 1 (`arena/skills-c1`, commit `ae293c4`). The cross-judge
scored it 20 to 18 and named three reasons.

- Failure rollback. `addSkill` diffs the prefix `node_modules` before and after
  npm and undoes what the invocation added, so a validation failure leaves the
  installed set unchanged.
- Global test isolation. `test/setup.ts` points `MY_AGENT_SKILLS_DIR` at a temp
  directory for every test file, so pre-existing tests that call `runAgent`
  never read the real home prefix. Candidate 2 sets the override only in its
  own skills tests.
- Literal assertions. Candidate 1 asserts exact values (`toEqual`, exact output
  strings) where candidate 2 asserts `toContain`, so a broken formatter or
  message still fails.

## Drift at integration

An unrelated feature, interactive API key setup, landed after the branch point
as `5eff18b`. It edited `src/index.ts`, `README.md`, `PLAN.md`, and
`CHANGELOG.md`. Candidate 1 edited only `src/index.ts` and `README.md` of those
four. The cherry-pick conflicted in `src/index.ts` alone; `README.md`
auto-merged.

Both features are kept. `src/index.ts` keeps the `setup` command and adds the
`skill` command. `README.md` keeps the Credentials section and adds the Skills
section. `PLAN.md` and `CHANGELOG.md` come from the setup feature untouched.

## Grafts

Grafts land on the candidate 1 base in commit `1080860`.

| Graft | Source | Change |
| --- | --- | --- |
| a | candidate 2 | npm argv hardening. Install and uninstall put flags before `--` and the spec or package name after it, so npm cannot read a flag as a package spec. |
| b | candidate 2 | Reuse `resolveInWorkspace` from `src/util/paths.ts` in `discover.ts` and `tool.ts`. Delete the duplicate guard `resolveInside` and `SkillPathError` in `src/skills/paths.ts`, keeping `skillsRoot()`. The tool keeps its early skill-name pattern rejection. |
| c | judge | Rollback correctness. Undo only the package directories this invocation added. A failed re-add of a pre-existing package removes nothing and uninstalls nothing. |
| d | candidate 2 | Discovery resilience. `discoverSkills` returns `[]` when `node_modules` cannot be read for reasons other than `ENOENT`. Invalid skills in a readable package are still skipped silently. |
| e | candidate 2 | Aligned list output. Exported pure `formatSkillList(skills)` in `src/cli/skill.ts` with columns name, package, version, description, path. Candidate 1's add and remove status messages are kept. |

## Rejected: candidate 2

Candidate 2 is not the base, and only the named grafts above are taken.

- No test isolation for pre-existing tests. Its skills tests set
  `MY_AGENT_SKILLS_DIR`, but a pre-existing test that reaches `discoverSkills`
  through `runAgent` reads the real home prefix.
- False failure on re-add. It identifies the requested package by diffing the
  prefix `package.json` dependencies. A re-add that changes no dependency key
  reports `did not add a package` instead of re-validating the package that is
  already there.
- Transitive residue after a failed validation. Its rollback uninstalls the one
  direct dependency, but a transitive dependency hoisted into the prefix stays.

## Cross-judge verdict

Candidate 1 scored 20, candidate 2 scored 18. The judge recommended candidate 1
as the base for its failure rollback, global test isolation, and literal
assertions.

## Dropouts

None. Both candidates built and reported a full command run.

## Verification

Run on master after the grafts, at commit `1080860`.

- `pnpm typecheck` passed. `tsc --noEmit`, exit 0.
- `pnpm lint` passed. `biome check .`, 137 files, no fixes applied, exit 0.
- `pnpm test` passed. 51 test files, 333 tests, exit 0.
- `pnpm build` passed. `dist/index.js` 171.81 KB, exit 0.

A real CLI pass under `MY_AGENT_SKILLS_DIR` follows the build and is recorded in
the integration report. The invalid fixture names its package and leaves the
list unchanged; the valid fixture round-trips through add, list, and remove.
