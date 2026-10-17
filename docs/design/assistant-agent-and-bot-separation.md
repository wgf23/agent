# 设计：交互型助手 Agent 与 Bot 分区分治

- 作者：rob "architect" ｜ 状态：定稿，可直接实现
- 关联 PRD：`docs/prd/assistant-agent-and-bot-separation.md`（confirmed；Q1=②子目录切换、Q2=③顶部 tab、Q3=复用、Q4=单助手、Q6=Web only、Q7=房间归 Bot 区）
- 关联代码：`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/state.ts`（`workspaceBot`/`robBots`：`:167/:171`）、
  `web/src/components/FileTree.tsx`（`WorkspacePicker`：`:854`、`relFromWorkspace`/`canOpen`）、`web/src/components/BotPlaza.tsx`

> **范围与红线**：改动仅 `web/**` + `test/web/**`。**不新增/修改协议**、**不改服务端/SSE**、**不动 `src/rob/room-text.ts`**、
  **不动 `src/tui/**`、`screenshots/**`**（命中即红，见 §6）。
> 硬约束（FR-9）：新增的**归类/分区/可见性**逻辑必须抽成**纯函数**（无 React/DOM、无 jsdom）；布局/交互按「人工/集成」标注。

---

## 1. 区域划分与信息架构（Q2=③ 顶部 tab 两页）

引入一个**客户端 UI 状态** `region: "assistant" | "bots"`（默认 `"assistant"`，FR-1），在 `.main` 顶部渲染一排
`region-tabs`（两个入口：「助手」「Bot」）。切换后**主区内容互斥替换**；`region` 不进协议、不入 state。

| 区域 | 主区内容（主视图） | 侧栏内容 | 导航项 |
|---|---|---|---|
| **助手**（默认） | 单助手对话：`BotHeader` + `MessageList` + `Composer`（**不套 bot 专属 tab**：无记忆/唤醒/设置） | `新建对话` + 助手**历史会话**（`sessions`） | `对话` + `文件`（toggle） |
| **Bot** | `BotPlaza` / `SubagentFeed` / `AgentsPanel` / rob 或 room 的 `RoomView`/`Chat` | `Bots` 组（**仅 robs**）+ `Rooms` 组 + 该 bot 的 `会话` | `对话` / `Bot 广场` / `子 Agent` / `Agents` + `文件`（toggle） |

**Agents 视图归属**：归 **Bot 区**。`AgentsPanel`（后端 CLI 安装/检测）服务的是 **rob 的后端**（`state.agents`/`agentJobs`），
与助手无关；放 Bot 区语义一致。

**文件面板（`FileTree`）保持全局渲染（两区域都可见）** —— 设计选择，理由：
① FR-8 明令「文件面板不得回归」，从 Bot 区移除会造成回归；② 它是**工作区**的面板，工作区根不随区域变；
③ 最小 diff。工作区子目录选择器 `WorkspacePicker` 位于 `FileTree.tsx:854`，因此在两区域都可用，
但它只改**面板根**、不改服务端工作区根（FR-4/Q1=2），不产生协议交互。

**助手不出现 rooms（FR-6/AC-3）**：rooms 只在 Bot 区渲染；助手区主区与侧栏都不含任何 room 元素。

**助手脱离 Bot 组（FR-2）**：侧栏 `Bots` 组由现在的 `[workspace, ...robs]`（`Sidebar.tsx:189`）改为**仅 `robs`**；
`BotPlaza` 已只收 `robs`（`App.tsx:197`），`NewRoomDialog` 已只收 `robs`——助手不提供新建入口（Q4 单助手）。

---

## 2. 纯函数边界（新模块 `web/src/regions.ts`）

> 所有逻辑集中在此模块，**无 React / 无 DOM**，只 import 类型 + `state` 的两个纯 helper。qa 在此写 `test/web/regions.test.ts`。

```ts
import type { BotInfo } from "./protocol.js";
import type { ClientRoom } from "./state.js";        // 仅类型
import { robBots, workspaceBot } from "./state.js";   // 纯 helper，单一实现复用

/** 两个区域。 */
export type Region = "assistant" | "bots";

/** 现有导航视图，与 Sidebar 的 View 同源（见 §3，从 Sidebar 迁出）。 */
export type View = "chat" | "plaza" | "subagents" | "agents";

export interface RegionSpec {
  id: Region;
  label: string;          // "助手" / "Bot"
  defaultView: View;      // 进入该区域的默认视图
  views: readonly View[]; // 该区域允许的视图
}

/** 顶部 tab 的单一来源（顺序 = 渲染顺序）：助手在前，默认进入助手。 */
export const REGIONS: readonly RegionSpec[] = [
  { id: "assistant", label: "助手", defaultView: "chat", views: ["chat"] },
  {
    id: "bots",
    label: "Bot",
    defaultView: "plaza",
    views: ["chat", "plaza", "subagents", "agents"],
  },
];

/** 该区域的默认视图。 */
export function defaultView(region: Region): View;

/** 把一个 view 收进区域：属于该区域则原样返回，否则回落到区域默认视图。
 *  仅用于「校验并回落无效 view」；纯 tab 切换按 §3.2 直接取 `defaultView`（见 ②）。 */
export function resolveView(region: Region, view: View): View;

// ---- 归类（AC-2 单一来源）------------------------------------------------

export interface Partition {
  assistant: BotInfo | null; // kind === "workspace"（全局单例，Q4）；无则 null（由 undefined 归一）
  bots: BotInfo[];           // kind === "rob"，保持服务端顺序
}

/** **单一来源**：助手与 Bot 两侧都由同一 `bots` 列表派生。
 *  直接复用 state 的 `workspaceBot`/`robBots`（见下「签名放宽」），避免两处拼名单。
 *  `assistant` 必须把 `workspaceBot` 的 `undefined` 归一为 `null`（`?? null`），否则下游 `=== null` 判空会漏。 */
export function partitionBots(bots: readonly BotInfo[]): Partition;

// ---- 选区（region → 当前渲染实体）---------------------------------------

export interface Selection {
  bot: BotInfo | null;
  room: ClientRoom | null;
}

/** 按区域解算当前渲染的实体。入参为全量 `bots`，内部先 `partitionBots` 再解析
 *  （与 §3.2 / 已落地的 `regions.ts` 实现一致；调用点无需先分区）。
 *   - assistant：`{ bot: assistant, room: null }`（忽略 selectedId/rooms）。
 *   - bots：`room = selectedId ? rooms[selectedId] ?? null : null`；
 *           `bot = room ? null : (robs.find(selectedId) ?? robs[0] ?? null)`（**只在 robs 内查找**）。
 *  **不变量（必须有用例）**：region==="bots" 时返回的 bot 永不为 `kind==="workspace"` 的助手
 *  ——即使 `selectedId === 助手名`（届时回落 `robs[0] ?? null`）。这是「两区内容互斥」的护栏。 */
export function resolveSelection(input: {
  region: Region;
  selectedId: string | null;
  bots: readonly BotInfo[];
  rooms: Record<string, ClientRoom>;
}): Selection;

// ---- 可见性（AC-3）------------------------------------------------------

/** 助手区对 rooms 的可见集合恒为空；Bot 区返回全部（保序）。
 *  入参为数组：调用点传 `Object.values(state.rooms)`（`state.rooms` 是 `Record`）。
 *  签名与调用点形状必须一致（此处选数组，与已落地实现对齐）。 */
export function visibleRooms(
  region: Region,
  rooms: readonly ClientRoom[],
): ClientRoom[];
```

**签名放宽（web-only，无行为变化）**：`state.ts:167/171` 的 `workspaceBot(bots: BotInfo[])` / `robBots(bots: BotInfo[])`
参数放宽为 `readonly BotInfo[]`，以便 `partitionBots` 复用而无需拷贝。这是一处纯类型放宽，不改语义（可选项，dev 若嫌跨模块可直接在 `partitionBots` 内做 `find`/`filter`，但**必须保持二者行为一致**并加同源断言）。

> 设计取向：`partitionBots` **调用** `state.workspaceBot/robBots`，使「助手 vs Bots」只有一份判定实现；
> 若 dev 选择内联，则需在 `regions.test.ts` 断言「与本仓 state helper 结果一致」。

---

## 3. 组件改动清单

### 3.1 新增 `web/src/regions.ts`（§2）
纯函数模块，唯一新逻辑文件。

### 3.2 `web/src/App.tsx`（布局 = 人工/集成验证）
- 新增状态：`const [region, setRegion] = useState<Region>("assistant")`（默认助手，FR-1）。
  `view`/`selectedId` 状态**保留不变**。
- 数据：`const { assistant: workspace, bots: robs } = partitionBots(state.bots)`（后续沿用 `workspace`/`robs`）。
  去掉直接调用 `workspaceBot`/`robBots`（改由 `partitionBots` 提供，保证同源 AC-2）。
- 选区：`const { bot: currentBot, room: currentRoom } = resolveSelection({ region, selectedId, bots: state.bots, rooms: state.rooms })`。
  **互斥护栏**（review ①）：`resolveSelection` 内部先 `partitionBots`，bots 区**只在 robs 内查找**，
  故 `selectedId === 助手名` 时回落 `robs[0] ?? null`，永不渲染助手。此不变量须有单测（见 §6 AC-1）。
- 顶部区域 tab（`.main` 内、内容之前）：`region-tabs`，遍历 `REGIONS`；点击 **`setRegion(next); setView(defaultView(next))`**（见 ② 决策）。
- 主区渲染：
  - `region === "assistant"`：渲染助手对话区（`BotHeader` + `MessageList` + `Composer`），**不传 `selectedRob`、不渲染 `BOT_TABS`**。
  - `region === "bots"`：沿用现有 `view` 分支（`agents`/`plaza`/`subagents`/`currentRoom`/`currentBot`）。`selectedRob` 仅在此分支计算。
- `FileTree`、`PermissionModal`、各对话框（`NewBotDialog`/`NewRoomDialog`/`SettingsDialog`）**保持全局渲染，位置不变**。
- 选区有效性 `useEffect`：改为基于分区结果判定（`robs.some(b => b.name === selectedId) || workspace?.name === selectedId || state.rooms[selectedId] !== undefined`），兜底 `setSelectedId(workspace?.name ?? robs[0]?.name ?? null)`。
- `openConversation`（**非** tab 点击的显式导航）：选中 rob/room 时 `setRegion("bots")` 并 `setView("chat")`；选中助手（`workspace.name`）时 `setRegion("assistant")`。

> **② 切区域默认视图决策（拍板：选 a）**：tab 点击时 `setView(defaultView(next))`——进入 Bot 区先落 `plaza`（概览），
> 进入助手区落 `chat`。代价：**不保留跨区域 view 记忆**（Bot 区停在某 room 时切去助手再切回，落回 plaza；room 仍在侧栏可一键重开）。
> 取 a 的理由：确定性、`REGIONS.defaultView` 有实义、plaza 可发现，且测试可判。
> `resolveView` 仅用于「显式导航带来区域不含的 view」的回落（如搜索命中、`openConversation`）；纯 tab 路径不走它。
> 若 pm 更偏好保留 view 记忆，可改 b（`setView(resolveView(next, view))` 且 bots 默认停 `chat`）——回抛即改。

> 选区一致性细节：助手区渲染不依赖 `selectedId`（由 `resolveSelection` 强制到 assistant）。侧栏「历史会话/新建对话」
> 仍以 `workspace.name` 为 owner（复用现逻辑），因此**无需**在切区域时改写 `selectedId` 也能正确渲染。

### 3.3 `web/src/components/Sidebar.tsx`（布局 = 人工/集成验证）
- `View` 类型**迁出到 `regions.ts`**（保持 `type View` 导出与值一致；`Sidebar` 从 `regions.js` 重新导出，避免破坏现有 import）。
- 新增 prop：`region: Region`（用于分区渲染；区域 tab 在 `.main`，侧栏不重复渲染 tab）。
- `Bots` 组：`{[workspace, ...robs].map(...)}`（`:189`）→ **仅 `robs`**；该组仅在 `region === "bots"` 渲染。
- `Rooms` 组：仅在 `region === "bots"` 渲染（AC-3）。
- `历史会话` 组（`:240`，`showSessions`）：仅在 `region === "assistant"` 渲染。
- `会话`（rob 自己的会话，`:270`）：仅在 `region === "bots" && selectedRob` 渲染。
- 导航 `nav`：按区域渲染项——
  - assistant：`对话`（`onViewChange("chat")`）+ `文件`。
  - bots：`对话` / `Bot 广场` / `子 Agent` / `Agents` + `文件`。
- `新建对话` 按钮：assistant 区可见（作用对象 `workspace`，复用现有 `onNewSession(workspace.name)`）；
  bots 区不显示（Bot 的新建走各视图内的 `+` / `onCreateBot`）。
- `SearchPanel`：保持全局（命中 chat→助手会话、room→Bot 区房间，沿用 `onOpenChat`/`onOpenRoom`；房间命中需 `setRegion("bots")`，由 App 的 `openConversation` 承接）。

### 3.4 `web/src/styles.css`（布局 = 人工）
- 新增 `.region-tabs` / `.region-tab`（对齐现有 `.tab-strip`/`.tab` 的视觉与 `aria-selected` 高亮）；
  放在 `.main` 顶部；与 bot 专属 `.tab-strip` 区分命名，避免样式串用。

**改动文件汇总**：`web/src/regions.ts`（新）、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/styles.css`、（可选）`web/src/state.ts` 参数放宽。

---

## 4. 零协议 diff 评估（FR-7 / AC-6）

结论：**不需任何协议/服务端改动**。逐条论证：

| 能力 | 现有来源（已存在于仓库） | 为何不需要新协议 |
|---|---|---|
| 区域切换 | `App` 的 `useState<Region>` | 纯客户端 UI 状态，不参与 SSE/wire |
| 助手分类 | `BotInfo.kind`（`shared/protocol.ts:39/55`，`"workspace"｜"rob"`） | 已在线上的既有字段；`partitionBots` 只读不写 |
| 工作区（子目录）选择 | `hello.workspaceRoot`（`protocol.ts:507`）+ `fsDirs` 路由 + `WorkspacePicker`/`canOpen`（`FileTree.tsx:854`） | Q1=②：只换面板根，服务端根不变，**复用现有请求** |
| 会话（新建/打开/改名/删/切换） | `state.sessions`/`activeSessionId`/`botSessions`/`botActiveSession` + `hub.*Session` | 整套已存在，Q5 复用 |
| rooms / DM / notices / subagents | `state.rooms`/`dms`/`notices`/`subagents` | 既有事件，呈现层重排不新增字段 |

**明确不改**：`shared/protocol.ts`、`shared/agents.ts`、`src/serve/**`（SSE 事件）、`src/rob/room-text.ts`、`src/tui/**`。
唯一可选的非协议改动是 `web/src/state.ts` 的**纯类型参数放宽**（`readonly BotInfo[]`），不涉及 wire。

---

## 5. 新 tab 不回归现有 view（FR-8 / AC-1）

- `View` 联合类型与取值**不变**（`chat | plaza | subagents | agents`），仅从 `Sidebar.tsx` 迁到 `regions.ts` 再 re-export。
- 四个既有视图仍全部可达：`chat` 在两区域均存在（助手=工作区对话；Bot 区=rob/room 对话），
  `plaza`/`subagents`/`agents` 在 Bot 区仍走**原有分支**（`App.tsx:188-205` 逻辑不变，只是被 `region === "bots"` 包裹）。
- `view === "agents"` 触发的 `loadAgents` 副作用（`App.tsx:111`）、`settledJobs` 副作用（`:121`）**逻辑不变**。
- 切区域后 `view` 始终落在该区域允许集内，不会渲染出「空的主区」：tab 点击取 `defaultView`（§3.2 ②），
  显式导航走 `resolveView` 回落。
- **两区内容互斥（review ①）**：`resolveSelection` 内部先 `partitionBots`，bots 区**只在 robs 内查找** → 即使 `selectedId` 指向助手也回落 `robs[0]`，永不渲染助手；该不变量有单测（§6 AC-1）。
- `RoomView`（含 @ 选择器/名册）、`BotPlaza`、`SubagentFeed`、`AgentsPanel`、`MessageList`、`Composer`、`FileTree` **组件签名不变**（RoomView 的 `botStates` 已在上一需求加入）。
- 回归锚点：`test/web/*` + `test/rob/room-text*` 全绿；房间 @/名册 13/13（`test/web/mention.test.ts`、`test/rob/room-text-mention-boundary.test.ts`）不回归。

---

## 6. AC ↔ 取证映射（供 qa / review）

| AC | 取证 | 类型 |
|---|---|---|
| AC-1 双入口可切换、默认助手、view 不回归；**切区域按 defaultView** | `REGIONS`/`defaultView` 单测 + 界面切换；**回归断言：`resolveSelection({region:"bots", selectedId:<助手名>, bots, rooms}).bot?.kind !== "workspace"`**（互斥不变量，必测） | 纯函数半 + 人工 |
| AC-2 助手归类正确、同源 | `partitionBots`：assistant.kind==="workspace" 且**不在** `bots`；**必测**与 `state.workspaceBot/robBots` 逐项一致（无 workspace / 仅 workspace / 混排）——若 dev 内联 find/filter，此同源断言**必须**保留，否则 AC-2 落空 | **纯函数** |
| AC-3 助手区不含 rooms | `visibleRooms("assistant", [])===[]`（数组入参）且 `resolveSelection({region:"assistant",...}).room===null` | **纯函数** |
| AC-4 子目录选择受限 | 复用 `canOpen`/`relFromWorkspace`（现有）；界面验证面板根变化、服务端根不变 | 纯函数 + 人工 |
| AC-5 会话复用回归 | `test/web/sessions.test.ts` 全绿；界面动词不变 | 回归 |
| AC-6 零协议变更（红线） | diff 不触 `shared/protocol.ts`/`room-text.ts`/`src/tui/**`/`screenshots/**` | 红线 |
| AC-7 既有能力回归 | `test/web/*` + `test/rob/room-text*` 全绿 | 回归 |
| AC-8 可测性达标 | `regions.ts` 纯函数有单测；未引入 jsdom；人工项在测试计划标注 | **纯函数** |

建议 `test/web/regions.test.ts` 覆盖：`partitionBots`（含无 workspace / 仅 workspace / 混排）、`defaultView`/`resolveView`（跨区域回落）、
`resolveSelection`（assistant 强制到助手、bots 选中 room、**bots 且 selectedId=助手名 → 返回 `kind!=="workspace"`**（互斥不变量，必测）、未知 id 回落 `robs[0]`、空 roster → null）、
`visibleRooms`（助手 `[]`→`[]`、Bot 全量保序）。

---

## 7. 任务拆分（交 dev，小步提交，仅 `web/**` + `test/web/**`）

1. `web/src/regions.ts` + `test/web/regions.test.ts`（纯函数 + 单测；可选同步放宽 `state.ts` 参数）。
2. `web/src/App.tsx`：`region` 状态、顶部 `region-tabs`（点击 `setRegion`+`setView(defaultView(next))`，②）、`partitionBots`/`resolveSelection(bots)` 接入、主区按区域分支。
3. `web/src/components/Sidebar.tsx`：`View` 迁出、`region` prop、按区域分区（Bots 仅 robs、Rooms 仅 Bot、历史会话仅助手）。
4. `web/src/styles.css`：`.region-tabs`/`.region-tab`。
5. qa 补 `test/web/regions.test.ts` 边界；人工/集成项按 §6 标注（布局项不计自动绿）。

**提交前**：`git checkout -- screenshots/` 清理无关删除；确认 diff 仅 `web/**` + `test/web/**`。

---

## 8. 明确不做 / 边界

- **不做 TUI**；**不做工作区根运行时切换**（Q1 已排除，无需协议）。
- 不建新实体、不做多助手、不提供「新建助手」入口（Q3/Q4）。
- 不改 Bot 编排/room/plaza/DM 语义；仅呈现层重组。
- 文件面板保持全局可见（§1 理由），不做区域隔离——若 pm 要求助手区独占文件面板，另开变更。
- 区域切换是纯客户端状态；刷新后回到默认助手区（无持久化需求，未在 FR 中）。
