# 交付 · Web UI 移动端适配 — pm 终判（AC-1..AC-8）

- 房间：`rnd`｜角色：pm（终判）｜日期（UTC）：2026-10-16
- **终判锚点**：远端 `origin/main` = 本地 HEAD = **`ad3b41aaa6ed090c059df45cdb6317481f7f7707`**，`origin/main...HEAD = 0/0`
- **锁定范围**：`a063851..ad3b41a` = **7 笔 / 7 文件**
- **结论**：AC-1..AC-8 = **8/8**，本线 **closed**

---

## 1. 终判三条（pm 独立实跑，非转述）

| 条件 | 实测 | 结果 |
|---|---|---|
| ① 远端 hash | `ls-remote` = `ad3b41aaa6ed...` = HEAD，`0/0`；`a063851` 为其祖先 | ✅ |
| ② 范围 | 7 笔 / 7 文件，`grep -Ev '^(web/\|test/web/)'` = 空；树 CLEAN-TRACKED | ✅ |
| ③ 真数 + 红线 | `layout.test.ts` 5/5；聚焦 16 files/166；干净 HOME 全量 161 files/1435，0 failed；红线四项零命中；无 jsdom | ✅ |

**范围文件**：`web/src/layout.ts`、`web/index.html`、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/components/FileTree.tsx`、`web/src/styles.css`、`test/web/layout.test.ts`

**提交列表（`a063851..ad3b41a`，7 笔）**：
1. `9eae728` feat(web): add the mobile drawer state machine
2. `204b0ec` feat(web): add the mobile drawer and overlay skeleton
3. `3e1bb94` feat(web): open the sidebar as a mobile drawer
4. `b0eed56` refactor(web): drop the unused mobile breakpoint constant
5. `7f57926` feat(web): keep the closed mobile drawer out of the tab order
6. `95f9a27` feat(web): open the file panel as a mobile overlay
7. `ad3b41a` feat(web): size touch targets and fit modals on a phone

---

## 2. AC-1..AC-8 逐条判定

| AC | 判定 | 取证 |
|---|---|---|
| **AC-1** 双区域入口存在且可切换（状态纯函数） | **自动绿 ✅**（+界面人工） | `drawerReducer` 5 例绿（toggle/open/close/navigate + 全集覆盖）；tab 切换 / 默认助手为**人工/集成** |
| **AC-2** 手机首屏不遮挡 / 双态契约 | **人工/集成** | `mobileFilesOpen` 默认 `false` + CSS 中和（`.file-panel.closed{display:flex}` + `:not(.mobile-open){display:none}`，纯 CSS、零宽度判断）；首屏不遮挡须人工核 |
| **AC-3** 移动导航可达（抽屉全路径） | **人工/集成** | 已删 `:3358-3363` 两条 `display:none`、`.sidebar.drawer-open` + `visibility` + `inert`；路径须人工核 |
| **AC-4** 文件面板可达 | **人工/集成** | `.file-panel.mobile-open` 覆盖层 + `.file-panel-close` + `.panel-backdrop`（条件挂载）；须人工核 |
| **AC-5** 触控目标 44px + hover 兜底 | **人工/集成** | `@media (pointer:coarse)` 44px 清单 + `hover:none` 兜底均在提交版；触屏实测须人工 |
| **AC-6** 弹窗适配 320–375 | **人工/集成** | `≤640 .modal{width:calc(100vw-24px)}` 已落（桌面 440/500 不变）；须人工核 |
| **AC-7** 桌面零回归（≥881 / 641–880 不破） | **人工/集成** | §9 清单（新增类默认 `display:none`、fixed/内边距仅 ≤640、`pointer:coarse` 不命中鼠标、`100dvh` 桌面等值） |
| **AC-8** 红线＋范围 | **审查绿 ✅** | 7 文件全 in-scope、红线四项零命中、无 jsdom/@testing-library |

**合计：AC-1..AC-8 = 8/8** — 自动/审查绿 **2**（AC-1、AC-8）；**人工/集成 6**（AC-2..AC-7，**不当绿报**）。**无未决 AC。**

---

## 3. 契约落地核验（提交版 `git show ad3b41a`）

- **契约①**：`styles.css:3393 .file-panel.closed{display:flex}`（中和）+ `:3397 .file-panel:not(.mobile-open){display:none}` → 移动可见性只看 `.mobile-open`，桌面默认开不弹覆盖层。
- **步骤 5**：`:3893 @media (pointer: coarse)` 44px 触控 + `hover: none` 兜底 + `≤640 .modal` 移动适配，与契约①**并存**（第 7 笔 `ad3b41a` 复原了被误 checkout 的契约①）。
- **删 `MOBILE_MAX_PX`**：`web/src/layout.ts` 与 `test/web/layout.test.ts` 全仓 0 引用（`b0eed56`）；断点权威归 CSS `@media(max-width:640px)`（AC-7 人工/CSS 审查）。
- **零协议**：`shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**` 零命中。

---

## 4. 过程中的范围风险（已闭合留痕）

- 共享工作树曾出现**越界残留**：`UU src/permissions/rules.ts` 冲突 + staged `test/permissions/rules.test.ts`（+59）。来源=外部失败的 `stash@{0} deploy-backup-20261016-120907` apply，**非本线、非 dev**。
- 处置：dev 清理后**树 CLEAN-TRACKED、无 unmerged**；越界项还原 HEAD；`stash@{0}` 未 drop，内容零丢失。
- **pm 裁决**：该 permissions 增量（空 pattern/bare star/toolSubject）属**另一条线**，**不并入本线**，交对应 owner 决定去留。

---

## 5. 关联产物

- PRD：`docs/prd/webui-mobile-adaptation.md`（pm 代决 M1–M6，用户授权自决）
- 设计：`docs/design/webui-mobile-adaptation.md`（architect 定稿 + §3.1 双状态修订，review ②③④⑤ 采纳）
- 测试计划：`docs/deliverables/20261016-webui-mobile-adaptation-test-plan.md`
- QA 报告：`docs/deliverables/20261016-webui-mobile-adaptation-qa-report.md`（含「人工项不当绿报」+ 人工矩阵声明）

## 6. 前序线（均已 closed，锚点被本线覆盖）

- @ 选择器线：**AC-1..AC-13 = 13/13**（`0f640ec` ⊆ `ad3b41a`，产物逐字未变）
- 助手/Bot 分区线：**AC-1..AC-8 = 8/8**（`a063851`）

## 7. 待用户醒来确认（非阻塞）

- 是否接受 M2 抽屉式导航 / M3 覆盖式文件面板（默认方案）。
- 是否需要横屏（landscape）与平板（768–1024）专门版式（当前通用响应式覆盖，不做专门版式）。

---

**终判：Web UI 移动端适配 AC-1..AC-8 = 8/8 达成，已落地远端 `ad3b41a`，红线零命中，无未决 AC。本线闭环。**
