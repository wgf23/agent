# 测试报告：房间 @ 选择器 + 成员名册（QA 最终）

- 作者：rob `qa` ｜ 日期：2026-10-16
- 提交范围（base..HEAD）：**`18022f5..0f640ec`（5 笔）**——`244274e` mention.ts 纯模块 / `c5053d7` RoomView+App+styles 接线 / `e8f3509` 合入测试 / `c0661ef` 修 AC-3 组件高亮（clampIndex 定义+接线+用例）/ `0f640ec` test-only：把 lastIndex 回归用例改为结构性断言（`MENTION_RE_SOURCE` 非 RegExp 实例）
- 历史：早前 `18022f5..e8f3509`（3 笔）复跑 79 绿，但 `e8f3509` 是 review **打回**版本（AC-3 组件路径红，§3.1）；`c0661ef` 为修复后新 HEAD。
- 依据：`docs/prd/room-mention-and-roster.md`（AC-1..AC-13）、`docs/design/room-mention-and-roster.md` §2/§3
- 复跑环境：本机 `npx vitest run`。测试真数取自提交范围 `e8f3509`（当时工作区与提交一致）。
- 本报告真数均在 **最终 HEAD `0f640ec`（5 笔）** 上独立复跑取得；`0f640ec` 仅动 `test/web/mention.test.ts` 一条用例内部断言，用例数不变（仍 32）。AC-3 组件缺陷（§3.1）已在 `c0661ef` 修复。

## 1. 真数（vitest 实跑）

| 文件 | Tests | 用途 |
| --- | --- | --- |
| `test/web/mention.test.ts` | **32 / 32 passed** | Web 纯逻辑：AC-1/2/3/4/6/7/8/10/12/13 + AC-9 同源（+3 `clampIndex`） |
| `test/web/state.test.ts` | **28 / 28 passed** | state 层：`members` 事件单一写入源（AC-9） |
| `test/rob/room-text.test.ts` | **17 / 17 passed** | 后端真值：AC-5 `@all` / AC-11 未匹配回归 |
| `test/rob/room-text-mention-boundary.test.ts` | **5 / 5 passed** | 后端 token pin：AC-12 真值表 |
| **合计** | **4 files / 82 passed** | ✅ 0 失败 |

**全量回归**（新 HEAD）：`npx vitest run` → **159 files / 1405 passed**（见 §4 环境说明）。

## 2. AC-1..AC-13 逐条判定

| AC | 判定 | 取证 |
| --- | --- | --- |
| AC-1 候选取 members ∪ {all}，顺序 | ✅ 绿 | `mention.test.ts` mentionState（query=""→[dev,worker,all]，all 末尾 broadcast） |
| AC-2 前缀过滤 / 无匹配空态 | ✅ 绿 | 同上（`@d`/`@D`→[dev]；`@zz`→[]） |
| AC-3 光标处插入、`@<name> `，替换延伸到 Q-token 末尾 + 高亮不越界 | ✅ 绿（纯函数）／组件路径已修复（人工·集成口径，代码复核通过，§3.1） | 纯函数 `insertMention`（`@de\|v`→`@dev `、`@devX`(4)→`@dev `、`a @d b`(4)→`a @dev  b`）+ `clampIndex`(5,3)=2/(2,2)=1/(-1,3)=0/(2,0)=0/(0,0)=0；组件面 `c0661ef`：`recomputeMention` 不再碰 index、`onKeyUp` 遇方向键 early-return、`activeIndex=clampIndex(index,count)` |
| AC-4 浮层开时 Enter/Tab 选择、Esc 关闭不发送 | ✅ 绿（纯函数）＋人工（回归，见 §3） | `mentionKeydown` open+Enter/Tab→select、open+Esc→close、!open+Enter→submit |
| AC-5 `@all` → 全员 | ✅ 绿（后端） | `room-text.test.ts` :71 `@all` 广播、:78 与具名并集、:89 成员名恰为 all 时精确名优先 |
| AC-6 IME 合成不误触发 | ✅ 绿（纯函数）＋人工（组件侧，见 §3） | `mentionKeydown({isComposing:true})`→none（两条） |
| AC-7 重复 @ 同一成员从候选消失、仍可手打 | ✅ 绿 | `mentionState`：`@dev @`→[worker,all]；`@all @`→[dev,worker]（只隐 all）；`@dev- @`→[dev,worker,all]（`-` 不终止、不隐 dev） |
| AC-8 名册全量 + 协调者 + 状态 | ✅ 绿 | `rosterRows`：全量、label、isCoordinator、四状态映射；无状态→空闲 |
| AC-9 成员变化两处同源 | ✅ 绿（自动化） | `state.test.ts` members 事件 :514/:590 更新 `room.members`；`mention.test.ts`「same-source」两组断言候选与名册随同一 members 变 |
| AC-10 空成员空态 | ✅ 绿 | `rosterRows([],null,{})`→[] |
| AC-11 未匹配 `@xxx` 保留正文、不 addressed | ✅ 绿（后端回归） | `room-text.test.ts` :47 既有断言 |
| AC-12 边界字符与后端 token 对齐 | ✅ 绿 | `mentionQuery`（Q 宽）+ `mentionedNames`（B 严格）；后端 pin `boundary.test.ts` 5 例（含 `@dev-`→`dev-`、`@deV`→`de`、`@DEV`→无） |
| AC-13 大写 `@DEV` 归一命中 `dev`、插入 `@dev `、无残留 | ✅ 绿 | `mentionQuery("@DEV",4)`→query `dev`、length 4；`insertMention("@DEV",4,"dev")`→`{"@dev ",5}` |

### 关键回扣（leader 点名）
1. **AC-3 `@de|v`→`@dev ` 无残留**：✅ 独立复跑模块确认（`tokenEnd()` 向右吃掉 `[A-Za-z0-9-]`）。
2. **/g lastIndex 回归**：✅ 外部 `MENTION_RE.test("@dev")` 置 `lastIndex=4` 后再 `mentionedNames("@dev @worker")` → `["dev","worker"]`（模块内每次 `new RegExp(MENTION_RE_SOURCE,"g")`）。用例 `mention.test.ts:105` 钉死。
3. **FR-2.7 排除已 @**：✅ 见 AC-7；且 `@dev-` **不**隐 `dev`（与后端 strict token 一致）。

## 3. 人工 / 集成项（FR-5：无 jsdom，不计自动绿）

### 3.1 AC-3 组件路径 —— **已在 `c0661ef` 修复**（原 review/leader 打回，qa 独立复核代码路径属实）

- **现象**：候选下拉里 ↑/↓ 高亮切不动，始终停在第一项；Enter 恒选第一个候选。
- **最小复现**（手工，组件级）：`members=[dev,worker]` → 输入框打 `@` → 下拉出现 `@dev / @worker / @all` → 按 `↓` → 高亮**不动**（仍在 `@dev`）→ 按 `Enter` → 插入的恒是 `@dev `。
- **根因（qa 读 committed `e8f3509` 源码定位）**：
  - `recomputeMention`（`RoomView.tsx:70-73`）内含 `setIndex(0)`。
  - `onKeyUp`（`:299-301`）非合成时**无条件**调用 `recomputeMention`。
  - `handleKeyDown` 里 `↓/↑` 先用 `moveIndex` 设 index（`:171-173`），但紧随其后的 keyup 又 `recomputeMention → setIndex(0)`，把高亮打回 0。→ 纯函数 `moveIndex` 绿**测不到**这条集成路径。
- **为何不能自动测**：依赖 React 受控 textarea 的 keydown/keyup/select 事件时序，本仓无 jsdom/@testing-library（FR-5）。→ 计**人工/集成**（修复前红、修复后根因消除，见下）。
- **修复（committed `c0661ef`，qa 复核）**：
  ① `recomputeMention`（:77-81）**不再碰 index**——`setIndex(0)` 只在 `onChange`（:304）保留；
  ② `onKeyUp`（:307-312）对 `ArrowDown/ArrowUp` **early-return**，方向键 keydown 的 `moveIndex` 不再被 keyup 覆盖；
  ③ `RoomView:70` `activeIndex = clampIndex(index, count)` 接线（import :9），`clampIndex` 定义在 `mention.ts:188`（`count<=0→0`，否则 `min(max(index,0),count-1)`）；
  ④ `enter` 选 `mention.candidates[activeIndex]`（:154）。
- **qa 补验（人工/集成口径）**：对 `moveIndex`+`clampIndex` 逻辑走查确认 `↓↓`→index 2（高亮 2）、`↑`→index 1（高亮 1）、stale index 2/count 2→clamp 1、count 0→0；组件事件时序依赖 textarea，无 jsdom 仍归**人工/集成**，但根因已消除。
- **其余**：`insertMention`/`moveIndex` 纯函数结论与 AC-13 不受此影响。

| 项 | 说明 | 手工步骤 |
| --- | --- | --- |
| AC-6 后半：合成期不弹候选 | 组件级依赖 DOM/IME 事件；architect 明确 `mentionState` 不加 `isComposing`，守卫在 `RoomView`（`onChange` 遇 `isComposing` 早返回 `setMention(null)`） | 中文输入法组合期敲 `@x`，确认浮层不弹、Enter 不发送 |
| AC-4 回归：浮层关且 running 时 Esc 仍中断 | `RoomView` 既有行为分支，无 jsdom 不可自动测 | 房间运行中、浮层关闭按 `Esc` → 触发中断；浮层开启按 `Esc` → 仅关浮层 |
| AC-3 组件路径：↑/↓ 高亮移动 | **见 §3.1，`c0661ef` 已修复（人工/集成）** | 打 `@` → `↓/↑` 看高亮移动；`Enter` 选中所高亮项 |
| UI 呈现（下拉/浮窗/caret 回填/点外部关闭） | 渲染层 | 打 `@`/`@d` 看候选；点候选看回填光标；点页脚「N 名成员」看浮窗 |

## 4. 复跑备注（如实）

- 首次全量 `npx vitest run` 报 **2 failed**：`test/config.test.ts`、`test/cli/run.test.ts`（missing-key 用例）。
- 定位：**环境性**，非本范围回归——本机存在真实 `~/.config/my-agent/credentials.json`，`loadConfig` 在删除 `DEEPSEEK_API_KEY` 后仍从凭据文件取到 key，故「缺 key 报错」用例不成立。
- 证据：`HOME=/tmp/cleanhome npx vitest run` → **159 files / 1405 passed**，0 失败。
- 范围文件（`web/src/mention.ts`、`RoomView.tsx`、`App.tsx`、`styles.css`、两个测试文件）；红线核对：**未触** `src/rob/room-text.ts` / `shared/protocol.ts` / `src/tui/**`。
- 残留（低危）：`clampIndex` 已接线（`RoomView:70`）并有 5 条纯函数断言；`/g` 污染回归用例在 `c0661ef` 曾被弱化（污染的是一个**局部** fresh regex，对自建 regex 的 `mentionedNames` 恒过＝假阴性）。qa 已在测试内补结构性断言（`MENTION_RE_SOURCE` 非 RegExp 实例 + 同源污染扫描仍全扫）钉住，待 dev 提交（用例数不变）。

## 5. 结论

- 提交范围 `18022f5..0f640ec`（最终 HEAD，5 笔）：**82/82 自动化用例绿**（4 文件），全量 **1405/1405 绿**（清洁 HOME），**无回归**。
- AC 判定：**13/13 达成**——AC-1/2/3/5/7/8/9/10/11/12/13 自动化绿；AC-3 组件路径 + AC-4 regression + AC-6 后半为人工/集成口径，其中 **AC-3 组件路径缺陷（原打回）已在 `c0661ef` 修复并经 qa 代码复核**，AC-4/AC-6 组件侧维持人工/集成（无 jsdom）。
- 变更史：`e8f3509` 79 绿但 AC-3 组件红（review 打回）→ `c0661ef` 修复（`recomputeMention` 去 `setIndex(0)`、`onKeyUp` 方向键 early-return、`activeIndex=clampIndex`、补 `clampIndex` 用例）→ 复跑 82 绿。
- qa 未改任何源码；本次仅测试文件与报告。
- `0f640ec` 已落：qa 强化的 lastIndex 结构性断言（同用例内，用例数不变）已由 dev 提交，最终 82/82 复跑确认。
- **收官**：远端 `origin/main = 0f640ec`（= local HEAD，0/0）；ci 对远端 HEAD 五步全绿（159/159 文件、1405/1405 用例）、review 收工、qa 13/13。本测试报告即对最终 HEAD 的结论，无可变项。
