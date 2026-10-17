# 测试计划：Web UI 移动端适配（QA）

- 作者：rob `qa` ｜ 日期：2026-10-16
- 依据：PRD `docs/prd/webui-mobile-adaptation.md`（AC-1..AC-8）、设计 `docs/design/webui-mobile-adaptation.md`（基线 `a063851`，§7 纯函数边界 / §9 桌面零回归 / §11 五步）
- 范围：`web/**`（含 `web/index.html` viewport meta）+ `test/web/**`；**无 jsdom / @testing-library**（FR-8）
- 计数口径：**vitest 实跑输出的 Tests 数**，**不沿用旧基线**（本线报数时以 dev commit 后的新范围实跑为准）；全量须在**干净 HOME** 下跑

---

## 1. 自动绿（纯函数，落 `test/web/layout.test.ts`）— AC-1

新模块 `web/src/layout.ts`（无 React/DOM，无新依赖）。测试 import `../../web/src/layout.js`。

### 1.1 `drawerReducer(open, action) -> boolean`（AC-1，两态 × 四动作真值表）

| open \ action | `toggle` | `open` | `close` | `navigate` |
| --- | --- | --- | --- | --- |
| `false` | `true` | `true` | `false` | **`false`** |
| `true` | `false` | `true` | `false` | **`false`** |

断言要求：
- `toggle` 两态各翻转一次（`false→true`、`true→false`）；
- `open` 幂等为真（两态都 `true`）；
- `close` 幂等为假（两态都 `false`）；
- **`navigate` 恒 `false`**（选任何目标后关闭抽屉回主区，FR-2）——**核心不变量**；
- 四动作对布尔入参**全部返回 `boolean`**（无未知分支 / 无抛错），覆盖联合类型全集。

### 1.2 ~~`MOBILE_MAX_PX === 640`~~ —— **已废止**（review ③ / architect §3 / pm 采纳）

- **删除理由**：JS 常量只在自测里被 `===640` 断言，**测不出 CSS `@media(max-width:640px)` 的漂移**，属「假单一来源」死导出（同 `QUERY_TOKEN_RE`/`clampIndex` 先例）。故 `web/src/layout.ts` **不导出** `MOBILE_MAX_PX`。
- **连带**：步骤 1 已提交的 `test/web/layout.test.ts` 的 `describe("MOBILE_MAX_PX")`（1 例）**由 dev 在步骤 3 一并移除**。
- **断点权威**：`styles.css` 的 `@media (max-width: 640px)`；其取证归 **人工/CSS 审查**（见 §3 AC-7 桌面零回归清单），不属自动绿。
- **AC-1 自动绿 = 5 例**（`drawerReducer` 两态 × 四动作真值表），不再是 6 例。

### 1.3 若 dev 额外导出断点辅助

如 `isCompact(width)` 等**任何新增判断逻辑**，一并纯用例覆盖（窄/宽边界 640/641、641–880、≥881）；**不得引入 jsdom / resize 监听**。

> 设计选择断点为纯 CSS，无 JS 宽度判断 → 无 `isCompact` 用例需求；若 dev 最终导出，本项追加。

**估数**：`drawerReducer` 4–5 例 ≈ **5**（原 6 例含已废止的 `MOBILE_MAX_PX` 1 例；步骤 3 移除后为 5；若 dev 另加 `drawerReducer` 边界例则以实跑为准）。

---

## 2. 回归面（AC 硬锚，自动绿）

| 锚点 | 套件 | 期望 |
| --- | --- | --- |
| 分区线 AC-1..AC-8 | `test/web/regions.test.ts`(25) + `test/web/*` | 全绿，不回归 |
| @/名册线 AC-1..AC-13 | `test/web/mention.test.ts`(32) + `test/web/state.test.ts`(28) + `test/rob/room-text.test.ts`(17) + `test/rob/room-text-mention-boundary.test.ts`(5) | 全绿，不回归 |
| 其它 web/后端 | `test/web/*` + `test/rob/room-text*` | 全绿 |

**命令**：`npx vitest run test/web test/rob/room-text.test.ts test/rob/room-text-mention-boundary.test.ts`；全量 `HOME=$(mktemp -d) npx vitest run`。

> 干净 HOME 说明：本机 `~/.config/my-agent/credentials.json` 有真 key，默认 HOME 下 `test/config.test.ts`、`test/cli/run.test.ts` 两条 missing-key 为**环境假阳性**（非回归）。

---

## 3. 人工 / 集成矩阵（显式标注，**不计自动绿**）— AC-2..AC-7

无 jsdom（FR-8）⇒ 渲染/交互只能人工/集成。宽度 × 场景矩阵：

**宽度档**：`320 / 375 / 414`（移动，≤640）｜ `768`（≈窄桌面 641–880）｜ `1024 / 1440`（桌面 ≥881）

| 场景 | 320 | 375 | 414 | 768 | 1024 | 1440 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **AC-2** 无横向滚动 / 无内容被裁 / `dvh` 生效、底栏不被浏览器 UI 裁 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| **AC-2-①** 手机**首屏不得**被文件覆盖层/暗层遮挡（`mobileFilesOpen` 默认 `false`；桌面 `filesOpen` 默认 `true` 不变） | ✔ | ✔ | ✔ | — | — | — |
| **AC-2-②** `.drawer-backdrop`/`.panel-backdrop` **仅在开启时挂载**（关闭态无残留暗层） | ✔ | ✔ | ✔ | — | — | — |
| **AC-3** 抽屉：打开→切区域(助手/Bot)/切视图(对话·广场·子 Agent·Agents)/切会话/切房间→**关闭回主区** | ✔ | ✔ | ✔ | — | — | — |
| **AC-4** 文件面板：打开→浏览/返回→关闭，不遮挡到无法操作 | ✔ | ✔ | ✔ | — | — | — |
| **AC-5** 触控目标 ≥44px + `hover:none` 替代路径 | ✔ | ✔ | ✔ | — | — | — |
| **AC-6** `.modal`/`PermissionModal` 320–375 完整可见、可滚、按钮可点 | ✔ | ✔ | ✔ | — | — | — |
| **AC-7** ≥881 桌面零回归；641–880 现状规则（200px 侧栏/300px 文件面板并排）不破 | — | — | — | ✔ | ✔ | ✔ |

**逐场景步骤**：

- **AC-2**：各宽度打开主区/助手/Bot 区/房间/`Agents`/`file-panel`/`modal`，确认无横向滚动条、无内容裁切；移动端底栏（Composer）不被浏览器地址栏/手势条裁切（`100dvh`）。
- **AC-2-①（首屏无遮挡，review ④）**：手机 320/375/414 **冷启动首屏**确认**没有**文件覆盖层、也没有任何暗层遮挡主区——`mobileFilesOpen` 初值须为 `false`（`App.tsx`）；对照桌面 `filesOpen` 初值仍 `true`（≥881 文件面板默认开，不回归）。
- **AC-2-②（暗层条件挂载，review ④）**：`.drawer-backdrop` 与 `.panel-backdrop` **只在对应开启态挂载**；抽屉/文件层关闭后 DOM 中不得残留这两个元素（无「不可见但仍拦截点击」的常驻暗层）。核对方式：关闭态用 DevTools 检查是否有 backdrop 节点 + 点击主区确认可交互。
- **AC-3**：≤640 点「☰」开抽屉（背板覆盖主区）→ 依次：切「助手/Bot」tab、切 `对话/广场/子 Agent/Agents`、切会话、切房间；每选一个目标抽屉**自动关闭**回主区；点背板 / `Esc` 亦关闭。区域 tab 仍在主区顶部（设计 §2.3 M4=顶栏），不被搬进抽屉。
- **AC-4**：≤640 点「文件」导航开覆盖层（右侧滑入）→ 浏览/返回目录 → 用 `.file-panel-close` 或 `.panel-backdrop` 关闭；确认不遮挡到无法操作。
- **AC-5**：DevTools 设备模式（`pointer:coarse`）核对 §5.1 清单元素命中区 ≥44px；`hover:none` 下确认 hover-only 操作有可见/可点替代。已知**已达标**：`.message-actions`(`styles.css:1089` hover:none 兜底)、`.session-action`/`.session-close`/`.sidebar-action`（本就常显，非 hover-only）。
- **AC-6**：320–375 打开设置/新建/`PermissionModal` 等，确认 `.modal` ≤ `100vw-24px`、高 ≤ `100dvh-24px`、`.modal-body` 可滚、许可/拒绝按钮可点（可换行）。
- **AC-7**：1024/1440 桌面布局/间距/像素与基线 `a063851` 一致；768 侧栏 200px + 文件面板 300px 仍并排（641–880 不动）。

---

## 4. 红线（AC-8，命中即红）

diff 只允许 **`web/**`（含 `web/index.html` viewport meta）+ `test/web/**`**。

**禁止命中**：`shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`；**未引入 jsdom/@testing-library**。

核对命令（dev commit 后、qa 复跑前）：
```
git diff --name-only <base>..HEAD
# 范围越界检查（pm 补给）：提交范围内不得出现 web/** + test/web/** 之外的文件
git diff --name-only <base>..HEAD | grep -Ev '^(web/|test/web/)' && echo "越界！退回 dev" || echo "范围干净"
grep -rn "jsdom\|@testing-library" test/web/ web/ || echo "no jsdom imports"
```
任一路径落在红线内 / 出现范围外文件 / 引入 jsdom ⇒ 判红。

> **共享工作树风险（pm 实测，2026-10-16）**：索引/工作树现存**本线之外**的 staged 文件 `src/permissions/rules.ts`（**`UU` 未解决冲突**，非普通 staged）+ `test/permissions/rules.test.ts`（staged `M`）。已提交范围 `a063851..95f9a27`（6 笔）经核**干净**（仅 `web/**`+`test/web/**`）；但若 dev 用裸 `git commit`（非按路径）会把上述越界文件卷入 → 需 dev 按显式路径提交 / 先解决 `UU` 冲突与取消 staging。锁定 range 时以 **commit 范围**为准（不采工作树）。`web/src/styles.css` 现为 `MM`（staged+unstaged）。

---

## 5. 执行步骤（dev commit 后由 qa 落实）

1. dev 按设计 §11 五步小步落码（仅 `web/**`）+ commit/报范围（基线 `a063851`）。
2. qa 实跑：`test/web/layout.test.ts`（§1）+ 回归面（§2）+ 全量 clean HOME。
3. 报**真数**（各文件 passed/total）+ 逐条 AC-1..AC-8 判定（绿/人工/红）+ 计数对账（**新范围**，不沿用旧数）。
4. §3 人工/集成矩阵由 user/review 界面核对，**不当绿报**。

---

## 6. 计数与基线

- 基线 `a063851`（含分区线 6 笔）：`test/web/*` + `test/rob/room-text*` = 15 文件 / 161 用例；全量 160 文件 / 1430 用例。
- 本线新增 `test/web/layout.test.ts`（**去 `MOBILE_MAX_PX` 后 ≈5**，`drawerReducer` 两态×四动作）会抬高 `test/web/*` 与全量文件/用例数；**聚焦预期 = 基线 161 + 5 = 166**，**具体以 dev 落完步骤 3–5 后的新范围实跑为准**，不预设、不沿用旧数。
- 上一需求（分区线）真数：regions 25/25、回归 15/161、全量 160/1430（报告 `docs/deliverables/20261016-assistant-agent-bot-separation-qa-report.md`）。

---

## 7. AC ↔ 取证映射（对齐设计 §7/§9）

| AC | 取证 | 类型 |
| --- | --- | --- |
| AC-1 状态纯函数 | `test/web/layout.test.ts`：**仅 `drawerReducer` 四动作（两态真值表，5 例）**；`MOBILE_MAX_PX` 已废止（§1.2） | **自动绿** |
| AC-1 断点（CSS 权威） | `styles.css` 的 `@media (max-width:640px)`；无 JS 常量可测 → 归 §3 AC-7/CSS 审查 | 人工/CSS 审查 |
| AC-2 无横向溢出 | §3 矩阵（320/375/414/768/1024/1440） | 人工/集成 |
| AC-2-① 首屏无文件覆盖层/暗层 | §3 矩阵（手机冷启动，`mobileFilesOpen` 默认 false） | 人工/集成 |
| AC-2-② backdrop 条件挂载 | §3 矩阵（关闭态无残留 `.drawer-backdrop`/`.panel-backdrop`） | 人工/集成 |
| AC-3 移动导航可达 | §3 矩阵（≤640 抽屉全路径） | 人工/集成 |
| AC-4 文件面板可达 | §3 矩阵（≤640 覆盖层） | 人工/集成 |
| AC-5 触控目标 | §3 矩阵 + CSS 审查（`pointer:coarse`/`hover:none`） | 人工 + CSS 审查 |
| AC-6 弹窗适配 | §3 矩阵（320–375） | 人工/集成 |
| AC-7 桌面零回归 | §3 矩阵（≥881 + 641–880） | 人工 |
| AC-8 范围红线 | §4 diff 核对 + jsdom 扫描 | 自动/审查 |
