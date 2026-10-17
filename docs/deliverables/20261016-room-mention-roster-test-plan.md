# 测试计划：房间 @ 选择器 + 成员名册（QA）

> 作者：rob `qa` ｜ 日期：2026-10-16 ｜ 状态：待 dev 实现后落地用例
> 依据：`docs/prd/room-mention-and-roster.md`（confirmed，AC-1..AC-13）
> 关联设计：待 architect 产出 `docs/design/room-mention-and-roster.md`（本计划按其接口落测）
> 纪律：qa 只加测试、不改源码、不提交不推送；源码提交归 dev，CI/发布归 ci。

## 1. 分层原则（与 pm 口径一致）

| 层 | 覆盖对象 | 归属用例 | 说明 |
| --- | --- | --- | --- |
| 后端语义层 | `parseRoomMentions`（`src/rob/room-text.ts`） | `test/rob/room-text.test.ts`（既有，保持绿） | AC-5 / AC-11 复用，**不重写**、不新增语义 |
| Web 纯逻辑层 | @ 触发/过滤/排除/插入的用户级纯函数（待 dev 抽到 `web/src/`） | 新增 `test/web/*.test.ts` | AC-1/2/3/4/7/9/12/13 的主战场 |
| Web state 层 | `web/src/state.ts`（`ClientRoom.members`、`botStates`） | `test/web/state.test.ts` 追加 | AC-9 同源断言 |
| 组件/交互层 | `RoomView.tsx`（keydown / IME / 光标 / 浮窗） | **当前无 jsdom/测试库，见 §3** | AC-3/4/6 交互部分受限 |

## 2. AC → 用例映射

| AC | 层 | 计划用例（要点） |
| --- | --- | --- |
| AC-1 | Web 纯逻辑 | 给定 `members=["dev","worker"]`，查询 `""`（刚打 `@`）→ 候选 `["dev","worker","all"]`，顺序 = members 序 + all 在后 |
| AC-2 | Web 纯逻辑 | 查询 `"d"` → `["dev"]`；查询 `"zz"` → 空（且返回「无匹配」态，不返回 all/全部） |
| AC-3 | Web 纯逻辑 + 交互 | 纯函数：`insertMention("hi @d", caret=6, "dev")` → `"hi @dev "`，光标落在尾随空格后；中间插入 `"a @d b"` 不破坏前后文本。↑/↓/Enter/Tab 的状态机用纯 reducer 断言 |
| AC-4 | Web 纯逻辑 + 交互 | 浮层开启（open=true）时 keydown Enter → 返回「选择」而非「提交」；Esc → `{open:false, submit:false}` |
| AC-5 | 后端 | 复用既有 `parseRoomMentions` `@all` 用例；**不新增** |
| AC-6 | 交互（受限） | `isComposing=true` 时 keydown 不进入选择/发送；若能抽成纯判定（`shouldHandleKey(key,{isComposing,open})`）则纯测，否则标为需 jsdom/手工 |
| AC-7 | Web 纯逻辑 | 已出现 `@dev` 后，候选排除 `dev`（FR-2.7），`@a @b` 两次插入独立生效；被排除成员仍可手打提交 |
| AC-8 | Web 纯逻辑 | 名册数据 = 全量 members（不受排除影响）+ coordinator 标记 + 每项状态文案（`STATUS_LABEL[botStates[m]?.status ?? "idle"]`） |
| AC-9 | state 层 + 纯逻辑 | 同一 `members` 源：`state` 更新 `members` 事件后，候选函数输出与名册函数输出**同时**变化（一条测试断言两者都基于同一入参） |
| AC-10 | Web 纯逻辑 | `members=[]` → 名册返回空态标记，不抛错 |
| AC-11 | 后端 | 手打未匹配 `@xxx` 保留正文、不 addressed（`room-text.test.ts` 既有断言），保持绿 |
| AC-12 | Web 纯逻辑 + 后端对账 | 见 §4 真值表；已裁决能力 A（对齐后端），PRD AC-12 已按真值重写 |
| AC-13 | Web 纯逻辑（宽查询 + 归一插入） | members 含 `dev`：查询 `@DEV`（宽规则 `[A-Za-z][A-Za-z0-9-]*`）→ 候选命中 `dev`；插入 → `@dev `，替换区间 anchor=`@`/length=4，文本无残留 `DEV`。**注意**：宽规则只用于光标处查询，`@DEV` 手打直发仍不 addressed（后端严格规则），属已知行为 |

## 3. 可测性约束（阻塞级，请 architect/dev 在实现前定夺）

本仓库 `web/` 侧**没有 jsdom / happy-dom / @testing-library**（`package.json` devDeps 仅有 `vitest`、`ink-testing-library`），现有 `test/web/*.test.ts` 全是**纯函数**测试（`highlight`、`state`、`api` 桩）。

→ 结论：`RoomView` 的 DOM 交互（光标位置、浮层点击、IME、keydown）**当前无法自动化**。
为了让 AC-3/4/6/7 可测，请在实现时把下列逻辑抽成 `web/src/` 下的**纯模块**（无 React/DOM 依赖），组件只做胶水：

1. `mentionQuery(text, caret)`：从光标处向左解析当前 `@` 查询。**两套规则分工**：光标处查询用**宽规则** `@` + `[A-Za-z][A-Za-z0-9-]*`（大小写不敏感，仅用于匹配/替换区间）；`@` 后首字符不在字符集内（`@1`/`@ `/`@×`）→ 返回 `null`（关闭浮层，不展示全部成员）。**已 @ 排除（FR-2.7）另用严格规则** `@` + `[a-z][a-z0-9-]*`（与后端同源），两套不得混用。
2. `mentionCandidates(query, members, text)`：过滤 + `all` 项 + FR-2.7 排除 + 排序。
3. `insertMention(text, caret, name)`：光标处替换/插入，返回 `{ text, caret }`。
4. `rosterRows(members, coordinator, botStates)`：名册行（含状态文案）。
5. `mentionKeydown(state, event)`（可选）：`{key, isComposing, open}` → `{action}` 纯判定。

若坚持不抽纯模块，则 AC-3/4/6(cursor/IME 部分) 只能降级为**手工验收步骤**，我会在报告里明确标注「未自动化」，不当绿报。

## 4. AC-12 边界：已裁决为方案 A（对齐后端，QA 已钉真值）

我用**真实后端**跑了一遍（`parseRoomMentions`）并私发 pm；pm 采纳方案 A（对齐后端，否决前端截 `-`），PRD FR-1.4/AC-12 已按下列真值重写：

| 输入 | 后端 `addressed` | 后端 `body` | 说明 |
| --- | --- | --- | --- |
| `@dev-`（无 `dev-` 成员） | `[]` | 保留 `@dev-` | `-` 属名字字符，token=`dev-`，不截成 `dev` |
| `@dev-`（含 `dev-` 成员） | `["dev-"]` | `""` | 精确名优先 |
| `@dev,` | `["dev"]` | `,` | 逗号终止 |
| `@dev@` | `["dev"]` | `@` | 第二个 `@` 终止 |
| `@dev@x` | `["dev"]` | `@x` | 同上 |
| `@dev ` | `["dev"]` | `""` | 空格终止 |
| `@deV` | `["de"]` | `V` | 大小写敏感，残留 `V` |
| `@DEV`（全大写，手打直发） | `[]` | 保留 `@DEV` | 后端 regex 只匹配 `[a-z]`；AC-13 的「已知行为」，UI 可宽查询但直发不 addressed |

真值固化在 `test/rob/room-text-mention-boundary.test.ts`（**后端真值，不复用也不与 web 纯函数用例混放**；5 用例，含 AC-13 的 `@DEV` 已知行为）。
另：FR-2.1 定稿——过滤忽略大小写、插入回填规范名 `@dev `；「手打 `@DEV` 不生效」记为已知行为（实测 `addressed=[]`），不建 bug。
FR-2.7/AC-7 的已 @ 排除用**同一 token 规则**：`@dev-` 不隐 `dev`。

## 5. 回归面（不新增语义）

- `test/rob/room-text.test.ts` 保持绿（AC-5/AC-11）。
- 发送语义不变：无浮层时 Enter 发送、Shift+Enter 换行（`RoomView.handleKeyDown` 既有行为，改后不得破）。
- 名册入口沿用页脚 `{room.members.length} 名成员`（FR-3.1），改造成可点，保持文案与计数不变。

## 6. 交付方式

1. 等 architect 出 `docs/design/room-mention-and-roster.md`（含纯模块签名）。
2. dev 小步实现并 commit 后，我按 commit 范围跑：`npx vitest run test/web test/rob/room-text.test.ts`。
3. 报告逐条给 AC 结论 + 最简复现命令；diff 范围限本需求文件，`screenshots/**` 噪声不入 diff。

## 7. 用例清单（`test/web/mention.test.ts` —— 已跑实）

> 签名来自 `docs/design/room-mention-and-roster.md` §3（**未变**）。纯函数，**不引入 jsdom**（FR-5.3）。
> `web/src/mention.ts`：committed `c186bc6`，dev 有**未提交 WIP**（App/RoomView/mention.ts 均 `M`）已修 §7.1/§7.2。
> 实跑 `npx vitest run test/web/mention.test.ts`（**工作区**）→ **29 passed / 29** ✅；
> 对 committed `c186bc6` 则为 **27 passed / 2 failed**（AC-3 与 lastIndex 双 RED，见 §7.1/§7.2）。

| 用例组 | AC | 目标函数 | 断言（工作区实跑） |
| --- | --- | --- | --- |
| mentionQuery (Q) | AC-12/13 | `mentionQuery` | `@`→{0,1,""}；`@DEV`/`@Dev`→{0,4,"dev"}；`hi @d`→{3,2,"d"}；`,`/`@`/空格 终止；`@dev-`→query `dev-` 不终止；`@1`/`@ `/`@×`/无@ → null ✅ |
| mentionedNames (B) | AC-7/12 | `mentionedNames` | `@dev @worker`→[dev,worker]；`@dev-`→[dev-]；`@deV`→[de]；`@DEV`→[]；skipIndex 跳过自身 ✅；**共享 /g lastIndex 被污染时不过滤** ❌（§7.2） |
| mentionState | AC-1/2/7/13 | `mentionState` | `@`→[dev,worker,all]（all broadcast=true、末尾）；`@d`/`@D`→[dev]；`@zz`→[]；`@DEV`→query dev 命中 dev；`@dev @`→[worker,all]；`@all @`→[dev,worker]；真成员 all→普通成员；`@1`→null ✅ |
| insertMention | AC-3/13 | `insertMention` | `@DEV`→{`@dev `,5}；`a @d b`(caret4)→{`a @dev  b`,7}；无查询→原样；caret 在 token 内 `@dev`(2)→{`@dev `,5}、`@dev`(3)→{`@dev `,5}、`@devX`(4)→{`@dev `,5} ✅（工作区；committed c186bc6 此项 ❌） |
| rosterRows | AC-8/10 | `rosterRows` | 全量+`isCoordinator`+`statusLabel`；无状态→空闲；四状态映射；`[]`→`[]` ✅ |
| mentionKeydown/moveIndex | AC-4/6 | `mentionKeydown`/`moveIndex` | open+Enter/Tab→select；open+Esc→close；!open+Enter→submit；!open+Shift+Enter→none；isComposing→none；moveIndex 循环、count=0→0 ✅ |
| AC-9 同源 | AC-9 | `mentionState`+`rosterRows` | members 变化时候选与名册**同时**变；名册恒为全量、不受候选排除影响 ✅ |

### 7.1 AC-3 替换延伸到 Q-token 末尾

- 复现：`npx vitest run test/web/mention.test.ts -t "replacement extends"`
- 最小用例：`insertMention("@dev", 2, "dev")`
  - 期望：`{ text: "@dev ", caret: 5 }`
  - committed `c186bc6` 实得：`{ text: "@dev ev", caret: 5 }`（保留尾段 `ev`）
  - **工作区 WIP 已修**（新增 `tokenEnd()`，替换右界向右吃掉 `[A-Za-z0-9-]`）：现为 `{"@dev ",5}` ✅
- 另两例同组：`insertMention("@dev",3,"dev")`、`insertMention("@devX",4,"dev")` 均 → `{"@dev ",5}` ✅（工作区）
- 状态：**待 dev 提交**（committed 版仍 RED）；提交后此项转绿。

### 7.2 mentionedNames 受共享 /g lastIndex 污染而漏扫（缺陷待 dev 修）

- 复现（pm 首先复现，qa 已钉为用例）：`npx vitest run test/web/mention.test.ts -t "polluted shared"`
- 最小用例：
  ```ts
  MENTION_RE.lastIndex = 5;          // 或先 MENTION_RE.test("@dev") 置非零
  mentionedNames("@dev @worker");    // 期望 ["dev","worker"]，实得 ["worker"]（丢 dev）
  ```
- 根因：`mentionedNames` 用 `text.matchAll(MENTION_RE)`，而 `MENTION_RE` 是**模块级导出 /g 正则**；`matchAll` 会把该 regex 的 `lastIndex` **拷贝为起始偏移**，故外部任何 `.test()/.exec()` 留下的非零 `lastIndex` 都会让本次扫描从中间开始、漏掉前面的匹配。
- 修法：`mentionedNames` 内用**局部** regex（`/@([a-z][a-z0-9-]*)/g`），或在函数入口 `MENTION_RE.lastIndex = 0`。
- 影响：AC-7「重复 @ 同一成员从候选消失」依赖 `mentionedNames`；漏扫会**漏排除**（已 @ 的成员重新出现），且仅在共享 regex 被外部使用过时触发，属**间歇性**缺陷。
- 现状：工作区与 committed **都仍 RED**（28/29）。

**AC-9（同源）** 纯函数层两条已断言（「AC-9: candidates and roster stay same-source」）；state 层**单一写入源**由既有 `test/web/state.test.ts` 的 `members` 事件用例（约 :512-529）钉住。

## 7.3 只能人工/集成的条目（显式标注，不当绿报）

| AC | 为何不能纯测 | 人工/集成步骤 |
| --- | --- | --- |
| AC-6（组件侧） | 「合成期不弹候选 / onChange 合成期不出浮层」依赖 DOM/IME 事件；本仓无 jsdom（FR-5.3）。architect 明确 `mentionState` **不加 `isComposing`** | 中文输入法组合期敲 `@x`，确认浮层不弹、Enter 不发送（纯函数侧 `mentionKeydown({isComposing:true})==="none"` 已自动覆盖） |
| AC-4（回归） | 浮层关闭且 `running` 时 `Esc` 触发中断，是 `RoomView` 既有行为 | 房间运行中、浮层关闭时按 `Esc` → 触发中断；浮层开启时 `Esc` → 仅关浮层不中断 |
| AC-8/AC-3/AC-1/AC-2 的 UI 呈现 | 下拉渲染、浮窗、caret 回填、点击外部关闭 | 手工：打 `@`/`@d` 看候选；点候选项看回填与光标；点页脚「N 名成员」看浮窗 |

**两套规则分工**（dev 实现红线，qa 断言据此）：
- **严格规则 B**（与后端 `parseRoomMentions` 同源）：`@` + 贪婪 `[a-z][a-z0-9-]*`，用于 FR-2.7 已 @ 排除、AC-11/AC-12 真值；`-` 属字符集、大写/`,`/`@`/空格/CJK 终止。
- **宽规则 Q**（仅光标处查询/替换区间）：`@` + 大小写不敏感 `[A-Za-z][A-Za-z0-9-]*`；首字符在字符集外（`@1`/`@ `/`@×`）→ `null` 关浮层。
- 插入一律回填**规范小写名**；替换区间覆盖**整个 Q-token**。

## 8. 最终结论（最终 HEAD 18022f5..0f640ec 复跑，5 笔）

> 最终报告：`docs/deliverables/20261016-room-mention-roster-qa-report.md`

- `test/web/mention.test.ts`：**32 / 32 passed** ✅（+3 `clampIndex`）
- `test/web/state.test.ts`：**28 / 28**（AC-9 state 层单一源）
- `test/rob/room-text.test.ts`：**17 / 17**（AC-5/AC-11 后端真值）
- `test/rob/room-text-mention-boundary.test.ts`：**5 / 5**（AC-12 真值表）
- **合计 4 files / 82 passed**；全量 159 files / 1405 passed（clean HOME）。
- AC 判定：**13/13 达成**。自动化绿：AC-1/2/3/5/7/8/9/10/11/12/13；人工/集成：AC-3 组件路径（`c0661ef` 已修复并经代码复核）、AC-4 regression、AC-6 后半。
- 修复史：`e8f3509`（79 绿，AC-3 组件红，review 打回）→ `c0661ef`（`recomputeMention` 不再碰 index、`onKeyUp` 方向键 early-return、`activeIndex=clampIndex` 接线、补 `clampIndex` 用例）→ 82 绿。
- 已由 dev 提交为 `0f640ec`（test-only），用例数不变（仍 32），最终 82/82 复跑确认。
