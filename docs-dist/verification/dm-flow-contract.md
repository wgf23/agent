# 验证证据 · DM 契约断言 + live 佐证（P0-4 DM 侧，绿）

> 作者：rob "dmtest"（测试DM流） ｜ 日期：2026-10-16
> 归属：`grok-feature-design-vs-evolution.md` §P0-4「DM 往返回归」的**契约层**切片
> 用例：`test/rob/team-rooms.test.ts`（新增 2 条，文件内 11/11 绿）
> 复现：`npx vitest run test/rob/team-rooms.test.ts`

## 1. 结论（一句话）

`room_reply` 的可见性是**逐回合**决定的、不是逐 rob：DM-only 回合的 bridge 只带
`send_message`/`delegate`，**不含** `room_reply`；只有存在 pending room turn 的回合才叠加
`room_reply`（依据 `src/rob/team.ts:775-782`）。且 `send_message` 与反向 `postDm` 都能落进
DM 日志，**双向**可达。两条断言已固化在团队回合域用例里，配合 `test` 的跨后端往返切片构成 P0-4 的正向网。

## 2. 代码级事实

| 事实 | 位置 |
|---|---|
| `createBridge` 按 `room === undefined` 二选一：`teamTools` 或 `[...teamTools, ...roomTools]` | `src/rob/team.ts:775-782` |
| room 来自 `beginTurn` 的 `this.roomTurns.get(rob)?.room`（pending room turn 才有） | `src/rob/team.ts:653-659` |
| `teamTools` = `send_message` + `delegate` | `src/rob/tools.ts:146-186` |
| `roomTools` = 仅 `room_reply`，绑死单房间、回合外不注入 | `src/rob/tools.ts:193-215` |
| `send_message` 经 `createTeamOperations.sendMessage → team.postDm` 计数并投递 | `src/rob/tools.ts:60-65`；`src/rob/team.ts:671-684` |
| 反向 DM 由 `postDm` 落到同一日志 | `src/rob/team.ts:671-684`（`this.dms.push` + `emit({kind:"dm"})`） |

## 3. 测试证据（本次实跑）

```
npx vitest run test/rob/team-rooms.test.ts
✓ test/rob/team-rooms.test.ts (11 tests) 105ms

npx vitest run test/rob          # 全仓 rob 目录回归
✓ Test Files 22 passed (22)
✓ Tests 245 passed (245)
```

新增两条（`test/rob/team-rooms.test.ts:614,657`）：

1. **binds room_reply to the room turn only, never a DM-only turn**
   - DM-only：`await team.beginTurn("planner", host)` → `bridge.tools` 含 `send_message`/`delegate`、**不含** `room_reply`；
   - room turn：同一 rob 起真房间跑完后，`providers.planner.requests[0].tools` 含 `room_reply` + `send_message` + `delegate`。
   - 断言逐回合（同一 rob 两种回合），正反两面都覆盖：既证明 room 回合**有**、也证明 DM 回合**无**。
2. **relays a DM and its ack in both directions**
   - 取真桥接对象上的 `send_message.execute({to:"builder",text:"ping"})` → `ok:true`；
   - 反向 `team.postDm("builder","planner","ack")` → `queued`；
   - `team.readDms()` 顺序为 `["planner->builder:ping","builder->planner:ack"]`。
   - 用**真桥接对象**（team 建的 bridge，非手写 stub），工具名/契约漂移会直接失败。

### 有效性校验（翻转断言）

把 DM-only 那条从 `expect(dmTools).not.toContain("room_reply")` 改成 `toContain(...)` 复跑
→ **1 failed**，说明断言确实在读 bridge 真实输出、非恒真。已还原（11/11 绿）。

## 4. Live 佐证（跨 rob DM 往返）

本轮真机验证（非单测）：`dmtest → test` 发 DM 探针送达，`test → dmtest` 回 ack 送达，
**双向闭合**。叠加本文件单元层（`team-rooms` 11/11、`team` 16/16、`inbox` 3/3）与
`test` 的跨后端切片 `verification/dm-roundtrip-cross-backend.md`（3/3 绿），P0-4 DM 侧
「契约网 + live 依据」齐备。

## 5. 边界与未覆盖（诚实声明）

- 本切片只覆盖 **Team 域契约**（bridge 工具集 + DM 日志双向），**不**覆盖各后端子进程往返——
  那归 `test`（`team-dm-roundtrip.test.ts`，跨后端）与 `pi-test`（`cli-backend-team-tools-gap.test.ts`，`--tools`/`--extension`）。
- DM 预算边界（`DM_LIMIT_PER_RUN`、`turn_limit` 拒绝路径）不在本切片，`test/rob/tools.test.ts` 已覆盖 `createTeamOperations`。
- `delegate` 深度边界（`MAX_DELEGATE_DEPTH=1`）按 leader 分工不重复，避免与 `tools.test.ts` 重叠。
- 过期用例 `cli-backend-team-tools-gap.test.ts` 的同名历史红点已由 `pi-test` 重写收口，与本切片无重叠。
