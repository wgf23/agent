# PRD（confirmed）：交互型助手 Agent 与 Bot 分区分治

- 状态：**confirmed**（用户已拍板 Q1–Q7，Q5/Q8 由 Q3 复用口径直接推定，见 §4）
- 提出人：用户（房间 `rnd`）
- 承接 / 定稿：pm ｜ 日期：2026-10-16
- 影响面：**仅 `web/**`**（呈现与布局）；**不新增协议字段、不改服务端**（见 FR-7）
- 前置依赖：`docs/design/*`（architect 出）+ `docs/deliverables/*-test-plan.md`（qa 出）

---

## 1. 用户诉求

> **原话**：「assistant 不应该是一个 bot，应该是一个传统的交互型 agent，可以选择工作区和 session。和 bot 分别在两个区域。」

**确认后的解读**：把「助手」从 Bot 概念与 UI 组里**独立**出来，做成一处常规交互式（聊天式）Agent 区域，可选择工作区（子目录）与会话；Bot 相关（广场 / 房间 / DM / 子 Agent）集中到另一区域。

---

## 2. 用户拍板（本需求的范围基线）

| # | 问题 | **裁决** |
| - | --- | --- |
| Q1 | 「选择工作区」语义 | **②工作区内子目录切换**（复用现有 `WorkspacePicker` / `WorkspaceBrowser` 语义：只能打开工作区内的目录） |
| Q2 | 「两个区域」形态 | **③顶部 tab 两页**（「助手」/「Bot」两个区域，切换主区内容） |
| Q3 | 助手是否为现 `kind:"workspace"` bot 的改造 | **复用**（同一实体，只改呈现与归类，不新建 agent 数据结构） |
| Q4 | 助手数量 | **单助手**（全局唯一；不提供「新建助手」入口） |
| Q5 | 会话管理复用深度（由 Q3 推定为复用） | **复用现有会话能力**（`state.sessions`/`activeSessionId`，新建/打开/重命名/删除/切换） |
| Q6 | 范围 | **只做 Web** |
| Q7 | Bot 区保留内容 / 房间归属 | **房间归 Bot 区**；助手区不得出现 rooms |
| Q8 | 迁移与回归（由 Q3「复用」推定） | **无数据迁移**：现有 workspace 助手的会话、transcript、文件面板状态原地保留、不重置；仅做呈现层重组 |

> 说明：Q5/Q8 用户未逐条作答，按 Q3「复用」的同一口径直接推定（不新建实体 ⇒ 会话整套沿用、无迁移）。若与预期不符请回抛，pm 改 PRD。

---

## 3. 现状证据（读码确认，leader/review 已复核）

- 助手 = `kind:"workspace"` 的 bot：`web/src/state.ts:167` `workspaceBot()`；`robBots()`（`:171`）取 `kind==="rob"`。
- 今天它在侧栏 **「Bots」组**：`web/src/components/Sidebar.tsx:177` `{[workspace, ...robs].map(...)}`；Bot 广场只收 `robs`（`App.tsx:196`），故广场没有它、但侧栏有。
- 助手**已跳过 bot 专属 tab**：`App.tsx:293` 仅 `selectedRob !== undefined` 时显示「对话/记忆/唤醒/设置」。
- 工作区根**启动期定死**：`web/src/state.ts:72` ← 服务端 `hello`（`:330`）；`src/cli/config.ts:12` `workspaceRoot: options.workspaceRoot ?? process.cwd()`。`WorkspacePicker.tsx` 注释明写 root「fixed for the life of the run」→ **Q1=2 只需复用，不新增协议**。
- 会话能力现成：`state.sessions` + `state.activeSessionId`（`state.ts:79`），侧栏「历史会话」区（`Sidebar.tsx:228+`），动词 `hub.newSession/openSession/renameSession/deleteSession`。
- 现有导航 `View = "chat" | "plaza" | "subagents" | "agents"`（`Sidebar.tsx:20`）。

---

## 4. 目标与非目标

### 目标
- 助手从 Bot 概念/UI 组中**独立**，成为一处交互型 Agent 区域。
- 助手区支持**工作区（子目录）选择**与**会话选择/管理**（复用现有）。
- Bot（广场 / 房间 / DM / 子 Agent）集中到**另一区域**，与助手在导航与视觉上分开。

### 非目标
- 不改 Bot 多 agent 编排语义；不删 Room/Plaza/DM 功能。
- **不新增/修改协议**（`shared/protocol.ts` 不动）、**不改服务端/SSE**、**不动 `src/rob/room-text.ts`**。
- 不做 TUI 侧改造；不做工作区根运行时切换（Q1=2 已排除）。

---

## 5. 功能需求（FR）

- **FR-1 双区域切换（Q2=3）**：界面提供「助手」与「Bot」两个**区域入口**（顶部 tab），切换后主区内容随之替换；默认进入**助手区**。
- **FR-2 助手脱离 Bot 组（Q3/Q4）**：助手**不得**出现在「Bots」列表、Bot 广场卡片或任何 Bot 选择面；助手为**全局单例**，不提供新建入口。
- **FR-3 助手区内容**：单助手交互面 = 会话列表 + 对话流（`MessageList`）+ 输入框（`Composer`）+ 工作区（子目录）选择 + 文件面板。不套用 bot 专属 tab（记忆/唤醒/设置）。
- **FR-4 助手工作区选择（Q1=2）**：复用 `WorkspacePicker`/`WorkspaceBrowser` 语义——**只能打开工作区内的目录**；选定后文件面板以该目录为根，且不影响服务端工作区根。
- **FR-5 助手会话（Q5）**：复用现有 `sessions` 能力：新建 / 打开 / 重命名 / 删除 / 切换；会话内容随切换更新。
- **FR-6 Bot 区内容（Q7）**：Bot 广场 / 房间（含既有 @ 选择器 + 名册）/ DM 流 / 通知 / 子 Agent 归 **Bot 区**；助手区**不出现 rooms**。
- **FR-7 零协议变更（Q1=2 + Q6）**：不改 `shared/protocol.ts`、`src/rob/room-text.ts`、服务端/SSE；改动范围限 `web/**`。
- **FR-8 回归保护**：房间 @/名册（AC-1..AC-13）、文件面板、权限弹窗、设置、Agents 视图**不得回归**。
- **FR-9 可测性（承 FR-5 硬约束）**：新增的**归类/分区/可见性**逻辑必须抽成**纯函数**（无 React/DOM、无 jsdom 依赖）；布局与交互类按「人工/集成」标注，不当绿报。

---

## 6. 验收标准（AC，可测化）

> 纯函数类：落 `test/web/*`（无 jsdom）。布局/交互类：**人工/集成**，显式标注，不计自动绿。

- **AC-1 双区域入口存在且可切换（人工/集成）**：界面存在「助手」「Bot」两个入口；切换后主区内容互斥替换；默认助手区。现有 `view`（chat/agents/plaza/subagents）路径**不回归**。
- **AC-2 助手归类正确（纯函数）**：给定 `bots` 列表，助手（`kind==="workspace"`）**不在** Bot 区集合中；`robs` 在 Bot 区集合。数据**同源**——两侧均由同一 `state.bots` 派生，不得各自拼一份名单。
- **AC-3 助手区不出现 rooms（纯函数 / 人工）**：由「区域 → 可见实体集合」的映射（纯函数）保证：助手区可见集合**不含** rooms；Bot 区含 rooms。
- **AC-4 工作区（子目录）选择受限**：只能打开工作区内的目录（复用 `canOpen` 约束）；选择后文件面板根随之更新、服务端工作区根不变。（复用现有纯函数面 + 人工验证）
- **AC-5 会话管理复用回归**：新建/打开/重命名/删除/切换行为与现状一致；`test/web/sessions.test.ts` 全绿。
- **AC-6 零协议变更（红线）**：diff 不触及 `shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`。
- **AC-7 既有能力回归保护**：`test/web/*` 与 `test/rob/room-text*` 全绿；房间 @/名册 13/13 不回归。
- **AC-8 可测性达标**：新增归类/分区逻辑为**纯函数**且有单测；未引入 jsdom/@testing-library；人工/集成项在测试计划中显式标注。

---

## 7. 风险、依赖与红线

- **布局改动（Q2=3）**：落点在 `web/src/App.tsx` / `web/src/components/Sidebar.tsx` 及新增区域组件；新 tab **不得**回归现有 `view` 路径（review 特别提醒）。
- **同源**：助手与 Bot 列表必须从同一 `state.bots` 派生（同 AC-9 的坑，review 特别提醒）。
- **红线（命中即红）**：`src/tui/**`、`screenshots/**`、`shared/protocol.ts`、`src/rob/room-text.ts`。
- **测试基数**：定稿新增用例后按新范围实跑，不沿用 159 文件 / 1405 用例旧数；全量须在干净 HOME（`/tmp/fakehome` + 清 `/tmp/x`）下跑，否则 config/cli-run 两条 missing-key 假失败。
- **无 jsdom**：`test/web/*` 纯逻辑；渲染/交互仅人工/集成。

---

## 8. 分工与下一步

1. **pm（已完）**：定稿本 PRD（FR/AC 可测化）。
2. **architect（下一步）**：出 `docs/design/assistant-agent-and-bot-separation.md` —— 区域划分与信息架构、纯函数边界（如 `partitionBots(bots)` / 区域→实体映射）、组件改动清单、**明确零协议 diff 评估**。
3. **qa**：据 §7 文件清单出测试计划（纯函数用例 + 人工/集成项标注）。
4. **dev**：小步 commit（仅 `web/**` + 测试），push 后报远端 HEAD。
5. **review**：按 web 范围审 diff（重点：同源、view 不回归、红线零命中）。
6. **ci**：干净 HOME 跑五步，出对账区间 + 各步 exit code + 远端 short SHA。
7. **pm**：按 AC-1..AC-8 终判。

### 8.1 设计要求（对齐 AC-1 / AC-2，leader 意见已并入）

> 以下两条是 AC-2「助手归类」与 AC-1「view 不回归」能否**可测/可判**的前置，architect 设计里必须明确，否则对应 AC 落空。

- **D-1 归类必须纯函数化（保 AC-2）**：助手/Bot 的**分区**必须来自一个可单测的纯函数（建议签名 `partitionBots(bots: BotInfo[]) → { assistant: BotInfo | null; bots: BotInfo[] }`，或等价 `areaForBot(kind)`），两侧视图**均由它派生**，禁止各组件自行 `filter` 拼名单。要求：无 React/DOM 依赖，落 `test/web/*`（无 jsdom）。**这是 AC-2「数据同源」的唯一取证方式。**
- **D-2 区域切换与现有 `View` 的关系必须讲清（保 AC-1）**：设计须显式说明新「助手 / Bot」双区域与现有 `View = "chat" | "plaza" | "subagents" | "agents"` 是**替换**还是**叠加一层**（例如：顶层 area ∈ {assistant, bot}，Bot 区内再复用原 `View`）。无论哪种，都必须保证**现有 `view` 路径（chat/agents/plaza/subagents）不回归**——即 AC-1 后半需给出可验证的映射或留存点（如文件 → 对应 `View` 的对照表，供 review/qa 人工核对）。
- **D-3 红线自证（保 AC-6）**：设计须附「零协议 diff 评估」——说明改动只落 `web/**`，不触及 `shared/protocol.ts` / `src/rob/room-text.ts` / `src/tui/**` / `screenshots/**`。
