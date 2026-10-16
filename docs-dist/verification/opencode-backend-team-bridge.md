# opencode 后端团队桥接（P0-3 切片）

对应：P0-3 ｜ 结论：**修复后已用真实 opencode turn 验证通过**。

## 缺陷与修复

`src/rob/opencode-backend.ts` 之前给团队 MCP server 写死 `codemode: false`，注释称这样能让工具"直连"。在 opencode **v2.0.24** 上事实相反：server 能连上并 `tools/list`，但 agent 拿不到可调用的工具，`send_message`/`delegate` 全丢。单测只断言了写出的配置对象本身（断言的是自己的常量），所以一直绿。

修复两处：

1. `codemode: false` → `codemode: true`，让 MCP 工具经 Code Mode（`execute`）暴露。
2. `opencodePermissions` 的基础 `deny *` 会把 Code Mode 的入口 `execute` 一起藏掉，导致工具仍不可达；在基础 deny 之后追加 `{ action: "execute", resource: "*", effect: "allow" }`。

安全性未放松：Code Mode 里每次调用仍受权限约束，团队工具经网关的 rob authorizer 决策，内置工具走既有映射规则。

## 证据

单测（配置层）：`pnpm exec vitest run test/rob/opencode-backend.test.ts` → **30 passed**。断言含 `mcp.servers["myagent-team"]` 的 `command`、`codemode: true`、`myagent-team_*` 权限自动回 `once`。

真实 turn（端到端）：`bash scripts/team-bridge-smoke.sh` 用真实 `opencode serve` 子进程，输出

```
=== DMs ===
oc -> sink: pong-opencode
```

修复前同一命令下 rob 的可用工具只有 `edit, glob, grep, read, shell, write`，没有 `send_message`。

## 已知行为

Code Mode 的工具目录异步加载。若模型在目录就绪前查询会看到空目录并可能放弃，如冒烟脚本里的提示所示，需要重查一次。这是 opencode 侧行为，本仓库未绕过。
