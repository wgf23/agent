# DM 流：native 后端 vs CLI 后端 的真实行为差异

调研主题：核实 rob 间私聊（DM）在 native 后端与 CLI（pi / claude / opencode）后端下的实际行为。
结论先行：**发送方向（native → CLI）会送达，但只能单向、且只能作为一次普通 prompt；接收方向（CLI → 任意）完全不存在**。DM 能力是 native 后端专属功能，配置层已明确禁止 CLI 后端声明这些工具。

---

## 1) native 发 DM 给 CLI 后端 bot：会送达吗？

**会。** 送达路径与题目假设一致，完整链路如下（均为 `file:line`）：

| 步骤 | 位置 | 行为 |
|---|---|---|
| 1. `send_message` 工具 | `src/rob/tools.ts:32-82`（`postDm` 调用在 `:74`） | native bot 调工具，逐个收件人 `team.postDm(from, name, text)` |
| 2. `Team.postDm` | `src/rob/team.ts:396-402` | 写入全局 DM 日志 `this.dms.push` (`:399`)、emit `dm` 事件 (`:400`)、`this.robs.get(to)?.deliver({kind:"dm",from,text,at})` (`:401`) |
| 3. `Rob.deliver` | `src/rob/rob.ts:177-179` | `this.inbox.push(inbound)`（AsyncQueue，目标 rob 自己的 inbox） |
| 4. `Rob.run` | `src/rob/rob.ts:251-270` | `waitForBatch` (`:256`) 取批 → `runOnce(batch, signal)` (`:261`) → `this.backend.run({history, inbound: batch, ...})` (`:296`) |
| 5a. CLI `backend.run` | `src/rob/cli-backend.ts:103-153` | 转调 `runPi({..., history: turn.history, inbound: turn.inbound, ...})` (`:139-150`) |
| 5b. `runPi` 初始 prompt | `src/rob/cli-backend.ts:476-480` | `send({type:"prompt", message: options.inbound.map(promptFor).join("\n\n")})` |
| 5c. `runPi` 运行中 steer | `src/rob/cli-backend.ts:256-268` | 每 50ms drain 一次；`promptFor(item)` (`:259`) → `send({type:"steer", message})` (`:262`) |
| 6. `promptFor` / `headerFor` | `src/rob/backend.ts:125-127`、`:157-158` | `[from rob:${inbound.from}] ${inbound.text}` |

即：**CLI 后端确实把 DM 以 `[from rob:<name>] ...` 形式送进外部进程**——空闲时作为新一轮的 RPC `prompt`（`cli-backend.ts:479`），运行中作为 `steer`（`cli-backend.ts:259/262`）。这条路径对 pi、claude、opencode 三种 CLI 一致：

- pi：`cli-backend.ts:479` / `:259`；
- claude：`claude-backend.ts:116`（`const prompt = turn.inbound.map(promptFor).join("\n\n")`，作为 `-p` 参数）；
- opencode：`opencode-backend.ts:778`（作为 `POST /api/session/:id/prompt` 的 text），steer 在 `:807`。

一个关键细节：**`Rob.history` 对 CLI 后端不会回注进 prompt**。`runPi`(cli-backend.ts:174-181) 里 `messages = [...history, ...inbound...]` 只用于拼装 `TurnResult`（写回 `Rob.history`/store），真正发给 pi 的文本只有 `options.inbound`（`:479`）。CLI 的上下文连续性完全依赖外部进程自己的会话，而不是 my-agent 的历史。

---

## 2) 反向：CLI 后端 bot 能否回发 DM / 读取消息？下次唤醒还能“看见”上一条 DM 吗？

### 2a) 回发 DM：不能
`send_message` / `read_messages` / `list_robs` / `delegate` 这四个协作工具**只在 native 后端注册**：

- 创建处：`src/rob/backend.ts:86-99`（`createNativeBackend` 内 `extraTools`）；
- CLI 三个分支（`src/rob/rob.ts:124-154`）一个协作工具都不加；native 分支在 `:155-174`，且额外挂 `createMemoryTools`（`:165-172`，`remember`/`forget` 也是 native 专属）；
- 配置层直接禁止：`src/rob/types.ts:45-52` 定义 `CLI_UNSUPPORTED_TOOLS = ["send_message","delegate","remember","forget"]`，`:101-110` 在 CLI rob 的 `permissions` 里出现这些键即报错 `A "cli" backend cannot use ...`。

而且外部 CLI 的工具白名单里根本没有对应工具：
- pi 只暴露 read/write/edit/bash：`src/rob/cli-backend.ts:44-52`、`piToolAllowlist` `:70-82`；
- claude 只有内置 Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch：`src/rob/claude-backend.ts:29-38`；
- opencode 用其自有工具集。

**所以 CLI bot 没有任何途径调用 `send_message` 或 `read_messages`。** DM 流对 CLI 后端是**纯单向接收**。

### 2b) 下次唤醒是否还能“看见”上一条 DM？
分两层看：

- **外部 CLI 自己的会话里：能。** CLI 每轮都用持久会话续接：
  - pi：`--session-dir <dir>` + `--continue`（`cli-backend.ts:128-132`，目录 `.my-agent/pi-sessions/<rob>`，见 `defaultSessionDir` `:84-86`）；
  - claude：`--session-id` / `--resume <sessionID>`（`claude-backend.ts:108-109,137-139`，仅在上轮 ok 后记住 id `:157`）；
  - opencode：`ensureSession()` 复用同一 session（`opencode-backend.ts:776-778`）。
  上一条 DM 的文本已成为该会话上下文的一部分，模型在后续轮次一般仍“看得见”（受模型上下文窗口/会话压缩影响）。

- **my-agent 侧没有“重放”机制：不能按 DM 语义再看见。** DM 只作为那一轮的 prompt 注入一次；`read_messages` 的游标（`Rob.dmCursor`，`rob.ts:105,409-413`）与 `Team.readDms`（`team.ts:291-303`）对 CLI bot 不可访问。my-agent 也**从不**把 `Rob.history` 重新拼进 CLI 的 prompt（见 1 节）。因此：若外部会话丢失（首轮失败不 resume、session 目录被清、上下文被压缩掉），这条 DM **不会**被 my-agent 重新递送。

对比 native：native 的 `runAgent` 每轮都带 `history: turn.history`（`backend.ts:81`），且能主动 `read_messages` 增量重读（游标持久于进程内、跨轮），DM 语义完整双向。

---

## 3) 现有测试对 DM 流的覆盖，以及“只对 native 成立”的假设

### 覆盖 DM 的用例
| 层级 | 用例 | 覆盖内容 | 后端 |
|---|---|---|---|
| Team 日志/事件 | `test/rob/events.test.ts:69-120` | `postDm` 发 `dm` 事件、退订、克隆防篡改 | 后端无关 |
| Team 快照 | `test/rob/team.test.ts:46-57` | `readDms()` 快照不可变 | 后端无关 |
| native 工具 | `test/rob/tools.test.ts:24-131` | `send_message` 单发/群发/去重/自拒/每轮 20 条上限 | **native** |
| native 工具 | `test/rob/tools.test.ts:274-314` | `read_messages` 游标增量读 | **native** |
| native 端到端 | `test/rob/rob.test.ts:770-849` | “reads only new DMs across turns through the persisted cursor”，验证 `[from rob:worker] first/second` 与 `(no new messages)` | **native** |
| CLI 负向校验 | `test/config/backend.test.ts:73-86`、`:169-182` | CLI rob 声明 `send_message`/`delegate` 权限被拒绝 | 配置层 |
| CLI prompt/steer | `test/rob/cli-backend.test.ts:110-236`（prompt）、`:294-384`（steer） | 只有 `kind:"user"` 的 inbound；验证 `[from user] ...` 与 steer | **cli**（但无 DM） |
| TUI 渲染 | `test/tui/team/state.test.ts:146`、`test/tui/team/app.test.tsx:184` | `dm` 事件渲染 | 后端无关 |

### 只对 native 成立的假设
1. **`send_message` / `read_messages` / `list_robs` / `delegate` 可用**：仅 native（`backend.ts:86-99`）。测试中的这些用例全部构造无 `backend` 的默认 robs，隐含 native 前提。
2. **`read_messages` 的“自上次读取”游标语义**：`rob.test.ts:770-849`、`tools.test.ts:274-314` 都假设 bot 能主动读取并推进 `dmCursor`，CLI bot 无此工具，假设不成立。
3. **DM 可被后续轮次按语义重读**：native 靠 `read_messages`；CLI 只能靠外部会话的隐式上下文，无游标、无重放。
4. **测试盲区**：`test/rob/cli-backend.test.ts` / `claude-backend.test.ts` / `opencode-backend.test.ts` 中**没有任何 `kind:"dm"` 的 inbound 用例**（已 grep 确认），即“DM 以 `[from rob:x]` 形式进 CLI prompt/steer”这条路径**没有直接测试**。同样也没有覆盖“CLI bot 收不到工具/不能回发”的运行时用例（只有配置层负向校验）。`test/serve/team.test.ts`、`test/bot/*` 也均无 DM 用例。

### 已运行的测试命令与结果
```
$ npx vitest run test/rob/team.test.ts test/rob/events.test.ts \
    test/rob/tools.test.ts test/rob/rob.test.ts \
    test/rob/cli-backend.test.ts test/config/backend.test.ts

 ✓ test/config/backend.test.ts (11 tests)
 ✓ test/rob/events.test.ts (4 tests)
 ✓ test/rob/tools.test.ts (10 tests)
 ✓ test/rob/team.test.ts (10 tests)
 ✓ test/rob/rob.test.ts (13 tests)
 ✓ test/rob/cli-backend.test.ts (18 tests)

 Test Files  6 passed (6)
      Tests  66 passed (66)
   Duration  1.28s
```
全部通过；但如上所述，通过的用例并未覆盖「CLI 后端收到 DM」这一条真实路径。

---

## 结论摘要

- **送**：native → CLI 的 DM **确实送达**，路径 `send_message`→`Team.postDm`→`Rob.inbox`→`Rob.run`→`cli-backend.runPi`，以 `[from rob:<name>] ...` 作为 `prompt`（空闲，`cli-backend.ts:479`）或 `steer`（运行中，`:259/262`）注入外部进程。
- **回**：CLI bot **无法回发 DM，也无法读取消息**；四个协作工具是 native 专属，配置层显式禁止 CLI 使用（`types.ts:45-52,101-110`）。
- **续**：上一条 DM 仅在外部 CLI 自身的持久会话里可见（pi `--continue` / claude `--resume` / opencode session），my-agent 不回注 history、无重放；会话一旦丢失，该 DM 不会补送。
- **测**：现有 DM 用例要么后端无关（Team 日志/事件），要么仅对 native 成立（工具与游标语义）；CLI 后端收到 DM 的路径**无直接测试**，仅有配置层负向校验。
