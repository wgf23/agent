# 设计注记：房间成员上限 6 → 20（单一真值）

> 作者：rob "architect" ｜ 状态：定稿，可直接实现 ｜ 对应 PRD：`docs/prd/room-max-members.md`（confirmed，用户拍板 20）
>
> 本文只补 PRD 未钉死的**模块边界与取证点**，不重复 FR/AC。共 4 条，均为一句话契约。
> 锚点一律用「文件 + 逐字引句」，不写行号（行号会漂，见 `docs/design/bot-skills-and-mcp.md` §11.9）。

## 1. 常量落点：新增 `src/rob/room-limits.ts`（叶子模块）

- `src/rob/room-limits.ts` 导出 `ROOM_MIN_MEMBERS = 2`、`ROOM_MAX_MEMBERS = 20`，是**全仓唯一数字源**。
- **依赖方向单向**：`room.ts` 值导入 `room-text.ts`（现存的 `import { parseRoomMentions, ROOM_PASS_SENTINEL }`），因此 `room-text.ts` **不得值导入 `room.ts`**（它今天只有 `import type { ... } from "./room.js"`，`type` 导入编译后消失，不构成运行时边）。
  ⇒ 两边都值导入 `room-limits.ts`：`room.ts → room-limits.ts` 与 `room.ts → room-text.ts → room-limits.ts`，无环。
- `room.ts` **保留 re-export**（`export { ROOM_MAX_MEMBERS, ROOM_MIN_MEMBERS };`），既有导入方（`src/serve/**`、`test/**`）无需改动。
- 契约：`room-limits.ts` 不得 import 任何 rob 模块（保持叶子）；外部消费者优先从 `room.js` 导入（稳定面），`room-limits.ts` 视为内部模块。

## 2. 文案派生：`member_count` 禁止字面量

`src/rob/room-text.ts` 的 `renderRoomOutcome` 中 `case "member_count"` 必须写
`` `A room needs ${ROOM_MIN_MEMBERS} to ${ROOM_MAX_MEMBERS} members.` ``，
不得保留 `"A room needs 2 to 6 members."` 这类裸数字。AC-3 的变异探针（常量临时改 21 ⇒ 文案随之 `2 to 21`）依赖此写法。

## 3. 暴露面：`limits.maxMembers` 仍由常量派生，web 只读 API

`RoomView.limits` 已由 `minMembers: ROOM_MIN_MEMBERS` / `maxMembers: ROOM_MAX_MEMBERS` 构造，
值导入迁移后**语义不变**；`src/serve/team.ts` 原样透传 `limits: { ...view.limits }`。
⇒ **`web/src/**` 本线零改动**，前端不得出现上限字面量；UI 展示只读 API 值（AC-4 的判据）。
> 房间数据**只经 SSE `GET /api/events` 首帧 `hello` 下发**（`ServerEvent.type === "hello"` 的 `rooms: RoomInfo[]`）；没有 REST `GET /api/rooms`。所有「只读核对」必须照此取数。

## 4. 运维动作：按「是否被已提交文档引用」分三类

- **入库（可重复、非破坏性）**：`scripts/room-members.mjs`。`docs/rnd-team.md`（`89e9a12` 已提交）把 `node scripts/room-members.mjs rnd` 写成了房间迁移的标准做法，文档在库而脚本不在库 ⇒ 用户照做会 `MODULE_NOT_FOUND`。它只改一个**已存在**房间的 `members`/`coordinator`/`updatedAt`，先写 `.bak` 兄弟文件、保留 transcript、带 `--dry-run`，可重跑。
- **不入库（一次性、破坏性）**：本线实际执行的那支运维脚本（备份 → 删 `ppp.json` → 删 6 个 `bots/*.json` → `kill -9` serve → 由 systemd 拉起），只存在于本地 `/tmp`，进 commit 等于把"删数据"固化成仓库能力。
- **永不入库（本地运行态/工具残留）**：`my-agent.json`、`my-agent.json.bak-*`、`.playwright-mcp/`、`scripts/self-dev/`。
- 时序按 PRD FR-6：`build` → 停 serve → 改 config / ledger / 备份并删 `bots/*.json` → 启动 → 只读核对。
- **`room-members.mjs` 入库前须补两条（现脚本没有，属真缺口）**：
  1. **写入前置校验（fail loud）**：`members ⊆ config.robs` 且 `coordinator ∈ members`，不满足即 **exit 1、不写盘**。理由：脚本裸 `JSON.parse(my-agent.json)`，**不经过** `src/config/project-file.ts:95` 的 `validateRoomMembers`/`validateRoomCoordinator`；而 ledger 一旦写脏，**启动期不会拦住它**——`openRooms()`（`src/rob/team.ts:346`）在 ledger 存在时直接 `new Room({state})` 后 `continue`，**根本不走 `seedState`**（那只在"config 有房间、没有 ledger"的分支，`:367`），而这脚本的前提正是 ledger 已存在。真实后果是**静默降级而非启动失败**：
     - 房间照常启动、team 照常起来，**没有任何 throw**；
     - `hello.rooms[].members` / `Room.view().members` 仍把该名字算作成员 ⇒ **UI 列出一个永远不发言的成员**；
     - **每次 run**（一次发送/一次队列恢复各一次）`startRun()` 会追加**一条** system 记录 `No longer on the team: @<name>.`（`src/rob/room.ts:681-685` → `room-text.ts:172`，用例见 `test/rob/room.test.ts:947-965`）—— 这是唯一信号，且只在「被 @ 到」或「无 @ 的整房广播」时出现，**每次 run 至多一条**；
     - `participants()`（`src/rob/room.ts:738-746`）用 `host.members()`（= `this.robs.keys()`，`team.ts:196`）过滤，该名字被**剔除且不报错**，故它永不发言、也无 per-turn 失败；若整轮只 @ 了它，participants 为空 ⇒ `spokeThisRound === 0` ⇒ 该轮直接 `settled`（看起来像"讨论完了"）；
     - 启动期也没有补救：`configDrift` 不会报（脚本写完后 ledger == config），`setMembers` 走 `validateRoomMembers`（`room.ts:603`）只校验**新的**名单。
     ⇒ 结论：**写脏的代价不是"炸给你看"，而是"静默少一个人、无人察觉"**，所以校验必须在写 `.bak`/`.tmp` **之前**做（`--dry-run` 同样在早退前跑）。
  2. **文档写明「必须先停 serve 再跑」**：`~/.local/share/my-agent/rooms/<workspace-slug>/<room>.json` 是进程内存态的落盘点，房间任一写盘都会整份覆盖脚本的修改**且不报任何错**。顺序：停 serve → 跑脚本 → 启动。
- 分工边界：本线实际运维用 `/tmp` 那支脚本自行用 python 重写 ledger，**不调用 `room-members.mjs`**，两者无耦合 —— 改脚本不得去动 `/tmp` 里已冻结的那支。
- 设计侧不定义 ledger 的删除语义（无 DELETE 接口 = 删文件），也不改 SSE 事件与 `@` mention 规则。

## 5. 取证点（交 qa / review）

| AC | 取证方式 |
|---|---|
| AC-1/AC-2 | ① **取值锚**（AC-1 唯一允许的字面值）：`expect(ROOM_MAX_MEMBERS).toBe(20)`，全仓**有且仅有 1 处**；② 边界断言：19/20 通过、21 拒 `reason === "member_count"`、1 拒、2 通过 |
| AC-3 | **成对**变异探针（单探针无效，见下方注记）：常量改 21 **且** 把 `src` 文案硬编码回旧值 ⇒ 必须红 |
| AC-4 | ① `grep -rn "maxMembers" web/src` 无硬编码数字；② **`GET /api/events` 首帧 `hello`** 的 `rooms[]` 中 `name === "rnd"` 项：`limits.maxMembers === 20`（**没有 `GET /api/rooms` 这个路由**，房间数据只随 SSE `hello` 下行） |
| AC-5 | 测试 fixture `import { ROOM_MAX_MEMBERS }` 派生；`grep -rn "maxMembers: [0-9]\|to 6 members\|to 8 members" src test web` 零命中 |

> **AC-4 取证面（两条极易假绿的坑，leader 实测）**：
> ① **`limits.maxMembers` 验不出「8 人」**。它由 `ROOM_MAX_MEMBERS` 派生，与 ledger 内容无关——运维前（rnd 仍 6 人 / coordinator 仍 pm）量到的就是 `20`。
> ⇒ AC-4 只能证明「线上进程跑的是 cap-20 代码」；**成员表与 coordinator 必须另用 `hello.rooms[name==="rnd"].members` / `.coordinator` 逐名断言**（对应 AC-8），不得拿这个恒真值报绿。
> ② **只读核对必须落在重启后的进程上**，否则测的是旧进程（旧 dist 也是 20 口径，量出来一样绿）。前置断言：`systemctl show -p MainPID --value my-agent` 与运维前不同（**这是硬判据**），且 `dist/index.js` 内含 `ROOM_MAX_MEMBERS = 20`。`dist` 的 sha256（`1c7500a` 构建时为 `ccb2773a…`）只作**旁证记一笔**：本线源码定稿后它不该再变，但后续线会重建 dist，写死 sha 会误红——故不入 gate。
> 事件形状（`shared/protocol.ts` `RoomInfo`）：`{ name, members, coordinator, transcript, run, pending, deliverable, limits: { minMembers, maxMembers, maxRounds, maxMessagesPerRun, maxQueuedSends } }`。

> **AC-1 取值锚 vs AC-5「禁裸数字」不是冲突，是白名单**（qa 探针 C 逼出的缺口）：
> 全仓**只允许 1 行**出现上限字面值 —— `test/rob/room.test.ts` 的 `expect(ROOM_MAX_MEMBERS).toBe(20)`。
> 理由：fixture 与文案全派生后，把常量静默改回 6 **不会让任何用例红**（探针 C 曾在 `b33a71c` 上 118 全绿）。
> 取值锚就是把「值」这一维重新钉住；它的存在**不违反 AC-5**，AC-5 禁的是「派生出多条真值」。
> 判据（三臂，均在隔离目录跑、跑完还原）：A' 常量→21 ⇒ **恰好 1 红**（该锚）；B 常量 21 + 文案硬编码 ⇒ 红（含该锚）；C' 常量→6 ⇒ **恰好 1 红**（该锚）。
> A'/C' 红超过 1 例 ⇒ 别处还有硬编码，AC-5 未真正达成。

> **通则（本线最容易假绿的一族）**：凡「测试期望值也由同一常量派生」的断言，单变异探针恒绿——常量一动，源码与期望一起动。证明派生必须**成对变异**：常量变异 + 把被测源码改回硬编码。下文 AC-3 是唯一适用点，同类断言以后照此办。

> **AC-3 的探针必须成对，单探针无法证明派生**（pm 实测，本线最易假绿的形态）：
> 只把常量改成 21 时，**源码文案与测试期望串同为派生**，两者一起移动、永远相等 ⇒ 探针恒绿。
> 因此探针 B 必须同时施加两个变异：**常量 = 21** **且** 把 `src/rob/room-text.ts` 的 `member_count` 分支改回硬编码旧值（任何不含 `${}` 的字面量）⇒ 此时必须红。
> 判据：B 绿 ⇒ `member_count` 不是派生的（缺陷在源头，不是测试）；B 红 ⇒ AC-3 有牙。
> 实测记录（pm，跑完已还原、sha256 前后一致）：A（仅常量 20→21）= 3 文件 69 用例全绿；B（常量 21 + 文案硬编码）= 2 文件 2 用例红。

> ~~AC-5 现存未清点：`test/serve/team.test.ts` / `test/rob/room-text.test.ts` 的 `"2 to 6 members"`~~ —— **已由 `ec52ed0` 清为派生态**，`grep -rn "2 to 6 members\|needs 2 to" src test web README.md docs/rnd-team.md` 现零命中。保留此条仅作历史记录。

> **AC-2 的边界用例必须自身可判别**：
> `validateRoomMembers` 的校验顺序是 **人数 → 保留名 → 重复 → 是否在 roster**（`member_count` 在函数第一行，逐成员再查 reserved/duplicate/unknown）。因此：
> ① **「满员（`ROOM_MAX_MEMBERS`）判 ok」这条需要上界+1 的超集 roster**（`memberNames(ROOM_MAX_MEMBERS + 1)`），否则名单不全时会被 `unknown_member` 提前打断，造成**假红**；
> ② **「超限判拒」这条由人数校验先命中，与 roster 大小无关**，故它必须同时钉 `reason === "member_count"` —— 只断言 `status === "rejected"` 是**假绿**（任何拒因都能过）；
> ③ 下界用例同款：roster 至少覆盖被测名字（`memberNames(ROOM_MIN_MEMBERS)`）。
> 三断言共用一个 roster，最省心的取法是上界+1 的超集。
> ⛔ **不得为了对齐这段文字去改 `validateRoomMembers` 的校验顺序**——顺序一变，`member_count` 用例的语义随之翻转（21 人将被 `unknown_member` 抢先）。
> 实测（qa，隔离目录）：21 个未知名 vs roster `["ui"]` ⇒ `member_count`；8 个（7 真实 + 1 ghost）vs 7 人 roster ⇒ `unknown_member`。

## 6. 已闭环的三条（此处只留结论，不再讨论）

- **coordinator = `manager`**（**2026-10-17 用户改判，覆盖 pm 早前「coordinator 保持 pm」的裁决，该裁决作废**）。
  用户原话：「现在需要领导变成 manager，pm 只需要拆封需求，判断需求是否合理之类的产品工作即可」。
  ⇒ rnd 8 人、coordinator=`manager`；`my-agent.json` 种子与 `rnd.json` ledger **必须在同一次运维里对齐到 `manager`**，禁止两个口径（PRD FR-4/FR-7）。
- **角色边界**：`manager` = 对外接口 + 调度 + 汇总 + 房间 coordinator；`pm` = 需求与产品（澄清、判断合理性、写 PRD/AC），**不再当协调者**。`leader` 随 ppp 删除，领导职能归 `manager`。
- **`docs/rnd-team.md` 的假话由 dev 按 AC-6/AC-6c 改**（「上限从 6 提到 8」类文案 + `"coordinator"` 目标值为 `manager`），属文档同步，不是设计决策。
  ⚠️ `178f052` 曾按旧裁决把它写成 `pm`，**本线需改回 `manager`**；复核按 `manager` 判，不按历史提交判。

## 7. 未闭合边界

- **已清空**（`leader` 去留已裁定：删，随 ppp 一并处理）。仅留一条运维提醒：删 bot 不可逆（含 `leader` 的 memory/usage/seq），取回路径 = PRD AC-7 的 `~/.local/share/my-agent/backup-<ts>/`；执行前须确认备份非空，重启后按 AC-8 只读核对。
