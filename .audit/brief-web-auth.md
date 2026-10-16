GOAL: Add token auth to `my-agent serve` when it binds to a non-loopback host, so the UI is not open to the network.

WORKTREE: /tmp/opencode/wt/web-auth (branch feat/web-auth-token).

SCOPE (write): src/serve/server.ts, src/serve/open-browser.ts (only if the URL changes), README.md, CHANGELOG.md, test/serve/*.ts (extend or add).
SCOPE (read only): shared/protocol.ts, src/serve/hub.ts, src/serve/composite.ts, src/cli/setup.ts.

CONTEXT:
- Default host is 127.0.0.1 and there is no auth today. README's known limit says a non-loopback bind needs a token.
- When the resolved host is not loopback (not `127.0.0.1`, `::1`, or `localhost`), generate a random token at startup. Require it on every request: SSE `GET /api/events` accepts `?token=<token>`, and POST routes accept either `Authorization: Bearer <token>` or `?token=<token>`. A request with a missing or wrong token gets `401`. Loopback binds keep today's behavior exactly (no token).
- Print the startup URL including the token when one is required, so the owner can open the UI.
- `POST /api/settings` is already refused on non-loopback; keep that.

ACCEPTANCE:
- Loopback bind: unchanged; no token needed (existing tests stay green).
- Non-loopback bind: a request without a valid token returns 401; a valid `?token=` or `Bearer` passes.
- The startup line prints the URL with the token.
- Tests start the server (or call the route layer) on a non-loopback host with a fixed token and assert 401 vs 200, using literal values.

VERIFY: from the worktree run `pnpm test`, `pnpm typecheck`, `pnpm lint`; all green.
FORBIDDEN: no new deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
