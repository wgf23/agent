# 交付：房间 @ 成员选择器 + 成员名册

- 日期（UTC）：2026-10-16T14:32:23Z
- 房间：`rnd`（coordinator = pm）
- 状态：**已交付 · 终判锁定（包含口径）**（验收 13/13 达成，无未决 AC）
- **终判锚点（最终）**：远端 `origin/main` = **`ad3b41aaa6ed090c059df45cdb6317481f7f7707`**；本线基线 `0f640ec` **为其祖先**（`git merge-base --is-ancestor 0f640ec ad3b41a` = YES，仍在 main 历史内）
- 需求文档：`docs/prd/room-mention-and-roster.md`（confirmed）
- 设计文档：`docs/design/room-mention-and-roster.md`
- 测试计划：`docs/deliverables/20261016-room-mention-roster-test-plan.md`
- QA 报告：`docs/deliverables/20261016-room-mention-roster-qa-report.md`

---

## 1. 用户诉求

> 在群组里输入 `@` 后应能**选择** @ 谁（而不是全靠手输）；并且需要**一个地方能看到群里都有谁**。

---

## 2. 范围拍板（用户已确认）

| # | 问题 | 决定 |
| - | --- | --- |
| 1 | 客户端范围 | 只做 **Web UI**；TUI 二期 |
| 2 | 名册形态 | **点击打开的浮窗**（非常驻侧栏） |
| 3 | `@all` 候选项 | **提供** |
| 4 | 名册显示状态 | **显示**每个成员状态（复用 `state.botStates` + `STATUS_LABEL`） |
| 5 | 候选排除已 @ | **排除**已 @ 的成员 |

**不做**：不改后端 `parseRoomMentions`；不新增协议字段；不做成员增删/邀请 UI；不做 DM 的 @ 选择器；不做常驻侧栏；不做 TUI。

---

## 3. 关键技术裁决

### 3.1 两套 token 规则（禁止混用）

| 规则 | 正则 | 用途 |
| --- | --- | --- |
| **Q：光标查询 token** | `@[A-Za-z][A-Za-z0-9-]*`（宽、大小写不敏感） | 下拉触发 / anchor / **替换区间 length** / 前缀过滤 |
| **B：后端判定 token** | `@[a-z][a-z0-9-]*`（严格，与 `parseRoomMentions` 完全一致） | FR-2.7 已 @ 排除、AC-11/AC-12 真值表、发送后 `addressed` |

- `-` 在两套里**都是名字合法字符、都不是终止符**：`@dev-` 的 token 是 `dev-`，**绝不**截成 `dev`。
- 终止字符：`,`、`@`、空格、大写字母（B 规则）、CJK 等一切字符集外字符。
- **方案 A 裁决**（大写输入）：UI 光标处查询用宽规则，插入**一律回填规范小写名**；`@DEV` → 命中 `dev` → 替换区间覆盖 `@DEV`（anchor=`@`、length=4）→ 插入 `@dev `，**无残留**。手打全大写 `@DEV` 不经候选直接发送不生效，记为**已知行为**，不作缺陷。

### 3.2 可测性硬约束（FR-5）

本仓 web 层**无 jsdom / @testing-library**，`test/web/*` 全为纯逻辑用例。因此 @ 选择器的**查询解析、候选集合计算、替换区间（anchor/length）**必须抽成独立纯函数模块 `web/src/mention.ts`，`RoomView` 只做事件绑定与渲染。**不得为测试引入 jsdom**。AC-1/2/3/6/7/12/13 的逻辑断言落在 `test/web/` 纯函数用例上。

### 3.3 插入替换区间

替换区间 = `@` 起点到 **Q-token 末尾**（非仅到 caret）。caret 落在 token 内部时也延伸到 token end：`"@de|v"` 选中 `dev` → `@dev `，**不得**残留 `ev`；caret 在 token 末尾时行为不变（AC-3）。

---

## 4. 验收结论：AC-1..AC-13 全部达成（13/13）

| AC | 结论 | 取证 |
| --- | --- | --- |
| AC-1 候选 = members ∪ {all}、保序 | ✅ 自动绿 | `test/web/mention.test.ts` mentionState |
| AC-2 前缀过滤 / 无匹配不展示 | ✅ 自动绿 | 同上 |
| AC-3 光标处插入 + token 内替换延伸 | ✅ 自动绿 | insertMention 用例（`"@dev"`(2)→`"@dev "`） |
| AC-4 Esc 关浮层不发送 / Enter=选择 | ✅ 纯函数半绿；组件半**人工/集成** | mentionKeydown 纯用例；「running 且浮层关时 Esc 中断」= RoomView:173 分支 |
| AC-5 `@all` 广播 | ✅ 后端真值 | `test/rob/room-text.test.ts` |
| AC-6 IME 合成期不误触发 | ✅ 纯函数半绿；组件半**人工/集成** | `mentionKeydown({isComposing:true})→"none"`；「合成期不弹候选」= RoomView onChange 守卫 |
| AC-7 重复 @ 同成员从候选消失、`@all` 只隐 all | ✅ 自动绿 | mention.test.ts |
| AC-8 名册全量+协调者+状态 | ✅ 自动绿 | rosterRows 用例（含 STATUS_LABEL 四态） |
| AC-9 候选与名册同源 | ✅ 自动绿（双覆盖） | `test/web/state.test.ts` members 事件 + mention.test.ts same-source |
| AC-10 空成员空态 | ✅ 自动绿 | rosterRows([])==[] |
| AC-11 未匹配 @xxx 回归 | ✅ 后端真值 | `test/rob/room-text.test.ts` |
| AC-12 边界 token 与后端一致 | ✅ 自动绿 | boundary 5 例（`@dev-`→`dev-` 等） |
| AC-13 `@DEV` 归一插入无残留 | ✅ 自动绿 | mention.test.ts |

> **人工/集成项**（按 FR-5 标注，不计自动绿）：AC-4 的「running 且浮层关时 Esc 中断」、AC-6 的「合成期不弹候选浮层」——默认无 jsdom，无法自动测，已在报告显式标注，不当绿报。

---

## 5. 交付物与验证真数

**远端 HEAD**：`0f640ecd4ee5e88c36e37398a9219b73de9d7048`（= 本地 HEAD，`origin/main...HEAD = 0/0`）

**提交（base 18022f5 → HEAD 0f640ec，5 笔）**：

| commit | 内容 |
| --- | --- |
| 244274e | feat(web): add the room mention picker's pure helpers |
| c5053d7 | feat(web): wire the @ picker and member roster into RoomView |
| e8f3509 | test(web): pin the mention picker, roster and the backend boundary |
| c0661ef | fix(web): keep the mention highlight on the live candidate list |
| 0f640ec | test(web): pin the mention source string, not a stateful regex |

**文件范围（6 个，红线零命中）**：`web/src/mention.ts`、`web/src/components/RoomView.tsx`、`web/src/App.tsx`、`web/src/styles.css`、`test/web/mention.test.ts`、`test/rob/room-text-mention-boundary.test.ts`。

**pm 独立复跑（push 后 HEAD，工作区干净）**：
- `test/web/mention.test.ts` 32 + `test/web/state.test.ts` 28 + `test/rob/room-text.test.ts` 17 + `test/rob/room-text-mention-boundary.test.ts` 5 = **4 files / 82 passed**。
- 后端 `room-text.ts` **未改动**，AC-5/AC-11 后端回归面保持绿。

**ci（远端 HEAD 0f640ec 最终回执）**：typecheck root+web 0 错 / biome 391 files 0 error·0 info / 干净 HOME test 159/159 文件 · 1405/1405 用例 / build `dist/index.js` 632.36KB + web 567.37KB；全部 **exit 0**；红线四项零命中。0f640ec 为 test-only、不增用例，数字与 c0661ef 一致（159/1405），符合预期。

---

## 6. 过程要点（返工与堵漏）

1. **AC-12 冲突裁决**：qa/review 各自实测指出 PRD 原文字 `@dev-`→`dev` 与后端矛盾（`-` 属名字字符）。裁决**方案 A**（前端 token 规则与后端完全一致），否决方案 B（前端截 `-`）。已改 PRD FR-1.4/AC-12。
2. **AC-13 新增**：review 指出 FR-1.4 严格小写与 FR-2.1 忽略大小写在大写输入下互斥。裁决**方案 A**：宽查询 + 归一插入，新增 AC-13（`@DEV`→`@dev ` 无残留）。
3. **AC-3 打回再交付**：dev 首版删 `setIndex(0)` 引入 index 越界风险；打回后以 `clampIndex(index,count)` 兜底并抽成纯函数 + 5 条断言，`RoomView:70` 接线。复判转绿。
4. **测试假阴性堵漏**：c0661ef 的 lastIndex 回归用例污染的是自建局部 regex → 恒过。qa 补结构性断言 `expect(MENTION_RE_SOURCE).not.toBeInstanceOf(RegExp)`（第 5 笔 0f640ec）真正 pin 住「模块导出 source 串而非有状态 /g 实例」。
5. **红线纪律**：全程仅动 web/ + 两个测试文件，未触碰 `src/tui/**`、`screenshots/**`、`shared/protocol.ts`、`src/rob/room-text.ts`。

---

## 7. 后续待办（非本线承诺）

- TUI 侧 @ 选择器（二期）。
- 成员名册「状态」的实时刷新粒度若不足，另开设计评估。
- 数字口径提醒：测试基数已由 157 文件/1368 用例变为 159 文件/1405 用例（新基线），后续对账按新数字。
- **review 可选加固 nit（leader 挂账，不计入本轮）**：`mention` 模块快照不随 `members` 重算；另可加导出遍历断言（`Object.values(mention)` 中无 `RegExp` 实例），把「导出的是 source 串而非有状态 /g 实例」从单点断言升级为结构性护栏。

---

## 8. 终判锁定（包含口径 · 2026-10-16）

形式保留（「远端 hash 精确等于 0f640ec」）因远端后续前进而**解除**，改为**包含口径**，由 leader 触发、pm 独立复验全部满足：

| 终判输入 | 实测 | 结果 |
| --- | --- | --- |
| ① 远端 hash | `ls-remote origin refs/heads/main` = **`ad3b41a`**；`0f640ec` 为其**祖先**（`merge-base --is-ancestor` = YES） | ✅ |
| ② 该 hash 4 文件真数 | pm 在 `ad3b41a` 复跑 `mention 32 + state 28 + room-text 17 + boundary 5` = **4 files / 82 passed** | ✅ |
| ③ ci exit 0 + 红线 | ci 对含 `0f640ec` 的远端范围 exit 0（干净 HOME **161 文件 / 1435 用例**、0 error·0 info）；红线四项零命中 | ✅ |

**基座未被触碰（关键）**：`git diff --name-only 0f640ec..ad3b41a -- web/src/mention.ts web/src/components/RoomView.tsx test/web/mention.test.ts test/rob/room-text-mention-boundary.test.ts` = **空**（本线 4 个产物在后继提交中逐字未变）；后继仅扩展 `App.tsx`/`state.ts`/`styles.css` 等（分区线与移动端线）。

**并集范围**：`18022f5..ad3b41a` = **18 笔 / 14 文件**，红线四项**零命中**。

**终判：AC-1..AC-13 = 13/13 达成**（自动绿 11：AC-1/2/3/5/7/8/9/10/11/12/13；纯函数半绿 + 组件半人工/集成 2：AC-4、AC-6，按 FR-5 不计自动绿）。**本线闭环。**
