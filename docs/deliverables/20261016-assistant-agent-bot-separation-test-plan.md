# 测试计划：交互型助手 Agent 与 Bot 分区分治（QA）

- 作者：rob `qa` ｜ 日期：2026-10-16
- 依据：PRD `docs/prd/assistant-agent-and-bot-separation.md`（confirmed，AC-1..AC-8）、设计 `docs/design/assistant-agent-and-bot-separation.md`（定稿，§2 纯函数契约 / §6 AC↔取证映射）
- 范围：`web/**` + `test/web/**`；**无 jsdom / @testing-library**（FR-9）；新增归类/分区/可见性逻辑一律纯函数化
- 计数口径：以 **vitest 实跑输出的 Tests 数**为准，**不沿用旧基线 159 文件 / 1405 用例**，也不做静态 grep 计数
- 全量须在干净 HOME 下跑（`HOME=/tmp/cleanhome`），否则 `test/config.test.ts`、`test/cli/run.test.ts` 两条 missing-key 为环境假失败（非回归）

> 注：设计 §6 的「`Regions.tabs`」为笔误，实为导出的 `REGIONS`（本计划按 `REGIONS` 落）。

---

## 1. 纯函数面（自动绿，落 `test/web/regions.test.ts`）

新模块 `web/src/regions.ts`（无 React/DOM、无新依赖）。测试 import `../../web/src/regions.js`，另 import `../../web/src/state.js` 的 `workspaceBot`/`robBots` 做同源断言。

夹具：最小 `BotInfo`（`name`/`kind`/`role`/`model`/`backend`），含一个 `kind:"workspace"`（助手）与若干 `kind:"rob"`；`ClientRoom` 最小夹具用于 `resolveSelection`。

### 1.1 `partitionBots(bots) -> { assistant, bots }`（AC-2）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| 无 workspace | 仅 robs `[r1,r2]` | `assistant===null`；`bots===[r1,r2]` |
| 仅 workspace | `[w]` | `assistant===w`；`bots===[]` |
| 混排保序 | `[r1, w, r2]` | `assistant===w`；`bots===[r1,r2]`（服务端顺序，**w 不在 bots**） |
| 空列表 | `[]` | `assistant===null`；`bots===[]` |
| 多 workspace（防御） | `[w1,w2]` | `assistant===w1`（首个）；`bots===[]` 不抛错 |
| **同源（AC-2 唯一护栏，设计 §6 加粗必测）** | 三态各测一遍：**无 workspace** / **仅 workspace** / **混排** | 每态断言 `partitionBots(bots).assistant === (workspaceBot(bots) ?? null)`；`partitionBots(bots).bots` 逐项 `=== robBots(bots)`（数组长度+元素引用） |

> 同源断言是硬性项：dev 若内联 `find`/`filter` 而非复用 `state` helper，则该断言必须存在，否则 AC-2「数据同源」无取证。

### 1.2 `resolveView(region, view)`（AC-1 纯函数半）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| 区域内原样 | `("assistant","chat")` | `"chat"` |
| 跨区域回落 | `("assistant","plaza"/"subagents"/"agents")` | `"chat"` |
| Bot 区保留四视图 | `("bots", v)`，v∈{chat,plaza,subagents,agents} | `v` 原样 |

### 1.3 `resolveSelection({region,selectedId,bots,rooms})`（AC-3 纯函数半）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| assistant 强制助手 | `region:"assistant"`，members 含 workspace | `{bot:assistant, room:null}`（忽略 selectedId/rooms） |
| assistant 无 workspace | `region:"assistant"`, 无 workspace | `{bot:null, room:null}` |
| assistant 忽略 room 选中 | `region:"assistant", selectedId=roomId` | `{bot:assistant, room:null}` |
| bots 选中 room | `region:"bots", selectedId=roomId` 存在 | `{bot:null, room:rooms[roomId]}` |
| bots 选中 rob | `region:"bots", selectedId=robName` | `{bot:rob, room:null}` |
| bots 未知 id 回落 | `region:"bots", selectedId="nope"`, bots 非空 | `{bot:bots[0], room:null}` |
| bots 无选中 | `region:"bots", selectedId:null`, bots 非空 | `{bot:bots[0], room:null}` |
| bots 空 roster | `region:"bots"`, bots=`[]` | `{bot:null, room:null}` |
| bots 空 roster + room 未知 | `selectedId="nope"`, rooms={} | `{bot:null, room:null}` |

### 1.4 `visibleRooms(region, rooms)`（AC-3）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| assistant 恒空 | `("assistant", [r1,r2])` | `[]` |
| bots 全量保序 | `("bots", [r1,r2])` | `[r1,r2]`（同一引用、顺序不变、不驻留） |
| bots 空 | `("bots", [])` | `[]` |

### 1.5 `REGIONS` / `defaultView(region)`

| 用例 | 期望 |
| --- | --- |
| REGIONS 顺序与默认入口 | `REGIONS[0].id==="assistant"`（默认进入助手，FR-1）；`REGIONS.map(id)===["assistant","bots"]` |
| 每项规格 | assistant：`label:"助手"`, `defaultView:"chat"`, `views:["chat"]`；bots：`label:"Bot"`, `defaultView:"plaza"`, `views:[chat,plaza,subagents,agents]` |
| defaultView | `defaultView("assistant")==="chat"`；`defaultView("bots")==="plaza"`；且等于对应 `RegionSpec.defaultView` |
| views ⊇ defaultView | 每个区域 `views.includes(defaultView)`（防越界空态） |

**自动用例估数**：≈ 30（分区 6 + resolveView 4 + 选区 9 + 可见性 3 + REGIONS/defaultView 5，具体以 dev 落码后实跑为准）。

---

## 2. 回归面（自动绿）

| AC | 取证 | 期望 |
| --- | --- | --- |
| AC-5 会话复用 | `test/web/sessions.test.ts` 全绿 | 新建/打开/重命名/删除/切换行为不变 |
| AC-7 既有能力 | `test/web/*` 全绿 + `test/rob/room-text*` 全绿 | 无回归 |
| AC-7 房间 @/名册 | `test/web/mention.test.ts`(32) + `test/rob/room-text-mention-boundary.test.ts`(5) | 13/13 AC 不回归（上一需求基线 4 files/82） |

**命令**：`npx vitest run test/web test/rob/room-text.test.ts test/rob/room-text-mention-boundary.test.ts`；全量 `HOME=/tmp/cleanhome npx vitest run`。

---

## 3. 人工 / 集成项（显式标注，**不计自动绿**，无 jsdom）

| AC | 为何不能自动测 | 手工步骤 |
| --- | --- | --- |
| AC-1 双区域入口 + 默认助手 + view 不回归 | 顶部 tab 渲染与切换是布局/交互 | 打开界面确认默认在**助手**区；点「Bot」切到 Bot 区、点「助手」切回；两区主区内容互斥替换；在 Bot 区依次进 `Bot 广场`/`子 Agent`/`Agents`/`对话` 均可达（view 不回归） |
| AC-3 界面无 rooms | 渲染层 | 助手区主区+侧栏均无任何房间/room 元素；切到 Bot 区房间恢复可见 |
| AC-4 子目录选择受限 + 面板根变化 | 依赖 `WorkspacePicker`/`FileTree` 交互 | 助手/两区打开文件面板选子目录：只能选工作区**内**的目录（工作区外不可打开）；选定后文件面板根随之变；服务端工作区根不变（刷新仍回默认助手、根不变） |
| AC-1 助手脱离 Bots 组 | 侧栏渲染 | 侧栏 `Bots` 组**不含助手**；`Bot 广场`无助手卡片；无「新建助手」入口（单助手） |
| AC-8 未引入 jsdom | 依赖面 | `test/web/**` 无 jsdom/@testing-library import；人工项已在本计划标注 |

---

## 4. 红线（AC-6，命中即红）

diff 只允许 `web/**` + `test/web/**`（+ 设计允许的可选 `web/src/state.ts` 纯类型参数放宽 `readonly BotInfo[]`，无行为变化）。

**禁止命中**：`shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`。

核对命令（dev commit 后、qa 复跑前）：
```
git diff --name-only <base>..HEAD
```
任一路径落在红线内即判红，报 leader/review。

---

## 5. 执行步骤（dev commit 后由 qa 落实）

1. dev 落步骤 1（`web/src/regions.ts`）+ 测试骨架并 commit/报范围。
2. qa 按 §1 补边界用例（纯函数，无 jsdom），落 `test/web/regions.test.ts`。
3. qa 实跑：聚焦 `test/web/regions.test.ts` + 回归面（§2）；全量 clean HOME。
4. 报**真数**（各文件 passed/total）+ 逐条 AC-1..AC-8 判定（绿/人工/红）+ 计数对账（新范围，不沿用 159/1405）。
5. 人工/集成项（§3）由 user/review 界面核对，不当绿报。

---

## 6. 计数与基线

- 新基线在 dev commit 后**实跑得出**，不预设、不沿用旧数。
- 纯函数新增 `test/web/regions.test.ts`（估 ~30）会抬高 `test/web/*` 与全量文件/用例数。
- 全量历史基线（仅参考，非本次判据）：159 文件 / 1405 用例（含上一需求 82）。
