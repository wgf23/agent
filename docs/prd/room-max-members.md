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
  - **另需一条 `createRoom` 20 人正例**（已由 `b92afee` 落地于 `test/rob/team-rooms.test.ts`）：证明「上限提升后真的能建出 20 人房间」，即用户价值端到端成立。
  - **该用例的判别边界（勿误判为假绿，qa 两臂实证）**：
    - 探针 C2（常量静默改回 6，用例内一切派生）⇒ **仍绿**。这不构成缺陷：该用例证明的是「`createRoom` 跟着常量走、走到同一校验器」，**不证明取值是 20**；取值仍只由 `test/rob/room.test.ts:1462` 的取值锚钉住（AC-1）。
    - 探针 D（常量保持 20，但把 `src/rob/room.ts` 校验硬编码成 `> 6`）⇒ **该用例红**。它抓的是「校验器里存在独立小上限 / 旁路」这类真缺陷。
    - 结论：取值锚（管值）与该用例（管路径互通）**互补、不重叠**，两条都要；任何一方单独存在都不完整。
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
- **AC-8** 重启后只读核对（不接受「改文件时说没问题」）。取证载体 = **SSE `GET /api/events` 首帧 `hello`**（本仓**没有** `GET /api/rooms` 路由，实测返回 `{"error":"not found"}`，用它会假红）：
  - **① 进程已换**：重启后 `systemctl show -p MainPID --value my-agent` 与执行前不同（证明读的是新进程，不是老进程里的内存态）。
  - **② 成员表逐名相等**：`hello.rooms[]` 中 `name === "rnd"` 项，`members` **按集合逐名等于** `manager, pm, architect, ui, dev, qa, review, ci`（**不得只断言长度 8**——长度相等而名单错会漏），且 `coordinator === "manager"`。
  - **③ 上限**：同项 `limits.maxMembers === 20`。注意此项由常量派生，**即使成员表没迁也会是 20，不构成迁移证据**，只证明线上进程跑的是 cap-20 代码。
  - **④ 删除面**：`ppp.json` 不存在；6 个 bot 的 `bots/*.json` 不存在（逐个点名，且**不断言 `bots/` 总数**——`ui`/`manager` 首次发言后会各自新建 store，总数 6→8 属预期）；`my-agent.json.robs` 不再含这 6 个。
  - **⑤ 可写性**：`rnd.json` 能正常新增/移除成员（不再是只读死胡同）。
  - 判据之间**互不替代**：② 证迁移、③ 证代码、① 证新鲜度、④⑤ 证删除与可写。
- **AC-9** 回归：`test/rob/room-text.test.ts`、`test/rob/room.test.ts`、`test/rob/team-rooms.test.ts`、`test/serve/team.test.ts`、`test/serve/search.test.ts`、`test/web/state.test.ts` 全绿；全量 CI 由 ci 实跑报数。
- **AC-10** `scripts/room-members.mjs` **拒绝非法状态**（写入前置校验；对应 design §4 第 1 条）：
  - 给定 config 的 `rnd.members` 含一个**不在 `robs` 里**的名字 ⇒ `node scripts/room-members.mjs rnd` **exit ≠ 0**，且该房间 ledger 的**内容与 `mtime` 均不变**（不是"报错但也写了"）。
  - 给定 `coordinator` **不在 `members` 里** ⇒ 同上（exit ≠ 0、ledger 不变）。
  - `members` 含重复名，或含 `user`/`system` 这类保留名 ⇒ 同上。
  - `--dry-run` 走**同一套校验**：非法时 exit ≠ 0（不得 exit 0 + 只打印告警）；合法时 exit 0 且不写任何文件。
  - 校验必须发生在写 `.bak` / `.tmp` **之前**（非法时连 `.bak` 都不产生）。
  - **人数上限/下限必须从 `src/rob/room-limits.ts` 取**（正则读源码或等价单一来源），**禁止在 `.mjs` 里写死 `2`/`20`** —— 否则破坏 AC-5 的单值源。
  - **解析必须 fail-closed（对语义等价改写免疫）**：从 `src/rob/room.ts` 读 `RESERVED_ROOM_SPEAKERS` 时，把数组排版改成多行并加注释（元素值不变）后，脚本**仍须 exit ≠ 0 且不写盘**；不得因正则跨行匹配而解析出带注释残渣的元素、导致 `has("user")===false` 后放行。判据面：构造 Set 后对每个元素做形状断言（`^[a-z][a-z0-9-]*$`），不合法即 exit 1。
- **AC-11** `docs/rnd-team.md` **写明迁移时序**（对应 design §4 第 2 条）：
  - 判据用**内容级锚**，不锚措辞片段（锚短语 = 下一个人换个说法就误红，2026-10-17 已踩两次）：
    - `grep -n "systemctl stop my-agent" docs/rnd-team.md` 恰 1 行；
    - 该行位于「已有房间需要迁移」一节，且与 `node scripts/room-members.mjs` 用法**同节**。
  - 语义要求：必须表达「ledger 是进程内存态的落盘点，serve 在跑时房间写盘会整份覆盖脚本结果且不报错」这一因果链（覆盖/零报错两要素），而不只是出现「停 serve」几个字。
  - 取证须带被检文件的 sha 或 HEAD（本节两次结论都因文件在验证过程中被改而翻转过）。

## 4. 实现约束（防返工）

1. **不得制造运行时循环依赖**：`room.ts` 值导入 `room-text.ts`；因此 `room-text.ts` 不能反向值导入 `room.ts`。常量需抽到独立模块（如 `src/rob/room-limits.ts`），`room.ts` 保留 re-export 以免破坏既有导入方。
2. **不碰红线外的东西**：本线允许 `src/rob/room.ts` 与 `src/rob/room-text.ts`（本 PRD 显式签字）。仍零命中：`screenshots/**`、SSE 事件语义、`@` mention 规则。
3. **脚本入库口径按「是否被已提交文档引用」区分**（2026-10-17 裁决，修正原「一律不入库」）：
   - **`scripts/room-members.mjs` 必须入库**：`docs/rnd-team.md:73-80`（已在 `89e9a12` 提交）把它写成了房间迁移的标准做法。文档引用而仓库里没有 = 用户照文档做会 `MODULE_NOT_FOUND`，属真缺陷。它也只做「按 config 同步一个已存在房间的 `members`/`coordinator`/`updatedAt`、先写 `.bak`」，不是破坏性一次性脚本。
   - **真正的一次性破坏性运维脚本不入库**：本线实际执行的那支（备份 + 删 ppp + 删 6 个 bot store + kill serve）只在本地 `/tmp` 存在，不进 commit。
   - **`my-agent.json` / `*.bak-*` / `.playwright-mcp/` / `scripts/self-dev/` 永不入库**（本地运行态与工具残留）。
   - **`scripts/room-members.mjs` 入库前必须补两条**（2026-10-17 裁决，architect 提出、我核实成立）：
     a. **写入前置校验（fail loud）**：`members ⊆ config.robs` 且 `coordinator ∈ members`，不满足即 exit 1、不写盘。理由：该脚本裸 `JSON.parse(my-agent.json)`，**不过** `src/config/project-file.ts:95` 的 `validateRoomMembers`，若把 roster 外成员写进 ledger，下次启动会在 `src/rob/team.ts` 的 `seedState` 直接 `throw`（房间起不来），而脚本已经打印 `written`。**状态是权威的，写坏的代价远高于早退。**
     b. **`docs/rnd-team.md` 迁移段必须写明「先停 serve 再跑」**。理由：ledger 是进程内存态的落盘点，房间任一写盘会**整份覆盖**脚本结果且**无任何报错**——与 FR-6 的时序硬约束同源，不写就是文档级假绿。
4. **提交拆分**：代码与测试一个 commit（可再拆 room/ 与 fixtures），运维动作不进 commit。

## 5. 风险与已知行为

- 删除 bot 会连带删除其 `bots/<name>.json`（含 memory/usage/seq），**不可从 git 恢复**；仅能靠 AC-7 的备份。
- `leader` 随 ppp 一并删除（已裁定），领导职能由 `manager` 承担；删除不可逆，只能靠 AC-7 备份取回 memory/usage。
- 上限提升只放宽校验，不改变任何在跑房间的行为；已存在的超限房间（若有）不会自动收敛。
