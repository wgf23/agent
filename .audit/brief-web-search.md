GOAL: Add a `web_search` tool so the agent can search the web and get titled result snippets, driven by a small configurable provider.

WORKTREE: /tmp/opencode/wt/integration (branch feat/agent-capabilities; all units merged). node_modules is a symlink; never run pnpm install.

SCOPE (write): src/tools/web_search.ts (new), src/tools/registry.ts, src/permissions/rules.ts, src/config/resolve.ts, README.md, CHANGELOG.md, test/tools/web_search.test.ts (new).
SCOPE (read only): src/tools/web_fetch.ts (mirror its shape and error style), src/config/project-file.ts, src/config/global-file.ts, src/util/truncate.ts, test/tools/*.test.ts.

CONTEXT:
- `web_fetch` (src/tools/web_fetch.ts) is the template: a read-only registry tool with a zod schema, a network call, `truncateOutput`, and never-throwing errors.
- Add a top-level `search` block to the config, parsed in src/config/resolve.ts the same way `mcp`/`sandbox`/`compaction` are: `{ "search": { "provider": "brave" | "tavily" | "searxng", "apiKeyEnv": string, "baseURL": string } }`. Provider defaults to `brave`; `apiKeyEnv` defaults per provider (`BRAVE_API_KEY`, `TAVILY_API_KEY`); searxng is keyless and needs `baseURL`. The global file may set it too.
- The tool reads the resolved config at execution time (the same pattern `src/tools/bash.ts` uses to read sandbox settings), so no new plumbing through runAgent is needed.
- Provider request/response mapping (keep it small and pure where possible):
  - brave: GET `<baseURL or https://api.search.brave.com/res/v1/web/search>?q=<query>&count=<n>`, header `X-Subscription-Token: <key>`, results at `web.results[]` with `title`, `url`, `description`.
  - tavily: POST `https://api.tavily.com/search` JSON `{ api_key, query, max_results }`, results at `results[]` with `title`, `url`, `content`.
  - searxng: GET `<baseURL>/search?q=<query>&format=json`, results at `results[]` with `title`, `url`, `content`.
- Return a compact numbered list `1. <title>\n   <url>\n   <snippet>`, truncated with `truncateOutput`. If the provider is not configured (no key, or searxng without baseURL), return ok:false with a clear message naming the config to set and the env var.
- `web_search` defaults to `ask` in src/permissions/rules.ts and returns the query as its permission subject in `toolSubject`.

ACCEPTANCE:
- Tool name `web_search`, readOnly true, `.strict()` schema `{ query: string, count?: int 1..20 default 5 }`.
- brave, tavily, and searxng responses each map to the numbered list (assert literal titles/urls).
- Missing key or missing searxng baseURL returns ok:false naming the config.
- Non-2xx and network errors return ok:false and never throw.
- Tests stub the network with `vi.stubGlobal("fetch", ...)`; no real request. Cover each provider mapping, the unconfigured error, and a non-2xx.
- README documents the `search` block; CHANGELOG Unreleased > Added.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
