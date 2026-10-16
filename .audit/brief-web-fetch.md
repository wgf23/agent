GOAL: Add a read-only `web_fetch` tool so the agent can retrieve a URL's content during a turn.

WORKTREE: /tmp/opencode/wt/web-fetch (branch feat/web-fetch, already checked out).

SCOPE (write):
- src/tools/web_fetch.ts (new)
- src/tools/registry.ts (register the tool)
- src/permissions/rules.ts (add the default rule for web_fetch)
- README.md (Tools / permissions docs), CHANGELOG.md (Unreleased > Added)
- test/tools/web_fetch.test.ts (new)

SCOPE (read only, do not write): src/tools/read_file.ts, src/tools/types.ts, src/util/truncate.ts, src/providers/types.ts, test/tools/*.test.ts, test/helpers/*.

CONTEXT:
- registry.ts is a plain `tools` array; add the import and the entry.
- Tool interface (src/tools/types.ts): { name, description, readOnly: boolean, schema?: zod, execute(args, ctx) => Promise<{ok:true;output:string} | {ok:false;error:string}> }. ToolContext is { workspaceRoot, signal? }.
- readOnly:true tools run in parallel with other readOnly tools.
- Truncate output with `truncateOutput` from src/util/truncate.ts.
- Permissions: a tool with no rule defaults to "ask" via `defaultAction`. Add `web_fetch: "ask"` to DEFAULTS in rules.ts so it is explicit.
- Node 20+ has global `fetch` and `AbortSignal.timeout`.

ACCEPTANCE (each checkable):
- Tool name `web_fetch`, readOnly true.
- zod schema: url (string), format ("markdown" | "text" | "html", default "markdown"), timeout_ms (int, default 30000, max 120000). Use `.strict()`.
- Rejects non-http/https schemes and unparseable URLs with ok:false and a clear message.
- Successful 2xx response returns the body. For "markdown" and "text", strip HTML to readable text with a small local function (no new dependency); "html" returns the raw body. Truncate via truncateOutput.
- Non-2xx returns ok:false naming the status code.
- Network error, timeout, and abort return ok:false with a clear message; the tool never throws.
- Honors ctx.signal (an abort cancels the fetch).
- web_fetch defaults to ask.
- Tests stub the network (`vi.stubGlobal("fetch", ...)`) so no real request happens. Cover: success text, HTML strip, non-2xx, bad scheme, timeout/abort, truncation.

VERIFY: from /tmp/opencode/wt/web-fetch run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.

FORBIDDEN: no new deps, no edits outside SCOPE, no touching /workspace/my-agent, no push/rebase.

REPORT: per the standing orders.
