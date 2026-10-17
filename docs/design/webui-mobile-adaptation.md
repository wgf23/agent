# 设计：Web UI 移动端适配

- 作者：rob "architect" ｜ 状态：定稿，可直接实现
- 关联 PRD：`docs/prd/webui-mobile-adaptation.md`（可执行；M1–M6 由 pm 代决，本设计确认/优化并定 M4）
- 基线：**`a063851`**（= origin/main = HEAD；分区线已落，与本需求同文件 `App.tsx`/`Sidebar.tsx`）
- 关联代码：`web/src/styles.css`（`:219` `.app`、`:3358-3363` 两条 `display:none`、`:2188/:2200` `.modal`、`:3441` `.region-tabs`、`:2534` `.file-panel`、`:1583` `.composer-wrap`、`:1062-1090` `.message-actions`+`hover:none`）、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/components/FileTree.tsx`、`web/index.html`

> **范围与红线**：改动仅 `web/**`（含 `web/index.html` 的 viewport meta）；**零协议、零服务端**。
> **零命中** `shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`（命中即红）。
> **不引入 jsdom/@testing-library**（FR-8）。**桌面 ≥881px 零回归**（FR-7）。

---

## 1. 断点策略（M1，确认）

沿用现有断点，**不新增**：

| 区间 | 形态 | 本设计动作 |
|---|---|---|
| `≤ 640px`（移动） | 移动 | 侧栏→**覆盖抽屉**、文件面板→**覆盖层**、加**移动顶栏**、安全区/dvh/触控目标；替换现有两条 `display:none` |
| `641–880px`（窄桌面） | 现状 | **不动**（侧栏 200px、文件面板 300px 仍并排） |
| `≥ 881px`（桌面） | 现状 | **零回归**：所有新增元素默认 `display:none`，新增定位/内边距仅存在于 `≤640` 媒体查询内 |

**关键手法（零回归的保证）**：新增的 `.mobile-bar`/`.drawer-backdrop`/`.panel-backdrop`/`.file-panel-close` 等**默认 `display:none`**，只在 `@media (max-width: 640px)` 内显示；抽屉的 `position:fixed`/`transform` 也只在 `≤640` 生效。桌面渲染树与计算样式不变。

**现有 `≤640` 的 `display:none` 如何被取代**：
- `styles.css:3358-3360 .sidebar{display:none}` → 改为**离屏抽屉**：`.sidebar{position:fixed; inset:0 auto 0 0; width:min(82vw,300px); transform:translateX(-100%); z-index; transition}`，`.sidebar.drawer-open{transform:none}`。
- `styles.css:3361-3363 .file-panel{display:none}` → 改为**右侧覆盖层**：`.file-panel{position:fixed; inset:0 0 0 auto; width:min(86vw,340px); z-index; box-shadow}`；开合仍复用现有 `.file-panel.closed{display:none}`。

---

## 2. 移动导航形态与信息架构（M2/M4）

### 2.1 顶栏（新增）
移动端在 `.main` 顶部渲染一条 `.mobile-bar`（**仅 `≤640` 显示**）：左「☰」汉堡按钮（`aria-label="打开导航"`、`aria-expanded`）、中间当前上下文标题、右可留空。

### 2.2 抽屉（复用 `Sidebar`）
汉堡点击 → 给 `Sidebar` 的 `<aside>` 加 `drawer-open`，侧栏从左侧滑入（覆盖式）；同时渲染 `.drawer-backdrop`（**仅在 `mobileNavOpen` 为真时挂载**，杜绝常驻暗层——review ⑤），覆盖主区、点击关闭、`Esc` 关闭。**复用同一个 `Sidebar` 组件**，不新建导航 DOM——`region` 分区渲染（Bots 仅 robs、Rooms/会话/历史会话按 region）随之整体在抽屉内呈现。

**Esc 作用域（review ⑤）**：抽屉的 `Esc` 处理**只在抽屉开着时**生效，且不得抢占 RoomView 的 `!open && running → interrupt` 与弹窗 `Esc`。实现：`useEffect` 里 `if (!mobileNavOpen) return;` 再绑 keydown，收尾 `removeEventListener`（App 已有此形态，见 WIP `App.tsx:66-73`）；抽屉开着时优先关抽屉，不冒泡到 RoomView。

**无障碍与焦点（review ②；**不用 `inert`**）**：关闭态仅 `translateX(-100%)` 会「藏而不禁用」，关闭的抽屉对键盘 Tab 与读屏仍在顺序里（桌面原本 `display:none`）。故：
- 关闭态在 `≤640` 补 **`visibility:hidden`**（配 `transition: transform .2s, visibility .2s`，过渡结束后才不可见）——它使关闭抽屉不可聚焦、移出 a11y 树，② 的目标即达成。
- **不用 `inert`**：`inert` 是 HTML 属性，CSS 媒体查询改不了它；而 App 的 `mobileOpen` 在桌面恒 `false` → `inert={!mobileOpen}` 恒为 `inert={true}`，会**误伤桌面侧栏**（不可点/Tab/读屏），破坏 §9 桌面零回归；要门控就得引入 JS 测宽（§7.1 已排除）。故禁用一律交给 **`≤640` 作用域内的 `visibility:hidden`**。
- **焦点转移**：开抽屉后焦点移到抽屉内首个可聚焦项（如关闭按钮）；关抽屉（背板/Esc/navigate）后焦点**还回汉堡按钮**（ref 保存）。桌面不参与（`mobileNavOpen` 恒 false，`visibility` 规则也不在桌面命中）。

### 2.3 M4 决策（**定：区域 tab 保留在主区顶部，即「顶栏」**）
`REGIONS` 的两个 tab 现有位置就是 `.main` 顶部的 `.region-tabs`（`App.tsx:209`）。**移动端不把它们搬进抽屉**，只在其上方加一行 `.mobile-bar`。即移动端信息架构：

```
[☰ 标题]                 ← .mobile-bar（≤640）
[ 助手 | Bot ]           ← .region-tabs（位置不变，桌面/移动一致）
────────────────
主区内容（助手对话 或 Bot 广场/房间/…）
```

**选「顶栏」而非「抽屉内」的理由**：① **零条件渲染**——无需 `isCompact` 决定 tab 放哪，避免 JS 宽度逻辑与重复 DOM；② 区域切换**一步可达**（不必先开抽屉）；③ 抽屉只承担「区域内的列表导航」（nav/Bots/Rooms/会话），职责单一；④ 桌面零回归最直接（`.region-tabs` 完全不动）。

抽屉内的区域相关项（nav-item、Bots、Rooms、历史会话）随 `region` 显隐（分区线既有逻辑），因此抽屉与顶栏 tab 天然一致。

### 2.4 抽屉在导航后自动关闭（M5）
抽屉开合是**客户端 UI 状态**（App 的 `mobileNavOpen`），不持久化、不入协议。**选择任何目标后自动关闭**（切视图/切 bot/切房间/开会话/点搜索命中/新建对话），回到主区——这是 FR-2「关闭抽屉后可回主区」的落实。

---

## 3. 文件面板（M3）

### 3.1 双状态模型（review ①，**核心**）
文件面板要同时满足「桌面默认开」与「移动默认关」，而**不得引入 JS 宽度判断**。做法：**桌面沿用现有 `filesOpen`（默认 `true`，红线不可改）；移动另设 `mobileFilesOpen`（默认 `false`）**，二者互不干扰：

| 区间 | 可见性由谁裁决 | 默认 | 说明 |
|---|---|---|---|
| `≥881` 桌面 | `filesOpen`（`.closed`） | 开 | 与现状完全一致 |
| `641–880` 窄桌面 | `filesOpen`（`.closed`） | 开 | 现状规则不破 |
| `≤640` 移动 | `mobileFilesOpen`（`.file-panel.mobile-open`） | **关** | `.closed` 在该区间被中和（见下） |

- **CSS**：`@media (max-width: 640px){ .file-panel.closed{ display:flex } /* 中和，交权给 mobile-open */ ; .file-panel:not(.mobile-open){ display:none } }`。即移动端可见性**只**看 `.mobile-open`，纯 CSS、无 JS 测宽。
- **「文件」导航按钮**（Sidebar 内，桌面/移动共用一个 DOM）：点击时**同时翻转两个状态** `setFilesOpen(v=>!v); setMobileFilesOpen(v=>!v)`。因初值相反（`true`/`false`）→ 首击 `(false,true)`：桌面 `.closed` 隐藏 ✓、移动 `.mobile-open` 展开 ✓；再击 `(true,false)`：桌面复现 ✓、移动关闭 ✓。桌面侧 `mobileFilesOpen` 无视觉作用（`.mobile-open` 样式仅 ≤640 存在），**桌面零回归**。
- **关闭路径**（移动）：面板头部 `.file-panel-close` / `.panel-backdrop` / `Esc` → `setMobileFilesOpen(false)`。桌面这些元素 `display:none`，不会误触。

### 3.2 覆盖层形态与组件边界
- 开启：`.file-panel.mobile-open` 在 `≤640` 为 `position:fixed` 全高覆盖层，`width:min(86vw,340px)`，右滑入、带 `box-shadow`。
- 面板头部新增 `.file-panel-close`（**仅 `≤640` 显示**，`aria-label="关闭文件面板"`）；`.panel-backdrop` **仅在 `mobileOpen` 为真时挂载**（review ⑤：条件渲染，杜绝常驻暗层），点击关闭。
- `App` 新增 `mobileFilesOpen` 状态；`FileTree` 新增 props：`mobileOpen: boolean`、`onClose: () => void`（外加既有 `open`）；`class={\`file-panel ${open?"":"closed"} ${mobileOpen?"mobile-open":""}\`}`。
- 桌面：`.file-panel` 仍是右侧 300px 并排栏，**不变**。

---

## 4. 视口与安全区（FR-1/FR-5）

1. **viewport meta**：`web/index.html` 的 `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`（加 `viewport-fit=cover`；桌面浏览器忽略，零回归）。
2. **动态视口高度**：`.app{ height:100vh; height:100dvh }`（后者覆盖前者；旧浏览器回退 `100vh`）。桌面 `dvh==vh`，不变。
3. **安全区落点清单**（`env()` 在非刘海设备恒为 `0`，且**仅写在 `≤640` 媒体查询内**，故桌面零影响）：

| 落点 | 规则 |
|---|---|
| 移动顶栏 | `padding-top: max(6px, env(safe-area-inset-top))` |
| 抽屉 | `padding-top: env(safe-area-inset-top)`、`padding-bottom: env(safe-area-inset-bottom)`、左 `env(safe-area-inset-left)` |
| Composer 底栏 | `.composer-wrap{ padding-bottom: calc(14px + env(safe-area-inset-bottom)) }`、左右 `env(safe-area-inset-left/right)` |
| 文件覆盖层 | `padding-bottom: env(safe-area-inset-bottom)` |
| 弹窗背板 | `padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)` |

4. **无横向滚动**：移动端对 `.app`/`.main`/`.region-tabs`/`.composer` 加 `max-width:100%`+`overflow-x:hidden` 兜底；长内容 `min-width:0`（`.main` 已有）。

---

## 5. 触控与 hover 兜底（FR-4，M6）

### 5.1 44px 目标清单
在 `@media (pointer: coarse)`（触屏设备，**不命中桌面鼠标**）内，将下列交互元素提升到 `min-height/min-width: 44px`（或等效：`padding` 撑到 44 命中区）：

`.nav-item`、`.region-tab`、`.sidebar-action`、`.icon-btn`（含 `.sidebar-settings`）、`.session-item`、`.session-action`、`.session-close`、`.tab`（bot 专属 tab）、`.btn`（含 `.btn.small`）、Composer 发送/中断按钮、`.bot-item`/`.room-item`、`.file-panel` 行内操作（`.file-row` 上的 icon-btn）、`PermissionModal` 的按钮。

> 只改 `pointer:coarse`（触屏），桌面 `pointer:fine` 不受影响 → 零回归。

### 5.2 `hover:none` 替代路径
- **已有兜底**：`.message-actions`（`styles.css:1062-1074` 默认 `opacity:0`，`:1089` 已由 `@media (hover:none){opacity:1}` 显示）——保留。
- **需补**：审查其余「仅 `:hover` 出现/增强」的 affordance，在 `@media (hover: none)` 下给等价可见态。已知/重点：
  - `.markdown .code-copy`（`:1440`，`opacity:.85`→hover `1`）：触屏保持常显（已是可见，仅补足对比度即可）。
  - `.session-action`/`.session-close`/`.sidebar-action`：**当前本就常显**（非 hover-only），触屏可直接点——无需改，测试计划记为已达标。
  - 行尾/卡片 `:hover` 高亮：非功能入口，不阻断操作，不强制。
- **原则**：凡「只有 hover 才能触发的功能」必须给触屏等价路径；纯 hover 视觉增强不强制。

---

## 6. 弹窗适配（FR-6）

`@media (max-width: 640px)`：
- `.modal{ width: calc(100vw - 24px); max-width: 100%; max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); }`（`dvh` 优先，`vh` 回退）。
- `.modal-body` 已是 `overflow` 滚动容器；确认 `min-height:0` 使其在 `100dvh` 下正确收缩。
- `.modal.approval{ width: calc(100vw - 24px) }`（覆盖 500px 固定宽）。
- `.modal-backdrop{ padding: env(safe-area-inset-*) }`，避免贴刘海/手势条。
- `PermissionModal` 的许可/拒绝按钮：`flex-wrap` 允许换行、命中区 ≥44px（§5.1），320px 下可点。
- 桌面（`≥881`）：`.modal`（440/500px）**不变**。

---

## 7. 纯函数边界（FR-8 / AC-1）与组件清单

### 7.1 纯函数（新增 `web/src/layout.ts`，无 React/DOM）
唯一新增判断逻辑是**抽屉开合语义**（M5 的状态机），抽成纯函数，落 `test/web/layout.test.ts`：

```ts
/** 抽屉开合状态机：navigate/close 一律关闭；toggle 翻转；open 打开。 */
export type DrawerAction = "toggle" | "open" | "close" | "navigate";
export function drawerReducer(open: boolean, action: DrawerAction): boolean;
// toggle  -> !open
// open    -> true
// close   -> false
// navigate-> false   （选任何目标后回到主区，FR-2）
```
App 用 `setMobileNavOpen((o) => drawerReducer(o, "toggle"))`、导航回调 `drawerReducer(o,"navigate")`。**无死代码**（每个分支都被 App 用到）。

> **review ③（已采纳：删）**：**不导出 `MOBILE_MAX_PX`**。断点的权威是 CSS 的 `max-width:640px`，一个只在自测里被 `===640` 断言的 JS 常量**测不出 CSS 漂移**，属「假单一来源」死导出（同 QUERY_TOKEN_RE/clampIndex 先例），故删除。若已落码，步骤 3 一并移除该常量与其 `describe`。
> AC-1 = **非 N/A**：唯一纯函数是 `drawerReducer`（`test/web/layout.test.ts`）。断点是纯 CSS，不引入 JS 宽度判断（更稳，无需 resize 监听），故**不需要** `isCompact` 用例。

### 7.2 组件改动清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `web/index.html` | viewport 加 `viewport-fit=cover` | 配置 |
| `web/src/layout.ts`（新） | `drawerReducer`（**不含 `MOBILE_MAX_PX`**，见 §7.1） | 纯函数 |
| `web/src/App.tsx` | `mobileNavOpen` 状态；**`mobileFilesOpen` 状态（默认 `false`）**；`.mobile-bar`（汉堡，仅≤640）；`.drawer-backdrop`（`mobileNavOpen` 为真时**才挂载**）；给 `Sidebar` 传 `mobileOpen`/`onNavigate`、`onToggleFiles` 改为同时翻转 `filesOpen`+`mobileFilesOpen`；给 `FileTree` 传 `mobileOpen={mobileFilesOpen}`/`onClose`；开/关抽屉做焦点转移 | 布局（人工/集成） |
| `web/src/components/Sidebar.tsx` | 新增 `mobileOpen: boolean`、`onNavigate?: () => void`；`<aside class={\`sidebar${mobileOpen?" drawer-open":""}\`}>`（**不加 `inert`**——`inert` 无 CSS 作用域、桌面恒 true 会误伤；关闭态禁用交给 `≤640` 的 `visibility:hidden`）；头部加移动关闭按钮（仅≤640，开抽屉后首焦点）；导航/bot/room/session/搜索/新建对话回调内调 `onNavigate()` | 布局（人工/集成） |
| `web/src/components/FileTree.tsx` | 新增 `mobileOpen: boolean`、`onClose: () => void`（保留既有 `open`）；`class={\`file-panel ${open?"":"closed"}${mobileOpen?" mobile-open":""}\`}`；头部加 `.file-panel-close`（仅≤640）；`mobileOpen` 为真时**才挂载** `.panel-backdrop` | 布局（人工/集成） |
| `web/src/styles.css` | 抽屉（`.sidebar.drawer-open`+关闭态 `visibility:hidden`）、`.file-panel.mobile-open` 覆盖层（含 `≤640 .file-panel.closed{display:flex}.file-panel:not(.mobile-open){display:none}`）、`.mobile-bar`、`.drawer-backdrop`、`.panel-backdrop`、`.file-panel-close`、safe-area、`100dvh`、`pointer:coarse` 44px、`hover:none` 兜底、`.modal` 移动适配；**删/改** `:3358-3363` 两条 `display:none` | 样式（人工/CSS 审查） |
| `test/web/layout.test.ts`（新） | `drawerReducer` 四动作用例（**不测断点常量**） | 纯函数 |

**不改**：`regions.ts`（分区线契约）、`state.ts`、`protocol.ts`、任何 `src/**`、`screenshots/**`。

---

## 8. 零协议自证（FR-8 / AC-8）

| 需求 | 现有/新增来源 | 是否越界 |
|---|---|---|
| 抽屉开合 | `App` 的 `useState` + `layout.ts` 纯函数 | 纯客户端，不入 wire |
| 汉堡/顶栏/背板 | 新 DOM + CSS | 仅 `web/**` |
| 文件覆盖层 | 复用 `FileTree` 的 `open`/`.closed` + 新增客户端 `mobileFilesOpen` + CSS | 仅 `web/**` |
| 视口/安全区 | `index.html` meta + CSS `env()`/`dvh` | 仅 `web/**` |
| 触控目标/hover | CSS 媒体查询 | 仅 `web/**` |

结论：**不触** `shared/**`、`src/serve/**`（SSE）、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`；未引入 jsdom/@testing-library。diff 面 = `web/**` + `test/web/**`。

---

## 9. 桌面零回归清单（FR-7 / AC-7）

- 所有新增类默认 `display:none`，仅 `≤640` 显示。
- `.sidebar`/`.file-panel` 的 `position:fixed` 只在 `≤640`；`641–880` 保持 200px/300px 并排（现有 `:3349` 规则不动）。
- `.region-tabs` 桌面样式不改。
- `.app` 由 `100vh` → `100vh;100dvh`：桌面两者相等，像素不变。
- `pointer:coarse` 媒体查询不命中桌面鼠标；safe-area `env()` 在无刘海设备为 `0`，且仅在 `≤640` 内书写。
- `.modal` 桌面尺寸（440/500px）不变。
- **红线：桌面文件面板默认开不可改**——`filesOpen` 默认 `true`（`App.tsx:53`）与 `.file-panel` 300px 并排栏在 `≥881` 保持原样；移动端由独立 `mobileFilesOpen`（默认 `false`）驱动，两者互不干扰（§3.1）。
- 回归锚点：`test/web/*` + `test/rob/room-text*` 全绿（分区线 AC-1..AC-8、@ 线 AC-1..AC-13 不回归）。

---

## 10. M1–M6 决策汇总

| # | 决策 | 结论 | 说明 |
|---|---|---|---|
| M1 | 断点 640/880 | **确认** | 不新增断点 |
| M2 | 顶栏+汉堡→抽屉（复用 Sidebar） | **确认** | 覆盖式 + 背板/Esc 关闭 |
| M3 | 文件面板覆盖层 | **确认** | 右侧滑入，默认关，可关 |
| M4 | 区域 tab 位置 | **定：顶栏（主区顶部，位置不变）** | 零条件渲染、一步可达、职责单一（§2.3） |
| M5 | 抽屉状态 | **确认**：客户端状态、不入协议；`drawerReducer` 纯函数 | 导航后自动关闭 |
| M6 | 触控目标 44px | **确认** | 经 `pointer:coarse` 实现 |

---

## 11. 任务拆分（交 dev，小步提交，仅 `web/**` + `test/web/**`）

1. `web/src/layout.ts` + `test/web/layout.test.ts`（`drawerReducer` 纯函数与用例）。
2. `web/index.html`（viewport `viewport-fit=cover`）+ `styles.css`：`100dvh`、safe-area、`≤640` 抽屉/文件覆盖层骨架。
3. `App.tsx`：`mobileNavOpen`+`mobileFilesOpen`、`.mobile-bar`、`.drawer-backdrop`（条件挂载）、接线与焦点转移；`Sidebar.tsx`：`mobileOpen`/`onNavigate`、自动关闭、移动关闭按钮（**不加 `inert`**）。
4. `FileTree.tsx`：`mobileOpen`/`onClose`、`.file-panel-close`、`.panel-backdrop`（条件挂载）；`styles.css` 的 `≤640 .file-panel.closed{display:flex}` + `:not(.mobile-open){display:none}`。
5. `styles.css`：`pointer:coarse` 44px、`hover:none` 兜底、`.modal` 移动适配。

**提交前**：`git checkout -- screenshots/`；确认 diff 仅 `web/**` + `test/web/**`（+ `docs/design` 本文件外不提交）。

---

## 12. 明确不做 / 边界

- 不做 PWA/离线/安装、不做手势库、不做横屏/平板专用版式（按通用响应式覆盖）。
- 不做 TUI；不改协议/服务端/`shared/**`。
- 抽屉/文件层**不做持久化**（刷新回默认关）。
- `641–880` 维持现状（不顺手重构窄桌面），避免扩大回归面。
