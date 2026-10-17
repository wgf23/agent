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

### FR-4 rnd 扩员 + 协调者改为 manager（2026-10-17 用户改判）
rnd 最终成员 = `manager, pm, architect, ui, dev, qa, review, ci`（8 人），**coordinator = `manager`**。

用户原话：「现在需要领导变成 manager，pm 只需要拆封需求，判断需求是否合理之类的产品工作即可」。

⇒ **本条推翻此前 pm 的裁决（coordinator 保持 pm）**。变更理由：
1. 用户明确要求「领导」= manager，coordinator 就是房间里的领导角色（决定发言顺序收尾、写交付物）；
2. pm 职责收窄为**需求/产品**：拆解需求、判断合理性、写 PRD 与 AC、访谈用户；**不承担调度、不汇总团队结论、不决定谁做什么**；
3. `my-agent.json` 种子（coordinator=manager）与 ledger（当前 pm）必须在同一次运维里对齐到 `manager`，禁止两个口径。

### FR-7 角色边界（随 FR-4 生效）
- `manager`：对外接口、调度、汇总团队结论与风险、给用户下一步。**新增：房间 coordinator**。
- `pm`：需求阶段 —— 澄清目标与范围、判断需求是否合理、写 PRD 与验收标准到 `docs/prd/`；**不再承担协调者职能**，不写代码、不推代码。
- 两者职责不重叠：manager 决定「谁做」，pm 决定「要做什么、做到什么程度算完成」。

### FR-5 ppp 解散 + 清 bot
删除 ppp（ledger 无 DELETE 接口，只能删 ledger 文件）与其中 6 个 bot 的持久化状态（`test`、`pi-test`、`opencode`、`dmtest`、`aaa`、`leader`），并从 `my-agent.json` 的 `robs` 中移除。
**删除前必须备份**（见 AC-7）。

**`leader` 去留裁定（2026-10-17，随 FR-4 生效）**：**删**。理由：用户已把「领导」角色交给 `manager`，`leader` bot 与 `manager` 功能重叠且只在待解散的 ppp 里；保留会造出两个「领导」。其 memory/usage 靠 AC-7 备份保全，需要时可从 `backup-<ts>/` 取回。

### FR-6 时序硬约束
房间每次变更都会把内存状态整份写回 ledger。顺序固定为：
1. 代码改完 → `pnpm build`（刷新 `dist/`，运行中的是 dist）；
2. **停 serve** → 改 `my-agent.json`、`rnd.json`、删 `ppp.json`、备份并删 `bots/*.json`；
3. 启动 serve → 只读核对。
不得反向操作，否则造出「8 人房间 + 上限 6」的不一致态。

## 3. 验收标准（AC）

- **AC-1** `ROOM_MAX_MEMBERS === 20`（`src/rob/room-limits.ts`），`ROOM_MIN_MEMBERS === 2` 不变；`room.ts` 的 re-export 指向同一值。
  - **取值锚（裁决 ①）**：必须有**且仅有**一条字面量断言钉死取值，放在 `test/rob/room.test.ts`，形如 `expect(ROOM_MAX_MEMBERS).toBe(20)`，注释写明「AC-1 取值锚：此处故意写字面量；单靠派生会让改回 6 静默通过」。
  - 理由：其余用例全部由常量派生 ⇒ 谁把常量改回 6，全量仍绿（qa 探针 C 实证），「单一真值」在取值上是空的。
  - **因此变异探针 A 的期望改为：常量 20→21 时，只有取值锚这 1 例红**；若红的不止 1 例，说明别处仍有硬编码字面量，判红。
- **AC-2** 边界：19 人通过、20 人通过、21 人拒绝且 `reason === "member_count"`；1 人拒绝、2 人通过。
  - **入口覆盖（2026-10-17 终裁）**：`createRoom` / `setMembers` / API 三条入口共用 `validateRoomMembers` 同一校验器，边界判定以该函数为准（不在每个入口重复断言 19/20/21）。
  - **另需一条 `createRoom` 20 人正例**：证明「上限提升后真的能建出 20 人房间」，即用户价值端到端成立。评审实测（review @89e9a12）：20-过/21-拒目前只在 `validateRoomMembers` 一级，`createRoom`/`setMembers` 只有 too-few 侧，故补此一条。本条**非阻塞**，可与运维动作并行。
- **AC-3** `member_count` 提示串由常量派生（`` `A room needs ${ROOM_MIN_MEMBERS} to ${ROOM_MAX_MEMBERS} members.` ``），当前取值 = `"A room needs 2 to 20 members."`。
  - **取证必须成对**：① 单改常量 20→21 ⇒ 全绿（测试期望也派生，会一起移动，**单臂恒绿，不构成证据**）；② 常量 21 **且** 把源码分支改回不含 `${}` 的字面量 ⇒ **必须红**（qa 实测 2 files / 2 failed）。B 绿 ⇒ `member_count` 未派生，缺陷在源头。
- **AC-4** `RoomView.limits.maxMembers` 由常量派生（`src/rob/room.ts:507`），经 API 透传。
  - **现状修正（qa 实测）**：`web/src/**` 根本不引用 `limits` / `maxMembers`，前端不展示上限 ⇒ 「前端只读 API 值」属**空转满足，不得记为已验证 UI 展示 20**。
  - 本 AC 判据收敛为两条：① `src/serve/**` 原样透传（有断言则断言，`test/serve/team.test.ts` 已覆盖）；② `web/src/**` 无硬编码 6/20 上限字面量（grep 零命中）。
- **AC-5** 测试 fixture 一律 `import { ROOM_MAX_MEMBERS }` 派生，禁止写死数字；机械判据（review 执行）：
  - `grep -rn "ROOM_MAX_MEMBERS" src test web` 是唯一数字源；
  - `grep -rn "maxMembers: [0-9]\|to 6 members\|to 8 members\|to 20 members" src test web` 无命中；
  - **该 grep 不豁免任何行**：AC-1 取值锚写作 `expect(ROOM_MAX_MEMBERS).toBe(20)`，**不匹配**上述模式，故上述 grep 必须**零命中**（dev 实跑确认）。白名单条款作废。
  - 取值锚另用独立判据：`grep -rn "toBe(20)" test` 应**恰 1 行**（`test/rob/room.test.ts` 的 `pins the member cap`）；2 行以上说明又冒出硬编码。
- **AC-6** `README.md` 与 `docs/rnd-team.md` 中房间人数表述与 20 一致；`docs/rnd-team.md` 中「上限从 6 提到 8」「新的 8 人成员表」「rnd 之前是 6 个成员」三句假话必须消除。**改这三句即可，不得顺手删改 ui/manager 的其它成果**（review 在 diff 里核）。
- **AC-6c** `docs/rnd-team.md` 房间 `rnd` 小节必须与 FR-4 口径一致（coordinator = **`manager`**）：
  - JSON 示例 `"coordinator": "pm"` → **`"manager"`**（注意：`178f052` 曾按旧裁决改成 pm，本次需改回）；
  - 「安静后由 coordinator（`pm`）收尾」→ `manager`；
  - 「你可以直接对房间说话；`@manager` 让它汇总调度」保留；
  - 发言顺序 `manager → pm → architect → ui → dev → qa → review → ci` 保留；`manager` 的入口/调度定位与权限约束**一字不删**。
  - **判据（带引号，避免误红）**：`grep -n '"coordinator"' docs/rnd-team.md` 必须是 `"manager"`；`grep -n 'coordinator（`manager`）' docs/rnd-team.md` 命中 1 行。裸词 `manager` 出现在发言顺序/`@manager` 属预期，**不判红**（dev 提醒的精度问题，采纳）。
- **AC-7** 运维动作可回滚：执行前把 `my-agent.json`、`~/.local/share/my-agent/rooms/-home-heiwa-my-agent/ppp.json`、`~/.local/share/my-agent/bots/{test,pi-test,opencode,dmtest,aaa,leader}.json` 备份到 `~/.local/share/my-agent/backup-<ts>/`；备份存在且非空。
- **AC-8** 重启后只读核对（不接受「改文件时说没问题」）：
  - `rnd.json.members` = 8 人且 coordinator = **`manager`**；API `GET /api/rooms` 的 `limits.maxMembers` = 20；
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
- `leader` 随 ppp 一并删除（已裁定），领导职能由 `manager` 承担；删除不可逆，只能靠 AC-7 备份取回 memory/usage。
- 上限提升只放宽校验，不改变任何在跑房间的行为；已存在的超限房间（若有）不会自动收敛。
