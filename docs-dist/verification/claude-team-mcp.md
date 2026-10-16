# claude 团队 MCP（P0-3 切片）

对应：P0-3 ｜ 结论：**已验证通过**。

## 机制

`src/rob/claude-backend.ts` 把团队工具写成 `team-mcp.mjs` 与 `team-mcp.json`，用 `--mcp-config` 注入，`--strict-mcp-config` 只加载它，并把 `mcp__myagent-team__send_message`、`mcp__myagent-team__delegate` 放进 `--allowedTools`。deepseek preset 提供 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`），所以 claude rob 用配置的 DeepSeek key 即可，无需 Claude 登录。

## 证据

单测：`pnpm exec vitest run test/rob/claude-backend.test.ts` → **25 passed**。断言 argv 含 `--mcp-config <file>`、`--strict-mcp-config`，且 `--allowedTools` 里列出两个团队工具。

真实 turn：`bash scripts/team-bridge-smoke.sh` 用真实 `claude` 2.1.296 子进程，输出

```
=== DMs ===
cc -> sink: pong-claude
```

## 边界

claude 的交互审批未桥接，`ask` 级别工具不进暴露列表（`claude-backend.ts`）。这是设计边界，不是缺陷。
