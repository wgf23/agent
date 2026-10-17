# 设计：房间 @ 成员选择器 + 成员名册

- 作者：rob "architect" ｜ 状态：定稿，可直接实现
- 关联 PRD：`docs/prd/room-mention-and-roster.md`（confirmed；AC-12 裁决=对齐后端、**AC-13 新增**=大写查询归一插入）
- 关联代码：`src/rob/room-text.ts`（后端 `parseRoomMentions`，**判定语义**真源）、
  `web/src/components/RoomView.tsx`（房间输入框）、`web/src/state.ts`（`ClientRoom.members` / `botStates`）、
  `web/src/status.ts`（`STATUS_LABEL`）、`web/src/names.ts`（`NAME_RULE`）、`web/src/App.tsx:207`

> 硬约束（PRD FR-5）：web 层**无 jsdom / @testing-library**，`test/web/*` 全是纯逻辑用例。
> 因此 @ 选择器的**查询解析、候选计算、替换区间**抽成**独立纯模块 `web/src/mention.ts`**，
> 组件只做事件绑定与渲染。**不得引入新的测试依赖**（jsdom 等）。

---

## 1. 模块边界

```
web/src/mention.ts        纯函数：解析 / 候选 / 插入 / 名册 / 键盘判定   ← qa 在此写 test/web/mention.test.ts
web/src/components/RoomView.tsx   只做：事件绑定 + 渲染下拉与名册浮窗
web/src/App.tsx           传 botStates={state.botStates} 给 RoomView
web/src/styles.css        新增 .mention-menu / .roster-* 样式
```

- `mention.ts` **不得 import React / DOM**；只可 import `./status.js`（`STATUS_LABEL`，纯常量）与类型。
- Web 侧**独立实现**，不共享 `src/tui/suggestions.ts`（TUI 用「整行前缀」锚点，Web 是「光标处 token」，语义不同）。
- **不改** `src/rob/room-text.ts`、**不改** `shared/protocol.ts`/SSE。

---

## 2. 两套 token 规则（**必须分工，禁止混用**）—— 方案 A 裁决

这是本设计的关键约束。UI 的「光标处查询」与后端的「语义判定」用**两套字符集**：

| 规则 | 正则 | 用途 | 大小写 |
|---|---|---|---|
| **Q：光标查询 token** | `@[A-Za-z][A-Za-z0-9-]*`（宽，大小写不敏感） | 下拉 trigger / anchor / **替换区间 length** / 前缀过滤 | 不敏感 |
| **B：后端判定 token** | `@[a-z][a-z0-9-]*`（strict，与 `parseRoomMentions:32` **完全一致**） | FR-2.7 已 @ 排除、AC-11/AC-12 真值表 | **敏感** |

- 两套规则的**唯一差异是大写字母**：`-` 在两套里**都是名字合法字符、都不是终止符**；`,`/`@`/空格/CJK 在两套里都终止。
- **Q 用于「用户正在打什么」**：`@DEV` 的 Q-token 是 `DEV`，查询归一为小写 `dev`，替换区间覆盖 `@DEV` 全部 4 字符 → 选中插入 `@dev `，**无残留**（AC-13）。
- **B 用于「这段文本里已经 @ 了谁」**：成员名规范本就是全小写（`NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/`），
  所以 B 的 strict 小写匹配即可判定；后端正是在**发送时**用 B 判定 addressed。
- 后果声明（PRD FR-1.4 已注明）：**手打全大写 `@DEV` 直接发送，后端不识别**（B 判定 addressed=[]），
  这是后端既有行为，不是本设计缺陷；UI 只保证**从下拉选中**时回填规范小写名。

### 2.1 Q 规则契约真值表（光标处查询 / 替换区间）

设 caret 在 token 末尾；`anchor` = `@` 下标，`length = caret - anchor`。

**替换区间的终点 = Q-token 末尾**（不是 caret）。caret 落在 token 内部时向右延伸到 token end，
这样「选中即补全整词」，避免 `"@de|v"` 选 `dev` 得 `"@dev ev"` 的文本损坏（PM 裁决，PRD FR-2.4 已写明）。
caret 在 token 末尾时与旧口径一致（无行为变化）。

| 输入（caret 位置） | Q-token | query(小写) | 替换区间 | 说明 |
|---|---|---|---|---|
| `@` | `""` | `""` | `@`（len 1） | 刚敲下 |
| `@DEV` | `DEV` | `dev` | `@DEV`（len 4） | **AC-13**：命中 `dev`，插入 `@dev ` |
| `@Dev` | `Dev` | `dev` | `@Dev`（len 4） | 混大小写同样归一 |
| `@dev,`（caret=4） | `dev` | `dev` | `@dev`（len 4） | `,` 终止，`,` 不动 |
| `@dev@`（caret=4） | `dev` | `dev` | `@dev`（len 4） | `@` 终止，残留 `@` |
| `@dev-`（caret=5） | `dev-` | `dev-` | `@dev-`（len 5） | `-` 不终止（与 B 一致） |
| `@dev `（caret=4） | `dev` | `dev` | `@dev`（len 4） | 空格终止 |
| **`@de\|v`（caret=3）** | `de` | `de` | **`@dev`（延伸到 token end，len 4）** | **AC-3**：插入 `@dev `，无残留 `v` |
| **`@devX`（caret=4）** | `dev` | `dev` | **`@devX`（len 5）** | 选中后 `@dev `，无残留 `X` |
| `@1` / `@ ` / `@×` | 无效 | — | — | 首字符不在 `[A-Za-z]` → **无查询、关浮层**（不回退成「全部」） |

> 区间终点实现：拿到 `mentionQuery(text, caret)` 后，从 `caret` 向右吞掉连续的 `[A-Za-z0-9-]` 得到 `end`
> （`-` 是 token 字符，与 B 一致）；替换 `[anchor, end)`。`end >= caret` 恒成立，故 caret 在末尾时 `end === caret`。

### 2.2 B 规则契约真值表（已 @ 排除 / 与后端对齐，已实跑核对）

| 输入文本（成员含 `dev`） | B-token / 后端 addressed | 说明 |
|---|---|---|
| `@dev` | `dev` | 正常 |
| `@dev ` | `dev` | 空格终止 |
| `@dev,` | `dev` | `,` 终止 |
| `@dev@x` | `dev`（残留 `@x`） | `@` 终止 |
| `@dev-` | **`dev-`** → 无成员 `dev-` 则 addressed=[] | `-` 不终止 |
| `@deV` | token `de`（大写终止） | 精确排除 `de`（若存在），不排 `dev` |
| `@DEV` | 无 mention | 大写不识别 |
| `@ all` | 无 mention | 空格 |

> AC-12 断言 §2.2；AC-13 断言 §2.1 的 `@DEV` 行。**Q 与 B 不得互换**：
> 例如用 B 做 Q 会得到 `@DEV`→空 token+区间只有 `@`→残留 `DEV`（review 指出的矛盾）。

---

## 3. 纯模块接口（`web/src/mention.ts`）

```ts
import type { BotState } from "./protocol.js";   // 类型
import { STATUS_LABEL } from "./status.js";        // 纯常量

/** B：后端判定 token（与 src/rob/room-text.ts:32 完全一致）。用于已 @ 排除。 */
export const MENTION_RE = /@([a-z][a-z0-9-]*)/g;
/** Q：光标查询 token（大小写不敏感，用于下拉 trigger/anchor/替换区间）。 */
export const QUERY_TOKEN_RE = /@[A-Za-z][A-Za-z0-9-]*/;
const QUERY_TAIL_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

// ---- 3.1 查询解析（Q 规则）----------------------------------------------

export interface MentionQuery {
  anchor: number;       // `@` 下标
  length: number;       // caret - anchor，覆盖 `@` + 已输入前缀
  query: string;        // 已输入前缀，**已归一为小写**（用于过滤）
}

/**
 * 从光标向前找「当前正在输入的 @ token」，按 Q 规则。
 * 判定：anchor = text.lastIndexOf("@", caret - 1)；
 *       seg = text.slice(anchor + 1, caret)；
 *       若 anchor >= 0 且 (seg === "" 或 QUERY_TAIL_RE.test(seg)) → { anchor, length: caret - anchor, query: seg.toLowerCase() }；
 *       否则 null（首字符在字符集外 → null，不回退成「全部」）。
 * 只验证 caret 左侧；caret 右侧的 token 余量由 insertMention 向右吞掉（替换到 Q-token 末尾）。
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null;

// ---- 3.2 已 @ 排除（B 规则，FR-2.7）-------------------------------------

/**
 * 扫全文所有 B-token（`@([a-z][a-z0-9-]*)`），返回出现过的**字面名字**（去重）。
 * skipIndex：跳过起始于该下标的匹配（= 当前 anchor），避免正在输入的 token 排除自己。
 * 实现注意：**不要**对模块级 `/g` 常量调 `.test()`/`.exec()`（`/g` 带 lastIndex 状态，会跨调用污染）；
 * 用 `text.matchAll(new RegExp(MENTION_SOURCE, "g"))` 或函数内局部正则。
 */
export function mentionedNames(text: string, skipIndex?: number): string[];

// ---- 3.3 候选计算（FR-1 / FR-2.1 / FR-2.7 / FR-1.2）----------------------

export interface MentionCandidate {
  name: string;          // 规范小写成员名，或广播项 "all"
  label: string;         // "@dev" / "@all 所有人"
  broadcast: boolean;    // true = 无同名成员 "all" 时的广播项
}

export interface MentionState {
  anchor: number;
  length: number;
  query: string;
  candidates: MentionCandidate[];
}

/**
 * 一步到位：查询 + 候选。mentionQuery 为 null 时返回 null。
 * 候选：
 *   1) 成员保持顺序，逐个保留：name 未被 mentionedNames(text, anchor) 命中，
 *      且 name.toLowerCase().startsWith(query)（query 已小写；成员名为规范小写，等价前缀）。
 *   2) 广播项：仅当 members 不含字面 "all" 时，在**末尾**追加，
 *      条件 !mentioned.has("all") && "all".startsWith(query)。
 *      members 含 "all" 时它是普通成员（按序、broadcast=false、addressed=["all"] 非广播，FR-1.2）。
 * 注意：排除用 B 规则、过滤用 Q 查询，两套并存但各司其职。
 */
export function mentionState(input: {
  text: string;
  caret: number;
  members: readonly string[];
}): MentionState | null;

// ---- 3.4 插入（Q 规则 / FR-2.4 / AC-3 / AC-13）-------------------------

export interface InsertResult {
  text: string;
  caret: number;
}

/**
 * 用规范小写名替换 `[anchor, end)`：anchor 由 `mentionQuery(text, caret)` 求得，
 * end = 从 caret 向右吞掉连续 `[A-Za-z0-9-]` 后的下标（**Q-token 末尾**；caret 在末尾时 end===caret）。
 * 结果 = text.slice(0,anchor) + `@${name} ` + text.slice(end)；新 caret = anchor + name.length + 2。
 * mentionQuery 为 null 时原样返回（不抛错、不改）。
 * 尾随空格是契约的一部分（FR-2.4），便于继续 @ 下一个成员。
 * 终点取 token end 而非 caret：避免 `"@de|v"` 选 dev 得 `"@dev ev"` 的损坏（PM 裁决，AC-3）。
 */
export function insertMention(text: string, caret: number, name: string): InsertResult;

// ---- 3.5 名册（FR-3 / AC-8 / AC-10）------------------------------------

export interface RosterRow {
  name: string;
  label: string;          // "@dev"
  isCoordinator: boolean;
  statusLabel: string;    // STATUS_LABEL[botStates[name]?.status ?? "idle"]
}

/** 全量成员（不受 FR-2.7 排除影响），顺序 = members；无状态按 "idle"；空则 []。 */
export function rosterRows(
  members: readonly string[],
  coordinator: string | null,
  botStates: Record<string, BotState>,
): RosterRow[];

// ---- 3.6 键盘判定（AC-4 / AC-6）----------------------------------------

export type MentionAction = "submit" | "select" | "close" | "none";

/**
 *   isComposing                 → "none"（IME 合成中，抑制选择与发送）
 *   open && key === "Enter"     → "select"
 *   open && key === "Tab"       → "select"
 *   open && key === "Escape"    → "close"（不发送）
 *   !open && key === "Enter" && !shiftKey → "submit"
 *   !open && key === "Escape"   → "none"（组件**必须**让此分支 fallthrough 到 running 的中断逻辑，AC-4 回归）
 *   其它                         → "none"
 */
export function mentionKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  open: boolean;
}): MentionAction;

/** 高亮循环移动（↑/↓），count=0 → 0。 */
export function moveIndex(index: number, count: number, delta: 1 | -1): number;
```

> 相对 qa 初稿的两处调整：①`mentionQuery` 出参是 `{anchor, length, query}`（PM 要求明确 length，覆盖 `@DEV`）；
> ②排除并入 `mentionState` 内部（需 `caret` 区分「正在输入」与「已完成」，否则成员名恰为输入前缀时会自我排除）。
> `mentionQuery` / `mentionedNames` / `insertMention` 均可独立单测。

---

## 4. 组件改动（`RoomView.tsx`）

### 4.1 新 prop（FR-4.2）

```ts
interface Props {
  room: ClientRoom;
  configured: boolean;
  botStates: Record<string, BotState>;   // 新增
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
}
```

`App.tsx:207` 补 `botStates={state.botStates}`（该 prop 已在 `state` 上，无需新协议字段）。

### 4.2 本地状态与事件

- `const [mention, setMention] = useState<MentionState | null>(null)`；`const [dismissed, setDismissed] = useState(false)`
  （Esc/失焦/提交后置真；`value` 或 caret 变化置假，等价 TUI 的 `MENU_NEUTRAL`）；`const [index, setIndex] = useState(0)`。
- **受控输入读精确 caret**：`onChange` 用 `event.target.selectionStart`（React 受控 textarea 中 `selectionStart` 在 onChange 时可靠），
  `mentionState({ text: event.target.value, caret, members: room.members })`；caret 变化用 `onSelect`/`onKeyUp`/`onClick` 重算。
- **IME 合成期守卫（必需，AC-6）**：`onChange` 里若 `event.nativeEvent.isComposing` 为真，**直接 `setMention(null)` 返回**，不调用 `mentionState`；
  IME 合成的中间态（如拼音串）因此**不产生候选浮层**。`mentionState` 签名**不加** `isComposing`（避免 qa 已冻结的用例签名漂移），
  守卫放在组件层；该行为为组件级、人工/集成验证。`onCompositionStart/End` 可选用于清理。
- `open = mention !== null && mention.candidates.length > 0 && !dismissed`。
- `onKeyDown` 先 `mentionKeydown({key, shiftKey, isComposing: event.nativeEvent.isComposing, open})`：
  - `"select"`：`preventDefault()`；取 `mention.candidates[index]`；`insertMention(value, caret, choice.name)`；
    `setValue(next.text)` 后 `textareaRef.current?.setSelectionRange(next.caret, next.caret)`；重置 `mention/dismissed`。
  - `"close"`：`preventDefault()`，`setDismissed(true)`（**不发送**，AC-4）。
  - `"submit"`：走既有 `submit()`。
  - `"none"`：放行（`↑/↓` 用 `moveIndex` 处理并 `preventDefault`）。
- **Esc 回归保护（AC-4）**：浮层**关闭**且 `running` 时，`Esc` 必须仍走既有中断分支（现 `RoomView.tsx:106-109` 的
  `if (event.key === "Escape" && running) { interrupt(); }`）。`mentionKeydown` 在 `!open` 时对 Escape 返回 `"none"`，
  组件**必须保留该 fallthrough 分支**，不要被 mention 逻辑吞掉。
- 鼠标：候选项 `onMouseDown`（blur 前触发）走同一选取路径；点浮层外 / `Esc` 关闭。

### 4.3 渲染

- 下拉：`open && <ul className="mention-menu" role="listbox">`，每项 `role="option"`、`aria-selected={i===index}`，
  显示 `candidate.label`（`@all` 项文案「所有人」区分，FR-1.3）；定位在 `.composer` 上方。
- 名册入口：页脚 `{room.members.length} 名成员`（`:202`）改为 `<button className="roster-trigger" aria-haspopup="dialog">`。
- 名册浮窗：`RosterDialog`（可内联或单独文件），复用现有 `.modal-backdrop`/`.modal`（`styles.css:2188`），
  `role="dialog" aria-modal="true"`；渲染 `rosterRows(room.members, room.coordinator, botStates)`：名字 + 协调者标签 +
  状态 pill（`statusLabel`，复用 `.status-pill`/`.status-dot`，参考 `BotPlaza.tsx:53-68`）；
  关闭：`Esc` / 点 backdrop / 再点入口。`members` 为空显示空态（AC-10）。

### 4.4 同源保证（AC-9）

候选与名册**都只读 `room.members`**（名册再加 `room.coordinator`/`botStates`），不从别处拼名单；
`members` 事件 → `ClientRoom.members` 更新 → 两处随 props 重渲染，天然同步。
`mentionState` 与 `rosterRows` 均接 `members` 入参，便于在 `test/web/` 断言同源。

---

## 5. AC ↔ 模块 映射（供 qa / review）

| AC | 取证点（`test/web/mention.test.ts`） | 组件侧（人工/集成） |
|---|---|---|
| AC-1 候选 = members ∪ {all}，顺序 | `mentionState` query="" | 下拉渲染 |
| AC-2 `@d`→dev；`@zz`→空 | `mentionState` 前缀过滤 | 下拉隐藏 |
| AC-3 光标处替换、`@<name> ` | `insertMention` 替换到 **Q-token 末尾**（`"@de\|v"`→`@dev `、文本中间插入不破坏前后文） | 回填 caret |
| AC-4 Esc 关不发送；Enter 选择非发送 | `mentionKeydown` close/select | 事件绑定 + **浮层关闭且 running 时 Esc 仍中断**（保留 RoomView:106-109） |
| AC-5 `@all` → 全员 | 复用 `test/rob/room-text.test.ts` | — |
| AC-6 IME 合成不误触发 | `mentionKeydown({isComposing:true})==="none"` | **合成期不产生候选浮层**（onChange 守卫，人工/集成） |
| AC-7 重复 @ 同一成员消失、仍可手打 | `mentionState` + `mentionedNames(skipIndex)` | — |
| AC-8 名册全量+协调者+状态 | `rosterRows` | 浮窗渲染 |
| AC-9 成员变化两处同源 | `mentionState`/`rosterRows` 共用 `members`（state 层断言） | 重渲染 |
| AC-10 空成员空态 | `rosterRows([])`===[] | 空态文案 |
| AC-11 未匹配 `@xxx` 不变 | 回归：`test/rob/room-text.test.ts` 保持绿 | — |
| AC-12 边界字符对齐后端（B 规则） | `mentionQuery`+`mentionedNames` 按 §2.2（`@dev-`→`dev-` 不截断、`@deV`→`de`、`@dev,`→`dev`） | — |
| **AC-13** `@DEV` 命中 `dev`、插入 `@dev `、无残留 | `mentionQuery`(Q)+`insertMention` 按 §2.1（length=4） | — |

---

## 6. 任务拆分（交 dev，小步提交）

1. `web/src/mention.ts`：§3 全部纯函数（无 React/DOM；复用 `./status.js`）。
2. `web/src/App.tsx`：给 `RoomView` 传 `botStates={state.botStates}`。
3. `web/src/components/RoomView.tsx`：接 prop、接 §4 事件绑定、下拉渲染、页脚入口 + 名册浮窗。
4. `web/src/styles.css`：`.mention-menu` / `.roster-*`（对齐现有 `.modal`/`.status-pill` 变量）。
5. 测试（qa 主写，dev 可先放骨架）：`test/web/mention.test.ts` 覆盖 AC-1/2/3/6/7/12/13；
   AC-9 在 `test/web/state.test.ts` 补同源断言。**不新增依赖**（FR-5.3）。

---

## 7. 明确不做 / 边界

- **不做 TUI**（二期）；**不改**后端 `parseRoomMentions`（AC-11 回归保护）。
- 不新增协议字段 / 服务端事件（FR-4.1）；`botStates` 是既有前端 state。
- **Q（宽）与 B（strict）两套 token 规则的边界是本设计的核心**：Q 管 UI 查询/锚点/替换，B 管已 @ 排除与后端判定；
  任何一处混淆都会导致 §2.1/§2.2 真值表出错。评审以此为红线。
- 手打全大写 `@DEV` 直接发送后端不识别 = 已知行为（FR-1.4），非缺陷。
- 候选不设上限；`all` 广播项恒在末尾；名册状态缺失按 `idle`；排除仅作用于候选展示，仍可手打（FR-2.7）。
- 噪声：提交只含本需求文件；`screenshots/**` 删除状态与本需求无关（dev 提交前恢复）。
- 评审越界口径：仅 `web/**`；出现 `src/tui/**`、`screenshots/**`、`shared/protocol.ts`/SSE 改动即红。

---

## 8. 落地与验证（2026-10-16，已发布）

**提交（origin/main `18022f5..0f640ec`，5 笔 / 6 文件，+998/-6）**

| 提交 | 内容 |
|---|---|
| `244274e` | `web/src/mention.ts` 纯模块（Q/B 两套 token、候选/插入/名册/键盘判定） |
| `c5053d7` | `RoomView.tsx` 接线 + `App.tsx`(botStates) + `styles.css`(`.mention-menu`/`.roster-*`) |
| `e8f3509` | `test/web/mention.test.ts` + `test/rob/room-text-mention-boundary.test.ts` |
| `c0661ef` | AC-3 修复：`clampIndex` 接线（`RoomView:70`）+ onKeyUp 跳方向键 + `onBlur` + 候选改 `div role="option"` |
| `0f640ec` | test-only：`MENTION_RE_SOURCE` 结构性断言（钉住导出是 source 串而非有状态 `/g`） |

**评审**：review 正式复评（两轮）**通过**。阻塞项（AC-3 ↑/↓ 高亮被 `onKeyUp` 复位为 0 —— 纯函数测不到的组件集成 bug）已修并复评闭合；2 条 nit（无 `onBlur`、`<button role="option">` 角色冲突）已清。

**验收**：**AC-1..AC-13 全达成**，无未决 AC。
- 自动绿（11）：AC-1/2/3/5/7/8/9/10/11/12/13
- 纯函数半绿（2）：AC-4、AC-6
- 人工/集成（按 FR-5 标注，不计自动绿）：AC-6 后半「合成期不弹候选」、AC-4「running 且浮层关时 Esc 中断」

**验证真数**：聚焦 **82/82**（mention 32 + state 28 + room-text 17 + boundary 5）；全量 **159/159 文件 · 1405/1405 用例**（干净 HOME）。

**发布门禁（ci，远端口径，全部 exit 0）**：typecheck root+web 0 错；biome 391 files 0 error/0 info；test 159/1405 绿；build `dist/index.js` 632.36KB + web 567.37KB/css 47.73KB。红线零命中（无 `tui/**`、`screenshots/**`、`shared/protocol.ts`、`room-text.ts`）。远端 HEAD `0f640ec`，`origin/main...HEAD = 0/0`。

**已知后续（非阻塞）**
- review 备选加固：断言改「导出遍历」版（`Object.values(mention).some(v => v instanceof RegExp) === false`），本轮未追加，记后续。
- `styles.css` 3 条 `noDescendingSpecificity` 旧警告，归样式作者 cleanup（非本线）。
