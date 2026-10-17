# PRD：房间成员上限 6 → 20（含 rnd 扩员与 ppp 解散）

- 状态：**confirmed**（用户 2026-10-17 拍板：上限目标 **20**）
- 决策来源：用户原话「我需要room上限改成20人」；同批请求「把 ui 和 manager 也拉进来（rnd）」「解散另一个 room 并删除里面的 bot」
- 范围：`src/rob/room.ts`、`src/rob/room-text.ts`、测试 fixture、README/docs，以及一次性数据/运维动作
- 不做：不改 `@` mention 语义、不改协议字段、不改房间其它限额（轮次/消息数/队列）

## 1. 背景

`ROOM_MAX_MEMBERS = 6` 是房间成员的硬上限，`validateRoomMembers`（`src/rob/room.ts:331`）与 `RoomView.limits.maxMembers`（`:507`）都从它派生。当前 rnd 有 6 人，用户要求拉入 `ui`、`manager`（共 8 人），并把上限提到 20，为后续扩容留空间。

此前曾出现一份半截改动（源码 20、文案 20、fixture 8 三说并存，3 例红），已整笔回退。本 PRD 要求一次做齐，**禁止再次出现多源真值**。

## 2. 需求

### FR-1 单一真值
`ROOM_MAX_MEMBERS = 20` 是全仓唯一数字源。任何文案、提示串、fixture、README 都不得写出裸数字 20 或 6。

### FR-2 提示串派生
`renderRoomOutcome` 的 `member_count` 文案必须由 `ROOM_MIN_MEMBERS` / `ROOM_MAX_MEMBERS` 派生（模板拼接），不得保留 `"A room needs 2 to 6 members."` 这类字面量。

### FR-3 暴露面不变
`RoomView.limits.maxMembers` 继续由常量派生；web 端不得硬编码上限，UI 展示继续走 API 值。

### FR-4 rnd 扩员
rnd 最终成员 = `manager, pm, architect, ui, dev, qa, review, ci`（8 人），**coordinator 保持 `pm` 不变**。

裁决理由（2026-10-17 pm）：用户诉求是「把 ui 和 manager 拉进来」，属**加人**，未要求更换协调者。协调者决定谁在轮次间收尾写交付物，是行为变更，不在本次授权内。当前保存的房间状态 coordinator = `pm`，保持不变；`my-agent.json` 的种子须同步改成 `coordinator: "pm"`，避免 config 与 ledger 两个口径。若后续要让 manager 接管调度，另开需求。

### FR-5 ppp 解散 + 清 bot
删除 ppp（ledger 无 DELETE 接口，只能删 ledger 文件）与其中 6 个 bot 的持久化状态（`test`、`pi-test`、`opencode`、`dmtest`、`aaa`、`leader`），并从 `my-agent.json` 的 `robs` 中移除。
**删除前必须备份**（见 AC-7）。

### FR-6 时序硬约束
房间每次变更都会把内存状态整份写回 ledger。顺序固定为：
1. 代码改完 → `pnpm build`（刷新 `dist/`，运行中的是 dist）；
2. **停 serve** → 改 `my-agent.json`、`rnd.json`、删 `ppp.json`、备份并删 `bots/*.json`；
3. 启动 serve → 只读核对。
不得反向操作，否则造出「8 人房间 + 上限 6」的不一致态。

## 3. 验收标准（AC）

- **AC-1** `src/rob/room.ts` 导出的 `ROOM_MAX_MEMBERS === 20`；`ROOM_MIN_MEMBERS === 2` 不变。
- **AC-2** 边界：19 人通过、20 人通过、21 人拒绝且 `reason === "member_count"`；1 人拒绝、2 人通过。同时覆盖 `createRoom` / `setMembers` / API 三条入口中至少两条。
- **AC-3** `member_count` 提示串 = `"A room needs 2 to 20 members."`，且由常量派生：把常量临时改 21 则文案随之为 `2 to 21`（变异探针可验）。
- **AC-4** `RoomView.limits.maxMembers === 20` 由常量派生；`web/src/**` 无硬编码 6/20 的上限字面量（前端只读 API 值）。
- **AC-5** 测试 fixture 一律 `import { ROOM_MAX_MEMBERS }` 派生，禁止写死数字；机械判据（review 执行）：
  - `grep -rn "ROOM_MAX_MEMBERS" src test web` 是唯一数字源；
  - `grep -rn "maxMembers: [0-9]\|to 6 members\|to 8 members" src test web` 无命中（除变异探针外）。
- **AC-6** `README.md` 与 `docs/rnd-team.md` 中房间人数表述与 20 一致；`docs/rnd-team.md` 中「上限从 6 提到 8」「新的 8 人成员表」「rnd 之前是 6 个成员」三句假话必须消除。**改这三句即可，不得顺手删改 ui/manager 的其它成果**（review 在 diff 里核）。
- **AC-6b** 两处文案断言（`test/serve/team.test.ts` 的 `error: "A room needs 2 to 6 members."`、`test/rob/room-text.test.ts` 同一串）必须改为常量派生，**不得手改成 `"2 to 20"`**（否则下次改常量再次漂移）。
- **AC-7** 运维动作可回滚：执行前把 `my-agent.json`、`~/.local/share/my-agent/rooms/-home-heiwa-my-agent/ppp.json`、`~/.local/share/my-agent/bots/{test,pi-test,opencode,dmtest,aaa,leader}.json` 备份到 `~/.local/share/my-agent/backup-<ts>/`；备份存在且非空。
- **AC-8** 重启后只读核对（不接受「改文件时说没问题」）：
  - `rnd.json.members` = 8 人且 coordinator = `pm`（未变）；API `GET /api/rooms` 的 `limits.maxMembers` = 20；
  - `ppp.json` 不存在；6 个 bot 的 `bots/*.json` 不存在；`my-agent.json.robs` 不再含这 6 个；
  - `rnd.json` 能正常新增/移除成员（不再是只读死胡同）。
- **AC-9** 回归：`test/rob/room-text.test.ts`、`test/rob/room.test.ts`、`test/rob/team-rooms.test.ts`、`test/serve/team.test.ts`、`test/serve/search.test.ts`、`test/web/state.test.ts` 全绿；全量 CI 由 ci 实跑报数。

## 4. 实现约束（防返工）

1. **不得制造运行时循环依赖**：`room.ts` 值导入 `room-text.ts`；因此 `room-text.ts` 不能反向值导入 `room.ts`。常量需抽到独立模块（如 `src/rob/room-limits.ts`），`room.ts` 保留 re-export 以免破坏既有导入方。
2. **不碰红线外的东西**：本线允许 `src/rob/room.ts` 与 `src/rob/room-text.ts`（本 PRD 显式签字）。仍零命中：`screenshots/**`、SSE 事件语义、`@` mention 规则。
3. **不把一次性运维脚本入库**：`scripts/room-members.mjs` 等不进 commit。
4. **提交拆分**：代码与测试一个 commit（可再拆 room/ 与 fixtures），运维动作不进 commit。

## 5. 风险与已知行为

- 删除 bot 会连带删除其 `bots/<name>.json`（含 memory/usage/seq），**不可从 git 恢复**；仅能靠 AC-7 的备份。
- `leader` 也在 ppp 中，删除后团队不再有 leader 角色；如仍需 leader 请在执行前明示保留。
- 上限提升只放宽校验，不改变任何在跑房间的行为；已存在的超限房间（若有）不会自动收敛。
