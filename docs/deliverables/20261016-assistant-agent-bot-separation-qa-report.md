# QA 报告：交互型助手 Agent 与 Bot 分区分治

- 作者：rob `qa` ｜ 日期：2026-10-16
- 提交范围（base..HEAD）：**`0f640ec..a063851`（6 笔 / 6 文件）**
  - `f5fd847` `web/src/regions.ts` 纯函数模块 + `state.ts` 参数放宽 + `regions.test.ts`(16)
  - `9e85585` `web/src/App.tsx` 顶部 region tab / 分区渲染
  - `f957956` `web/src/components/Sidebar.tsx` 分区
  - `b8a6e4f` `web/src/styles.css` `.region-tabs`
  - `c466035` `test/web/regions.test.ts`（+9 边界，test-only，16→25）
  - `a063851` `web/src/App.tsx`：lint 必需修复（`c466035` 遗留 3 个 `useExhaustiveDependencies` error），**不改行为、不改测试计数**
- 依据：PRD `docs/prd/assistant-agent-and-bot-separation.md`（AC-1..AC-8）、设计 `docs/design/assistant-agent-and-bot-separation.md`（§2 契约 / §6 取证映射）
- 计数口径：**vitest 实跑 Tests 数**，不沿用旧基线；全量在**干净 HOME** 下跑

---

## 1. 真数（在最终 HEAD `a063851` 上独立复跑）

| 套件 | 结果 |
| --- | --- |
| `test/web/regions.test.ts` | **25 / 25 passed** |
| 回归 `test/web` + `test/rob/room-text*` | **15 files / 161 passed** |
| 全量（`HOME=$(mktemp -d)`） | **160 files / 1430 passed**，0 failed |

- 对比基线 `f5fd847`（实测：regions **16**、回归 **15 files/152**）：本次 regions **+9**（16→25）、回归 **+9**（152→161）。全量按同一 +9 递增为 160/1430（文件数不变）。
- 本机不设干净 HOME 时 `test/config.test.ts`、`test/cli/run.test.ts` 两条 missing-key 为**环境假阳性**（本机 `~/.config/my-agent/credentials.json` 有真 key），非回归；干净 HOME 下 0 失败。
- 如实记录：全量首跑曾有一次 `test/skills/install.test.ts > addSkill rollback`（5s 超时）失败，**隔离复跑 12/12 绿、全量复跑 160/1430 绿** → 判定为**与本线无关的时序 flaky**（该文件不在本线 diff，App.tsx 改动不涉其逻辑）。

---

## 2. 纯函数面（自动绿）

`test/web/regions.test.ts` 25 例，覆盖设计 §6 的 AC-1/AC-2/AC-3 纯函数半：

- **AC-1**：`REGIONS[0].id==="assistant"`（默认助手）、`defaultView("assistant")==="chat"`/`("bots")==="plaza"`、`resolveView` 区域内保留 + **跨区回落**（assistant 下 plaza/subagents/agents 全→chat）、`views ⊆` 可渲染集。
- **AC-2**：`partitionBots` 拆分正确（`assistant.kind==="workspace"` 且**不在** `bots`）；**同源三态**（`[]`/`[ASSISTANT]`/`ROSTER`）逐项 `===` `state.workspaceBot/robBots`；多 workspace 防御（首个 assistant）；乱序保序；空 roster 不抛错。
- **AC-3**：`visibleRooms("assistant", rooms|[])==[]`；`visibleRooms("bots", rooms)` 全量保序；`resolveSelection({region:"assistant"}).room===null`；**互斥不变量**——`resolveSelection({region:"bots",selectedId:<助手名>}).bot?.kind!=="workspace"` 且必回落首个 rob。
- 附加：`resolveSelection` 未知 id→`bots[0]`、空 roster→null、room 与 rob 同名→room 优先。

---

## 3. 逐条 AC 判定

| AC | 判定 | 取证 |
| --- | --- | --- |
| AC-1 双区域入口存在且可切换、默认助手、view 不回归 | **人工/集成**（纯函数半绿） | `REGIONS`/`defaultView`/`resolveView` 25 例内绿；tab 渲染/切换/默认助手/view 路径不回归 = 界面（FR-9 无 jsdom，不计自动绿） |
| AC-2 助手归类正确、同源 | ✅ **自动绿** | `partitionBots` 同源三态断言（与 `state.workspaceBot/robBots` 逐项一致） |
| AC-3 助手区不含 rooms | ✅ **自动绿**（+人工半） | `visibleRooms assistant→[]`；`resolveSelection assistant→room:null`；互斥不变量。界面层面「助手区无 rooms」= 人工/集成 |
| AC-4 工作区（子目录）选择受限 | **人工/集成**（复用纯函数面绿） | 复用 `canOpen`/`relFromWorkspace` 现有纯函数；面板根变化/服务端根不变 = 界面 |
| AC-5 会话复用回归 | ✅ **自动绿** | `test/web/sessions.test.ts` 全绿（含于回归 15 文件/161） |
| AC-6 零协议变更（红线） | ✅ **自动绿（红线核对）** | 见 §4 |
| AC-7 既有能力回归 | ✅ **自动绿** | `test/web/*` + `test/rob/room-text*` 全绿；房间 @/名册 13/13 不回归 |
| AC-8 可测性达标 | ✅ **自动绿** | `regions.ts` 纯函数有 25 例单测；未引入 jsdom；人工项已在本报告标注 |

**人工/集成条目（不计自动绿，需界面核对）**：
1. AC-1：顶部「助手」「Bot」两入口渲染 + 切换互斥替换 + 默认进入助手；
2. AC-1：Bot 区 `对话`/`Bot 广场`/`子 Agent`/`Agents` 四视图仍可达（view 不回归）；
3. AC-1：侧栏 `Bots` 组不含助手、Bot 广场无助手卡片、无「新建助手」入口（单助手）；
4. AC-3：助手区主区+侧栏均无任何 room 元素；
5. AC-4：子目录选择只允许工作区内目录、选定后面板根随之变、服务端工作区根不变。

---

## 4. 红线（AC-6）

```
git diff --name-only 0f640ec..a063851
```
范围 **6 文件**：`web/src/regions.ts`（新）、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/styles.css`、`test/web/regions.test.ts`、`web/src/state.ts`（纯类型放宽 `readonly BotInfo[]`）。

**禁止命中项零命中** ✅：`shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**` 均未触及。

---

## 5. 结论

- 范围 `0f640ec..c466035`：**聚焦 regions 25/25**、回归 **15 files/161**、全量 clean HOME **160 files/1430**，**无回归**。
- AC-1/2/3/5/6/7/8 自动化面绿；AC-1/3/4 的**布局/切换/界面**部分为人工/集成（FR-9 无 jsdom），已显式列出（§3）。
- qa 未改源码；本次仅测试文件与报告。**未 commit、未 push**（test-only commit 由 dev 落 `c466035`，交由 review→ci→leader 放行）。
