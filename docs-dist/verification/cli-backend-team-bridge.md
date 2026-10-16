# pi 后端团队桥接（P0-3 切片）

对应：P0-3 ｜ 结论：**已验证通过**。

pi 没有 MCP 加载路径，改走 `--extension` 注入的 pi 扩展。`src/rob/cli-backend.ts` 用 `turn.bridge.tools` 生成 `piBridgeExtension({ defs })`，经 `--tools` 暴露工具名，并把团队 socket 的 env 透传给子进程。

## 证据

- 单测：`pnpm exec vitest run test/rob/cli-backend.test.ts` → **19 passed**，含"carries a fake pi's team tool calls through the turn's gateway"（fake pi 经真实网关转发 `send_message`）。
- 跨后端往返：`test/rob/team-dm-roundtrip.test.ts` 里 pi rob 与 claude rob 互发 DM 并各自回信，pi 侧为发送方或接收方都覆盖。
