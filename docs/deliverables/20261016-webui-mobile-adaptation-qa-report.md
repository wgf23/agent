# QA 报告：Web UI 移动端适配

- 作者：rob `qa` ｜ 日期：2026-10-16
- 提交范围（base..HEAD）：**`a063851..ad3b41a`（7 笔 / 7 文件）**
  - `9eae728` `web/src/layout.ts` 抽屉状态机（纯函数）
  - `204b0ec` 抽屉/覆盖层骨架（`web/index.html` viewport、`styles.css`）
  - `3e1bb94` 侧栏以移动抽屉打开
  - `b0eed56` 删除未使用的 `MOBILE_MAX_PX`
  - `7f57926` 关闭态抽屉移出 tab 顺序
  - `95f9a27` 文件面板改为移动覆盖层
  - `ad3b41a` 触控目标尺寸 + 弹窗适配
- 依据：PRD `docs/prd/webui-mobile-adaptation.md`（AC-1..AC-8）、设计 `docs/design/webui-mobile-adaptation.md`（§7 纯函数边界 / §9 桌面零回归）
- 测试计划：`docs/deliverables/20261016-webui-mobile-adaptation-test-plan.md`

---

## 1. 真数（在 `ad3b41a` 上独立复跑）

| 套件 | 结果 |
| --- | --- |
| `test/web/layout.test.ts` | **5 / 5 passed** |
| 回归 `test/web` + `test/rob/room-text*` | **16 files / 166 passed** |
| 全量（`HOME=$(mktemp -d)`） | **161 files / 1435 passed**，0 failed |

- 与基线 `a063851`（回归 15 files/161、全量 160/1430）相比：**+1 文件 / +5 用例**，全部来自 `layout.test.ts`。**聚焦 161 + 5 = 166**，与计划预期一致。
- `MOBILE_MAX_PX` 全仓 **0 引用**（已按 review ③ 删除）。
- 全量历史基线仅作参考；本线判据 = 上表实测。

---

## 2. 纯函数面（自动绿）— AC-1

`test/web/layout.test.ts` **5 例**，仅 `drawerReducer(open, action)` 两态 × 四动作：

| open \ action | `toggle` | `open` | `close` | `navigate` |
| --- | --- | --- | --- | --- |
| `false` | `true` | `true` | `false` | **`false`** |
| `true` | `false` | `true` | `false` | **`false`** |

- 覆盖 toggle 双向翻转、open 幂等真、close 幂等假、**navigate 恒 false**（选目标后关闭回主区）、四动作全集无未知分支。
- **`MOBILE_MAX_PX` 已废止**：JS 常量 `===640` 测不出 CSS `@media(max-width:640px)` 漂移，属假单一来源死导出（review ③）。断点权威 = CSS，归人工/CSS 审查。

---

## 3. 逐条 AC 判定

| AC | 判定 | 取证 |
| --- | --- | --- |
| AC-1 断点/状态纯函数 | ✅ **自动绿（5 例）** | `drawerReducer` 真值表；`MOBILE_MAX_PX` 已删，断点半边归 CSS 人工审查 |
| AC-2 无横向溢出 / 首屏无遮挡 | 🔶 **人工/集成** | 320/375/414/768/1024/1440 矩阵；含 ①首屏不得被文件覆盖层/暗层遮挡、②backdrop 仅开启时挂载 |
| AC-3 移动导航可达（抽屉） | 🔶 **人工/集成** | ≤640 抽屉全路径（切区域/视图/会话/房间 → 自动关闭回主区） |
| AC-4 文件面板可达（覆盖层） | 🔶 **人工/集成** | ≤640 打开/浏览/关闭，不遮挡到无法操作 |
| AC-5 触控目标 ≥44px | 🔶 **人工 + CSS 审查** | `pointer:coarse` / `hover:none` 兜底 |
| AC-6 弹窗适配 | 🔶 **人工/集成** | 320–375 `.modal`/`PermissionModal` 完整可见、可滚、按钮可点 |
| AC-7 桌面零回归 | 🔶 **人工** | ≥881 与基线一致；641–880 规则不破；CSS 断点权威审查 |
| AC-8 范围红线 | ✅ **自动/审查** | 见 §4 |

**人工/集成条目（不计自动绿，需真机过一遍）**：AC-2、AC-2-①、AC-2-②、AC-3、AC-4、AC-5、AC-6、AC-7。
其中 **AC-5 AC-7 为「人工 + CSS 审查」混合**：触控尺寸与断点一致性需读 CSS 佐证。

---

## 4. 红线（AC-8）

```
git diff --name-only a063851..ad3b41a
```
**7 文件**：`web/index.html`、`web/src/layout.ts`（新）、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/components/FileTree.tsx`、`web/src/styles.css`、`test/web/layout.test.ts`。

- 越界检查 `| grep -Ev '^(web/|test/web/)'` → **空** ✅
- **禁止命中项零命中** ✅：`shared/protocol.ts`、`src/rob/room-text.ts`、`src/tui/**`、`screenshots/**`
- **无 jsdom / @testing-library**（`grep` 仅命中注释文字）✅

---

## 5. 结论

- 范围 `a063851..ad3b41a`：**layout 5/5**、回归 **16 files/166**、全量 clean HOME **161 files/1435**，**无回归**。
- **AC-1 自动绿（5 例）**；AC-8 红线零命中。**AC-2..AC-7 为人工/集成（含 AC-5/AC-7 的 CSS 审查半）**，按 FR-8 无 jsdom 的口径**不当绿报**，需真机按 320/375/414 宽度过矩阵。
- 已知挂账（非阻塞）：真机人工矩阵未执行；`stash@{0}` 的 permissions 增量属另一条线，不在本批次。
- qa 未改源码；本次仅测试文件与报告。**未 commit、未 push**。
