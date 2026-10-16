# P0-3 后端桥接覆盖面核验（验收记录）

日期：2026-10-16 ｜ 分支：`feat/p0-grok-parity` ｜ 结论：**opencode 与 claude 的团队工具桥接已通**（pi 侧另见 `cli-backend` 用例）。

## 结论

三个 CLI 后端都能把团队工具 `send_message` / `delegate` 送进各自的子进程，并让 CLI bot 收 DM、回 DM。唯一已知边界是 claude 的交互审批未桥接，`ask` 级别工具在 claude 里视同 deny。

## 实测

环境里的真实 CLI：

| CLI | 版本 | 路径 |
| --- | --- | --- |
| opencode | v2.0.24 | `/root/.local/bin/opencode` |
| claude | 2.1.296 (Claude Code) | `~/.local/share/mise/shims/claude` |
| pi | 0.73.0 | `~/.local/share/mise/shims/pi` |

复现命令与结果：

```bash
pnpm exec vitest run test/rob/mcp-shim.test.ts        # 2 passed
pnpm exec vitest run test/rob/opencode-backend.test.ts # 30 passed
pnpm exec vitest run test/rob/claude-backend.test.ts   # 25 passed
pnpm exec vitest run test/rob/team-dm-roundtrip.test.ts # 1 passed
```

## 各后端核验点

| 后端 | 桥接机制 | 用例断言（代码级） |
| --- | --- | --- |
| opencode | 生成 `team-mcp.mjs`，经 `OPENCODE_CONFIG_CONTENT` 的 `mcp.servers["myagent-team"]` 注入 | 配置含 `command:["node", shimFile]` 与 `codemode:false`（`opencode-backend.test.ts:979-983`）；`myagent-team_*` 权限自动回 `once`（`:1028-1040`） |
| claude | 生成 `team-mcp.mjs` + `--mcp-config` | argv 含 `--mcp-config`、`--strict-mcp-config`、`--allowedTools` 里列出 `mcp__myagent-team__send_message/mcp__myagent-team__delegate`（`claude-backend.test.ts:660-665`） |
| pi | `--tools` + `pi.registerTool` 扩展 | 见 `test/rob/cli-backend.test.ts`（本记录不展开） |
| 共用 shim | `src/rob/gateway/shims.ts` 的 `teamMcpShim`，真实 stdio | `initialize`/`tools/list`/`tools/call` 三态与拒绝时 `isError`（`mcp-shim.test.ts:167-262`） |

跨后端往返：`test/rob/team-dm-roundtrip.test.ts` 用一个 claude rob 与一个 pi rob，经真实网关与 MCP shim 证明 `alpha → beta` 的 DM 送达、`beta` 收到后 `send_message` 回信、两条 DM 落账。删掉 `beta` 的回信调用后该用例转红，说明它观察的是真实投递，不是空断言。

## 未覆盖 / 边界

- claude 无交互审批桥，`ask` 工具不进暴露列表（`claude-backend.ts:80-83`）。这是设计边界，不是缺陷。
- opencode 侧用例用注入的 `spawn`/`fetch` 驱动，没有真的起 `opencode serve`。本机有 opencode v2.0.24，但没有真实 turn 的端到端跑；如需最强证据，可在有 key 时补一次真 CLI 冒烟。

## 关联

- 总稿：`docs/research` 系列不在本仓库，P0 描述以团队合并稿为准。
- 旧稿 `docs/research/cli-backend-team-tools-gap.md`（“CLI 拿不到团队工具”）已过期。
