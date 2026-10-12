# Rob 设计：独立 agent 团队

## 实现状态

- R1：核心（`Rob` actor、收件箱、`drainInput` 钩子、`send_message` 和 `delegate` 工具、`Team` 的无界面运行）。提交 `b0f21dc`。
- R2：TUI（rob 列表、`@name` 派发、只读的私聊和子 agent 视图、审批队列、插话）。提交 `5cc9821`。
- R3：加固（按解析后绝对路径的文件路径锁、私聊和深度上限验证、团队 token 统计、端到端测试）。提交 `6ba83a1`。
- R4：pi 的 CLI 后端（`RobBackend`、`--tools` 白名单、按 rob 的 pi 会话目录、`--mode json` 事件映射）。提交 `d69d4c6`。
- R4.1：关闭 G1 到 G4（角色提示、流式回答、模型错误结果、子 agent 用量）。提交 `c2ea6d8`。
- R4.2：关闭 G5 和 G7（`--mode rpc` 的中途插话、`tool_call` 扩展审批桥）。提交信息为 `feat: pi interjection, approvals, or peer tools, as verified`。
- R4.3：修复 pi CLI 后端的空闲 steer 丢失（`turnActive` 回合状态、`queue_update.steering` 补投递、`success:false` 重发、未投递计数失败）。提交信息为 `fix: pi steer delivery, no silent message loss`。

claude、codex、kimi 的 CLI 后端仍未实现。R4 只支持 pi。

### 与设计的偏差

- **allow_always 去重**：`ApprovalQueue` 在一条请求被回答为 `allow_always` 后，把队列中同工具、同规则、非危险的其他请求直接按 `allow_once` 解决，避免重复写规则。设计没有规定去重。
- **写串行化的位置**：`allow_always` 对 `my-agent.json` 的读-改-写由 `addPermissionRule` 里的模块级 `writeChain` 串行化，authorizer 等待它；没有走本阶段新增的按路径文件锁。设计只要求「串行化写入」，没有指定位置。
- **团队停止的拒绝理由**：`stop()` 用固定理由 `TEAM_STOPPED_REASON`（"The team stopped before this approval was answered."）拒绝所有待审批请求；停止开始后再来的审批也直接拒绝，避免入队后永远等待而卡住 `stop()`。设计没有规定该行为。
- **R1 的审批缺口（R2 修复）**：R1 给每个 rob 直接传各自的 `headlessApproval`，绕过了 `Team`；R2 新增共享的 FIFO `ApprovalQueue`，审批经 `rob.approval` -> `Team.requestApproval` 入队，队列项带发起 rob 的名字并驱动 `waiting_approval` 状态。
- **R4.2 的子进程协议**：cli rob 改用 `--mode rpc`。命令（prompt、steer、extension_ui_response）写成 JSONL 到 stdin，事件从 stdout 读回；回合在 `agent_end` 结束，之后关闭 stdin 让 pi 自行退出并保存会话。R4 第一版用 `-p --mode json` + `stdin: ignore`，因为 pi 要等 stdin EOF 才继续；RPC 模式要的就是打开的 stdin。
- **R4 的会话续接**：只传 `--session-dir` 时 pi 每次都会新建会话；必须再传 `--continue` 才能在同一目录里续接上一轮，所以 cli rob 每轮都带 `--continue`。rpc 模式下同样成立。
- **R4 的事件映射**：现有 `tool_started` 没有 summary 字段，工具摘要只放在 `tool_finished`；cli 的回答用 `message_update.assistantMessageEvent.delta` 逐段发 `text_delta`，`message_end` 里若还有未发出的剩余文本才补发一次。
- **R4.2 的插话**：cli 后端每 50ms 调一次 rob 收件箱的 drain，把新消息作为 `steer` 发给正在运行的 pi。R4.3 修正了投递语义：轮询器只在 `turnActive` 为真时 drain，空闲时不碰收件箱（交给 rob 的下一轮）；`agent_end` 时若 `queue_update.steering` 仍非空，说明这些 steer 没投递，cli 后端把它们按顺序拼成一条 `prompt` 在同一进程重发；`success:false` 的 steer 也重发；已取走却既未投递也未入队的消息让回合以 `ok:false` 结束并报出丢失条数。
- **R4.2 的审批桥**：cli 后端把自己的 authorizer 传给 pi 扩展。扩展在 `tool_call` 钩子里对每次工具调用发起 `ctx.ui.confirm`，我们的进程用 authorizer 判断后回复；因此解析为 `ask` 的工具也能进入 `--tools` 白名单。`ask`/`allow` 的暴露只在桥存在（即 rob 传了 authorizer）时发生。
- **R4 的权限（R4 第一版）**：R4 第一版 pi 没有审批通道，解析为 `ask` 的工具不会进入 `--tools` 白名单，只有 `allow` 才暴露。R4.2 由审批桥关闭。

### R4 的已知缺口

编号 G1 到 G7 是本文件及提交记录使用的固定编号。恢复详情见 `docs/design/pi-capabilities.md`。

- G1（已关闭）：pi 的系统提示缺少 rob 的角色。角色现在作为单个 argv 传给 `--append-system-prompt`，不经过 shell。真实 pi 验证：以「以 REVIEW: 开头」为角色提问，回答以 `REVIEW:` 开头。
- G2（已关闭）：pi 现在按 `message_update` 的 `text_delta` 流式产出，组装后的文本等于 `message_end` 的文本。
- G3（已关闭）：`message_end` 的 `stopReason` 为 `"error"` 或 `"aborted"` 时返回错误结果并带上该消息的 `errorMessage`，不再退化成空回答。
- G4（已关闭）：子 agent 的 `usage` 事件现在累加到发起 rob 的用量统计。
- G5（已关闭）：cli rob 现在能在回合中途插话，且不在空闲 pi 上丢消息。cli 后端使用 `--mode rpc`，用 `turnActive` 跟踪回合：进行中才把收件箱的新消息作为 `steer` 发出，空闲时留给 rob 的下一轮。真实 pi 验证：工具执行期间发送 steer，回答变成 `STEERED`；`agent_end` 之后空闲时投递的消息由 rob 的下一轮回答。真实验证并修复了空闲 steer 的丢失：`agent_end` 后发送的 steer 返回 `success:true` 但只进 `queue_update.steering`、不会再开回合；后端现在把 `agent_end` 时仍在 steering 的消息（以及 `success:false` 的 steer）作为新 prompt 在同一进程补投递，未投递且未入队的消息让回合以 `ok:false` 结束并报出条数。
- G6（已接受为限制，不实现）：cli rob 不能使用 `send_message` 和 `delegate`。配置校验会拒绝在 cli rob 上设置这两个工具。扩展工具可以通过 Unix socket 回调我们的进程（机制已用真实 pi 验证），但需要常驻监听通道和自定协议。决定：原生 rob 已完整支持私聊、子 agent 和审批，pi 的 rob 定位为独立执行任务的角色。只有在 pi 的 rob 确实需要互相协作时，才重新考虑这个桥接。
- 残留风险（未关闭）：G7 的审批扩展如果加载成功、但没有注册 `tool_call` 钩子，`ask` 工具会在没有审批的情况下执行。加载失败时 pi 会以退出码 1 结束，这种情况是安全的（已用真实 pi 验证）。目前没有握手机制确认钩子已注册。
- 证据强度：G4 只用假 pi 和单元测试验证，没有用真实 pi 验证。空闲 steer 的重发路径只用假 pi 验证，因为真实时序难以稳定复现。
- G7（已关闭）：cli rob 现在有审批通道。pi 扩展在 `tool_call` 钩子里发 `ctx.ui.confirm` 并阻塞，我们的进程用该 rob 的 authorizer 判断后回复；允许和拒绝两条路径都已用真实 pi 验证。因此 `ask` 工具可以进入白名单（仅在桥存在时）。

## 问题

用户希望同时派发不同类型的任务给不同的 rob。每个 rob 是独立的 agent，有自己的会话、子 agent、权限，可以写文件。rob 之间可以一对一私聊共享信息。用户可以在 rob 工作时插话，和 OpenCode 的使用方式一致。用户只能读取子 agent 的过程和 rob 之间的私聊，不能发言。

这一点让设计不同于普通的「多 agent 群聊」：没有共享的公共频道，每个 rob 拥有自己的状态，唯一的跨 rob 通道是私聊。

约束来自现有代码：
- `runAgent` 是单次运行，它的 `history` 和 `onEvent` 都是调用者持有的。rob 需要长期持有自己的历史，所以每个 rob 必须在 `runAgent` 外面持有状态。
- 用户插话必须在 agent 循环的**两步之间**生效。现有循环没有这个注入点，需要新增。
- `ApprovalBridge` 只能等待一个审批请求。多个 rob 并行时，它要改成排队。
- 工具注册表是无状态的单例，可以被多个 rob 共用。
- 文件系统是共享的，两个 rob 可能写同一个文件。

## 用法（调用者视角）

配置写在 `my-agent.json` 里：

```json
{
  "robs": [
    { "name": "planner", "role": "拆解任务，协调其他 rob" },
    { "name": "coder", "role": "修改代码", "permissions": [{ "pattern": "npm test*", "action": "allow" }] },
    { "name": "docs", "role": "写文档" }
  ]
}
```

在 TUI 里：

```text
@coder 给 src/cli 加 --json 输出     派发任务给 coder
@planner 进展怎么样                  插话给 planner（它工作时也能收到）
/dm                                  只读：查看 rob 之间的私聊
/sub coder                           只读：查看 coder 的子 agent 过程
```

rob 之间的工具：

```text
send_message(to, text)               给另一个 rob 私聊
delegate(task, tools)                派出一个子 agent，返回它的最终结果
```

## 结构

```text
Team
  robs: Map<name, Rob>
  dms: DmLog                          只读日志，所有私聊的唯一记录
  approvals: ApprovalQueue            FIFO，显示发起 rob 的名字

Rob（每个一个 actor）
  name, role, permissions, model
  history: Message[]                  rob 自己的会话，只有它写
  inbox: AsyncQueue<Inbound>          用户消息、私聊、子 agent 结果
  status: idle | working | waiting_approval
  run(): 循环取 inbox，调用 runAgent，drainInput 钩子注入新消息

Inbound = { kind: user | dm | subagent_result, from, text }
```

关键设计：
- **每个 rob 只有一份历史**，由它自己的循环写入。其他 rob 只能通过私聊发消息，不能直接改它的历史。
- **`drainInput` 钩子**：`runAgent` 每一步开始前调用一次，把收件箱里的新消息追加进 `messages`。用户插话和私聊都走这条路径。
- **子 agent** 是 `delegate` 工具的实现：新建一个 `runAgent`，独立历史，继承该 rob 的权限，只返回最终文本。子 agent 的事件发给 `DmLog` 之外的「子 agent 日志」，用户只读。
- **用户只能写入 rob 的收件箱**，不能写入私聊和子 agent 日志。这个约束在类型上强制：只读视图不暴露写方法。

## 语义决定

| 问题 | 决定 | 理由 |
|---|---|---|
| 私聊能否被用户看到 | 只读 | 用户要求 |
| 子 agent 能否派生子 agent | 最多两层，超出拒绝 | 防止无限嵌套 |
| 私聊循环（A 回 B，B 回 A） | 每个 rob 每次运行最多 N 条私聊，默认 20，超出拒绝 | 防止失控 |
| 文件冲突 | 工具层按解析后的绝对路径加锁 | 防止撕裂写入；逻辑冲突由用户协调 |
| 审批 | 所有 rob 共享一个 FIFO 审批队列，对话框显示 rob 名字 | 用户是唯一的审批人 |
| `allow_always` 写入 | 串行化写入 `my-agent.json` | 避免竞争 |
| 持久化 | 本版本只在内存中，退出即丢失 | 会话持久化在 backlog 里 |
| 费用 | 每个 rob 和整个团队分别统计 token | 让用户看见成本 |

## 候选对比

| | 候选 1：actor + 收件箱 | 候选 2：中央调度器 |
|---|---|---|
| 工作时收到私聊 | 是，在下一步 | 否，要等本轮结束 |
| 工作时插话 | 是，在下一步 | 否 |
| 改动 agent 循环 | 新增 `drainInput` | 不改 |
| 状态归属 | 每个 rob 自己 | 调度器持有，成为新的共享状态 |
| 结论 | **采用** | 拒绝：违反用户插话需求，并把状态集中到调度器 |

## 红旗检查

- **Split ownership**：每个 rob 的历史只有它自己写。私聊日志只有 `DmLog` 写。避免了多方维护同一份状态。
- **Shallow module**：`Team` 的公开接口是 `dispatch`、`interject`、`readDms`、`readSubagents`。内部的循环、锁、审批排队都藏在里面。
- **Importable internals**：`Rob` 的 `history` 不导出，只能通过 `Team` 的只读视图访问。
- **Two ways to do one task**：用户派发任务只有一条路径（`@name`），用户插话也只有一条路径（同样的 `@name`）。

## 权衡接受的代价

- 我们接受每个 rob 的会话只在内存中，换来实现简单。
- 我们接受同一文件的逻辑冲突需要用户判断，换来不做复杂的合并。
- 我们接受私聊可能增加 token 成本，换来 rob 之间的信息共享。

## 替代方案

- **共享频道（之前的草案）**：被否决。用户明确要求私聊，不是公共频道。
- **进程级隔离（每个 rob 一个子进程）**：隔离性更强，但 IPC、TUI 同步、审批回传都很复杂。当前规模不值得。

## 开放问题与风险

- **风险：私聊风暴**。两个 rob 可能不停互相回复。已用每个 rob 的私聊上限缓解，但阈值需要实际使用后调整。
- **风险：TUI 复杂度**。多个 rob 的状态、私聊日志、子 agent 日志、审批队列都要在一个界面里展示。计划分成 R2 阶段单独做。
- **问题：rob 之间能否共享文件之外的状态？** 当前设计不允许，只能通过私聊。如果你需要共享黑板之类的东西，要单独设计。

## 后端类型（待确认）

用户提出：每个 rob 可以选择不同的 agent 类型，例如 claude、kimi、pi、codex。这里有两种完全不同的含义，需要先确认。

**含义 A：模型。** 只换模型，仍由我们的循环驱动。例如 kimi 模型通过 OpenAI 兼容端点调用。这种情况下 `native` 后端已经能支持，只需要在 `preset` 或 `baseURL` 上配置，不需要新代码。

**含义 B：外部 CLI 工具。** 每个 rob 实际运行 `claude`、`codex`、`kimi`、`pi` 这类 agent 程序。它们自带工具和权限系统，我们无法直接截获它们的工具调用。

两种含义对设计影响很大。下面按含义 B 写。

### 后端接口

```text
RobBackend
  kind: "native" | "cli"
  run(turn): Promise<TurnResult>
    turn = { history, inbound, signal, onEvent }
    native：调用 runAgent，拥有全部工具、审批、私聊、子 agent
    cli：启动外部进程，把 inbound 作为 prompt 传入，收集最终文本
```

配置形式（草案）：

```json
{
  "robs": [
    { "name": "planner", "role": "拆解任务", "backend": { "kind": "native", "preset": "deepseek", "model": "deepseek-flash" } },
    { "name": "reviewer", "role": "审查改动", "backend": { "kind": "cli", "command": "codex", "args": ["exec"] } }
  ]
}
```

### 外部 CLI 的限制（必须接受或解决）

| 能力 | native | cli |
|---|---|---|
| 审批（y/a/n） | 是，经过我们的 authorizer | 否。外部程序自己决定，只能依赖它自己的权限配置 |
| `send_message` 私聊工具 | 是 | 否，除非外部程序支持 MCP 并连接到我们提供的服务 |
| `delegate` 子 agent | 是 | 否，外部程序有自己的子任务机制，我们只能看到最终文本 |
| 用户插话 | 是，在下一步生效 | 只能在下一次启动时生效，无法中途注入 |
| 事件流（工具过程） | 完整 | 取决于外部程序的输出格式，可能只有文本 |
| 历史 | 我们持有 | 外部程序各自持有，我们只能每次把历史拼进 prompt |

结论：cli 后端会破坏「权限独立、可以审批、子 agent 只读可见」这几条要求。如果要保留，就必须做 MCP 桥接，或者接受这些 rob 没有审批。R4.2 用 pi 的 rpc 模式和扩展关闭了 pi 的审批和中途插话缺口；其他 CLI 仍未解决。

### 已验证：pi（@mariozechner/pi-coding-agent 0.73.0）

安装方式：`npm install -g @mariozechner/pi-coding-agent`，命令为 `pi`。本机已安装。

| 验证项 | 命令与结果 |
|---|---|
| 支持 DeepSeek | `pi --list-models deepseek` 列出 `deepseek-v4-flash`、`deepseek-v4-pro`，读取环境变量 `DEEPSEEK_API_KEY` |
| 非交互文本 | `pi -p --provider deepseek --model deepseek-v4-flash --no-session "Reply with exactly: PI_OK"` 输出 `PI_OK`，退出码 0 |
| 工具调用 + 结构化输出 | `--mode json` 输出 JSON 行事件，含 `tool_execution_start`（`toolName: "read"`，参数 `path`）、`tool_execution_end`、`agent_end`。最终回答 `0.1.0` 正确 |
| 用量与费用 | 每条 `message_end` 带 `usage`（input、output、cacheRead）和 `cost` |
| **无审批直接写文件** | 允许全部工具时，`pi -p` 直接创建了 `write-check.txt`，没有任何确认。**这说明 CLI 后端默认绕过我们的权限** |
| **`--tools` 白名单可以约束** | `--tools read` 时，模型明确回答自己无法写文件，`allow-check.txt` 没有被创建 |

由此得到的设计结论：

1. 外部 CLI 的 rob 必须用 `--tools` 把工具集限制在该 rob 的权限范围内。例如只读 rob 只给 `read`。
2. R4 第一版认为「需要审批的写入」在 pi 下无法逐次审批，只能是「允许」或「不给这个工具」。R4.2 推翻了这一点：pi 扩展的 `tool_call` 钩子可以发 `ctx.ui.confirm` 并阻塞，配合 `--mode rpc` 做到逐次审批。
3. pi 的 `--mode rpc` 是 R4.2 的事件来源，`--mode json` 的事件形状相同但无法中途送命令。
4. 私聊 `send_message` 和 `delegate` 在 pi 里没有对应物。R4.2 验证了扩展工具可以用 Unix socket 回调我们的进程，机制可行但未实现；见 `docs/design/pi-capabilities.md`。

### 建议

1. 先确认是含义 A 还是 B。如果是 A，不需要改设计，只需要配置 `native` 的 `preset`。
2. 如果是 B，把它放在 R3 之后作为 **R4**，并且先做一个验证阶段：在有这些 CLI 的机器上确认它们的非交互模式（参数、输出格式、能否提供工具调用信息）。这台机器上没有安装，所以 R4 的第一步必须是安装并验证，不能凭文档假设。
3. R4 的第一版只做「派发任务、返回最终文本」，不提供私聊和审批，并明确标注这些 rob 的权限边界。

## 下一步实现

1. R1：核心（`Rob` actor、收件箱、`drainInput` 钩子、`send_message` 和 `delegate` 工具、`Team` 的无界面运行）。用 MockProvider 测试。
2. R2：TUI（rob 列表、`@name` 派发、只读的私聊和子 agent 视图、审批队列、插话）。
3. R3：加固（文件路径锁、私聊和深度上限、团队费用统计、端到端测试）。
