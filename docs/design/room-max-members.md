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

## 4. 运维动作：不入库、不改房间语义

- 一次性脚本（`scripts/room-members.mjs` 等）**不进 commit**；`my-agent.json` / `*.bak-*` 是 untracked 本地配置，不进 commit。
- 时序按 PRD FR-6：`build` → 停 serve → 改 config / ledger / 备份并删 `bots/*.json` → 启动 → 只读核对。
- 设计侧不定义 ledger 的删除语义（无 DELETE 接口 = 删文件），也不改 SSE 事件与 `@` mention 规则。

## 5. 取证点（交 qa / review）

| AC | 取证方式 |
|---|---|
| AC-1/AC-2 | 从 `room.js` 导入常量做边界断言（19/20 通过、21 拒 `reason === "member_count"`、1 拒、2 通过） |
| AC-3 | **成对**变异探针（单探针无效，见下方注记）：常量改 21 **且** 把 `src` 文案硬编码回旧值 ⇒ 必须红 |
| AC-4 | `grep -rn "maxMembers" web/src` 无硬编码数字；`GET /api/rooms` 的 `limits.maxMembers === 20` |
| AC-5 | 测试 fixture `import { ROOM_MAX_MEMBERS }` 派生；`grep -rn "to 6 members\|to 8 members" src test web` 零命中 |

> **通则（本线最容易假绿的一族）**：凡「测试期望值也由同一常量派生」的断言，单变异探针恒绿——常量一动，源码与期望一起动。证明派生必须**成对变异**：常量变异 + 把被测源码改回硬编码。下文 AC-3 是唯一适用点，同类断言以后照此办。

> **AC-3 的探针必须成对，单探针无法证明派生**（pm 实测，本线最易假绿的形态）：
> 只把常量改成 21 时，**源码文案与测试期望串同为派生**，两者一起移动、永远相等 ⇒ 探针恒绿。
> 因此探针 B 必须同时施加两个变异：**常量 = 21** **且** 把 `src/rob/room-text.ts` 的 `member_count` 分支改回硬编码旧值（任何不含 `${}` 的字面量）⇒ 此时必须红。
> 判据：B 绿 ⇒ `member_count` 不是派生的（缺陷在源头，不是测试）；B 红 ⇒ AC-3 有牙。
> 实测记录（pm，跑完已还原、sha256 前后一致）：A（仅常量 20→21）= 3 文件 69 用例全绿；B（常量 21 + 文案硬编码）= 2 文件 2 用例红。

> AC-5 现存未清点（本次实跑 grep，随代码同步清）：`test/serve/team.test.ts` 的 `error: "A room needs 2 to 6 members."`、`test/rob/room-text.test.ts` 的 `"A room needs 2 to 6 members."`。两处都改成由常量派生（或断言 `renderRoomOutcome` 的输出），不得手改成 `2 to 20` 字面量——否则下次改常量又漂。

> **AC-2 的边界用例必须自身可判别（否则测的是 `unknown_member`，不是 `member_count`）**：
> `validateRoomMembers` 的成员名校验先于人数校验，若 roster 小于被测成员列表，超限用例会先命中 `unknown_member` 而**假红/假绿**。
> 契约：`const roster = memberNames(ROOM_MAX_MEMBERS + 1)`（**上界 + 1 的超集**），三个断言共用同一个 roster；
> 且超限断言必须同时钉 `reason === "member_count"`，不得只断言 `status === "rejected"`。
> 同理，`ROOM_MIN_MEMBERS - 1` 的下界用例其 roster 也只能取 `memberNames(ROOM_MIN_MEMBERS)` 之上的名字。
> 判据：把常量临时改小/改大，超限用例应随之仍然 `member_count`（不是 `unknown_member`）。

## 6. 已闭环的两条（pm 已裁，此处只留结论）

- **coordinator 保持 `pm`**（pm 终裁）：本次授权是「加人」，不是换协调者；`rnd.json` 8 人 + coordinator=`pm`，`my-agent.json` 种子同口径。设计侧不另立规则。
- **`docs/rnd-team.md` 的三句假话由 dev 按 AC-6 改**（如「上限从 6 提到 8」），属文档同步，不是设计决策。

## 7. 未闭合边界

- 删 bot 不可逆（含 `leader` 的 memory/usage/seq），是否保留 `leader` 待用户一句话；未定前不动数据。设计侧不裁运维取舍，只要求按 PRD AC-7 备份、AC-8 重启后只读核对。
