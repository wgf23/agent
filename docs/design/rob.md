# Rob 设计：独立 agent 团队

## 实现状态

- R1：核心（`Rob` actor、收件箱、`drainInput` 钩子、`send_message` 和 `delegate` 工具、`Team` 的无界面运行）。提交 `b0f21dc`。
- R2：TUI（rob 列表、`@name` 派发、只读的私聊和子 agent 视图、审批队列、插话）。提交 `5cc9821`。
- R3：加固（按解析后绝对路径的文件路径锁、私聊和深度上限验证、团队 token 统计、端到端测试）。提交 `6ba83a1`。
- R4：pi 的 CLI 后端（`RobBackend`、`--tools` 白名单、按 rob 的 pi 会话目录、`--mode json` 事件映射）。提交 `d69d4c6`。
- R4.1：关闭 G1 到 G4（角色提示、流式回答、模型错误结果、子 agent 用量）。提交 `c2ea6d8`。
- R4.2：关闭 G5 和 G7（`--mode rpc` 的中途插话、`tool_call` 扩展审批桥）。提交信息为 `feat: pi interjection, approvals, or peer tools, as verified`。
- R4.3：修复 pi CLI 后端的空闲 steer 丢失（`turnActive` 回合状态、`queue_update.steering` 补投递、`success:false` 重发、未投递计数失败）。提交信息为 `fix: pi steer delivery, no silent message loss`。
- R5：opencode CLI 后端（`opencode serve` 私有常驻进程、每 rob 一个持久会话、回合中途 steer、`dispose` 关闭进程与 SSE、serve 模式权限强制）。实现见 `src/rob/opencode-backend.ts`。
- R5.1：opencode rob 审批桥（`ask` 工具翻译成 opencode `ask` 规则并暴露；`permission.asked` 经该 rob 的 authorizer 和共享 FIFO 审批队列回答；规则翻译修正为「只有不可能解析成其他效果时才普通 allow」；abort/dispose 拒绝所有待决请求）。
- R6：team gateway（`Team.beginTurn` 每回合在本地 Unix socket 上开一条带 secret 的通道；`tools.ts` 用同一组 `Tool` 对象实现 `send_message` 和 `delegate`；`roster.ts` 组装名册提示；pi 扩展注册这两个工具，调用经 socket 回到 gateway，由该 rob 的 authorizer 授权一次）。实现见 `src/rob/gateway/`。
- R6.1：opencode 的 MCP shim（`teamMcpShim` 生成一个 stdio MCP 服务，`--mcp-config` 的等价物是 `OPENCODE_CONFIG_CONTENT` 里的 `mcp` 配置；opencode 对 MCP 调用发 `permission.asked`，bridge 放行后由 gateway 授权一次）。提交 `ea4b4b2`、`9a5f9b3`、`824503c`。真实 opencode 2.0.24 + DeepSeek 探针验证：opencode 调用 `myagent-team_send_message`，权限动作名正是 `myagent-team_<tool>`，gateway 收到并写入 DM 日志。
- R7：claude CLI 后端（每回合一个 `claude -p --output-format stream-json --verbose` 进程；每 rob 一个 `CLAUDE_CONFIG_DIR`；首回合 `--session-id`、成功回合后 `--resume`；规则解析为 `allow` 的内建工具进 `--tools` 精确白名单和 `--allowedTools`，`ask`/`deny` 不进白名单；每回合写 MCP shim 与 `team-mcp.json` 并合并 `turn.bridge.childEnv()`，团队工具以 `mcp__myagent-team__<tool>` 进 `--allowedTools`；claude rob 走配置 provider 的 Anthropic 兼容端点：`childProviderEnv` 在子进程 env 里加 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`，preset 没有该端点时不加）。实现见 `src/rob/claude-backend.ts`。提交 `f388b7d`（移植）、`a96c6b8`（bridge）、`108d91a`（配置接入 `CLAUDE_CLI_COMMAND`）、`4dbdfad`（测试）、`eb6d402`（精确工具面）、`7abe4d1`（preset 端点）、`370c8ee`（`childProviderEnv`）、`04266a4`（接入四个构造点）、`6a72e10`（测试）。

- R8：群聊房间（`Room` 是共享记录的唯一写者，成员按配置顺序逐个发言，`room_reply` 工具经同一 bridge 服务，一轮无人发言即结束；TUI 把房间当作选择项，web 把房间当作会话 id；`rooms` 从 `my-agent.json` 读取）。实现见 `src/rob/room.ts`、`src/rob/room-text.ts`、`src/rob/team.ts`。设计取 architect 两个候选中的基座（房间拥有记录并做调度），并嫁接扁平 `Inbound`、`TeamPort` 不变、`PASS` 哨兵、按轮 `@name` 限定。
- R8.1：房间持久化与发送队列（每个房间一份 `RoomState` 账本：`name`、`createdAt`、`members`、`coordinator`、`transcript`、`queue`、`runOpen`、`deliverable`；文件在数据根 `~/.local/share/my-agent/rooms/<workspace-slug>/<room>.json`，`MY_AGENT_ROOMS_DIR` 覆盖根目录，workspace slug 复用 session store 的 `projectSlug`。`Team` 构造时同步读取全部账本：有账本以账本为唯一真源，无账本从 `my-agent.json` 播种并写首份账本；加载到未闭合的运行补一条 system 说明；配置成员/协调者与账本不一致时同一条 system 提示，不改账本。账本是 `RoomState` 的整份写入，经共享的 `writeTextAtomic` 原子落盘，按房间串行合并、至多一个写请求在飞，`Room.stop` 冲刷。发送队列：运行中发送不再拒绝，条目立即进记录并入队（`QueuedSend.entryId`，上限 `ROOM_MAX_QUEUED_SENDS=5`），运行结束后的唯一 `resume()` 路径逐个起跑，中断只结束当前发送、不动队列。`@all` 与具名 `@` 并集、按成员顺序解析成具体成员表，不新增运行状态；名册里真有成员叫 `all` 时按精确名匹配。实现见 `src/rob/room-store.ts`（新）、`src/rob/room.ts`、`src/rob/team.ts`、`src/config/project-file.ts`。
- R8.2：协调者交付与弹性压缩（`RoomConfig.coordinator` 可选且必须是成员，`validateRoomCoordinator` 在配置加载与 `Team.createRoom` 检查；运行以 `settled`/`max_rounds`/`message_cap` 结束、队列为空、协调者仍在名册且未过运行期限时，走同一条 `takeTurn` 路径和同一个 `room_reply` bridge 再走一轮，回复作为普通成员条目写入；`RoomHost.writeDeliverable` 是交付文件的唯一写者，`src/rob/deliverable.ts` 渲染并原子写入 `<workspace>/docs/deliverables/<UTC 时间戳>-<slug>.md`（slug 来自去除 mention 的任务正文），system 条目记录路径，`RoomState.deliverable` 记录 `{at, path, coordinator}`；中断、停止、超时、运行出错或仍有排队发送时不产出；`setMembers` 丢掉协调者时清空并在 ok 结果上报。弹性压缩：记录超过 `ROOM_MAX_STORED_ENTRIES=200` 时，最旧的条目折成一条确定性 system summary（计数、发言人、三条截断首行），保留最近 `ROOM_COMPACT_KEEP_ENTRIES=100` 条；summary 用新 id，被折叠范围内的成员游标钳到折叠边界，提示词始终带 summary 和最近窗口。交付与压缩都不新增 `RunOutcome`/`TurnState`；`RoomInfo` 增加 `coordinator` 与 `deliverable` 投影，web 头部展示协调者和最近交付路径，创建对话框可选协调者。实现见 `src/rob/deliverable.ts`（新）、`src/rob/room.ts`、`src/rob/room-text.ts`、`src/serve/team.ts`、`web/src/components/RoomView.tsx`。）

codex、kimi 的 CLI 后端仍未实现。cli 后端支持 pi、opencode 和 claude；三者都已接入 team gateway。

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
- **R5.1 的 allow_always 信号**：authorizer 之前只返回 `{allowed:true}`，无法区分 `allow_once` 和落了持久规则的 `allow_always`。为让 opencode 桥精确回 `once` 或 `always`，`AuthorizeResult` 的允许分支新增可选 `remember`，仅在 authorizer 真正写入规则的那条分支置真。没有新增第二条持久化路径；opencode 的 `always` 只是镜像该信号。
- **R5.1 的 edit 工具选择**：opencode 的 `permission.asked` 只带 `action:"edit"`，不带 write 还是 edit 工具名。桥在该请求的 resource 上取规则解析为 `ask` 的工具，优先 `write_file`。这是协议信息不足下唯一可行的映射；离线测试锁定该选择。

### R4 的已知缺口

编号 G1 到 G7 是本文件及提交记录使用的固定编号。恢复详情见 `docs/design/pi-capabilities.md`。

- G1（已关闭）：pi 的系统提示缺少 rob 的角色。角色现在作为单个 argv 传给 `--append-system-prompt`，不经过 shell。真实 pi 验证：以「以 REVIEW: 开头」为角色提问，回答以 `REVIEW:` 开头。
- G2（已关闭）：pi 现在按 `message_update` 的 `text_delta` 流式产出，组装后的文本等于 `message_end` 的文本。
- G3（已关闭）：`message_end` 的 `stopReason` 为 `"error"` 或 `"aborted"` 时返回错误结果并带上该消息的 `errorMessage`，不再退化成空回答。
- G4（已关闭）：子 agent 的 `usage` 事件现在累加到发起 rob 的用量统计。
- G5（已关闭）：cli rob 现在能在回合中途插话，且不在空闲 pi 上丢消息。cli 后端使用 `--mode rpc`，用 `turnActive` 跟踪回合：进行中才把收件箱的新消息作为 `steer` 发出，空闲时留给 rob 的下一轮。真实 pi 验证：工具执行期间发送 steer，回答变成 `STEERED`；`agent_end` 之后空闲时投递的消息由 rob 的下一轮回答。真实验证并修复了空闲 steer 的丢失：`agent_end` 后发送的 steer 返回 `success:true` 但只进 `queue_update.steering`、不会再开回合；后端现在把 `agent_end` 时仍在 steering 的消息（以及 `success:false` 的 steer）作为新 prompt 在同一进程补投递，未投递且未入队的消息让回合以 `ok:false` 结束并报出条数。
- G6（pi 已关闭，opencode 与 claude 已实现）：cli rob 现在可以通过每回合的 team gateway 使用 `send_message` 和 `delegate`。回合开始 `Team.beginTurn` 在 `mkdtemp` 目录（0700）里监听一个带 per-rob secret 的 Unix socket；pi 扩展注册这两个工具，调用经 socket 回到 my-agent，由该 rob 的 authorizer 与共享审批队列授权一次，`tool_call` 钩子对这两个名字直接放行。原生 rob 与 gateway 挂载同一组 `Tool` 对象。真实 pi 探针验证：pi 调用 `send_message` 后，目标 rob 的收件箱提示为 `[from rob:planner] probe ping`。opencode 见 R6.1，claude 见 R7。
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
4. 私聊 `send_message` 和 `delegate` 在 pi 里没有对应物。R4.2 验证了扩展工具可以用 Unix socket 回调我们的进程，机制可行但当时未实现；R6 已实现，见 `src/rob/gateway/`。

### 已验证：opencode（2.0.24）

后端为每个 rob 起一个私有的 `opencode serve --port 0 --hostname 127.0.0.1` 进程，env 传 `OPENCODE_PASSWORD`（随机）与 `OPENCODE_CONFIG_CONTENT`（注入一个 primary agent，id 为 `myagent-<robname>`，`system` 为 rob 角色，`permissions` 为翻译后的规则集）。子进程用 `XDG_DATA_HOME`/`XDG_STATE_HOME` 指向 `~/.config/my-agent/opencode/<rob>/`，数据与状态和用户自己的 opencode 隔离，rob 会话不会出现在用户的会话列表里，也不与用户的 serve 争用同一个 SQLite 库；`XDG_CACHE_HOME` 保持继承。解析出的 provider key 以 `apiKeyEnv` 指定的环境变量名转发给子进程，且不能覆盖 `OPENCODE_PASSWORD` 或 `OPENCODE_CONFIG_CONTENT`，因此用 `my-agent setup` 存下的 key 无需导出即可认证。进程在 stdout 打印 `server listening on http://127.0.0.1:<port>` 后，轮询 `GET /api/info` 到 200 视为就绪。所有请求用 HTTP basic（用户名 `opencode`）。首个 run 才启动，之后复用同一进程与同一会话；会话 404 时重建。`dispose` 发 SIGTERM 并关闭 SSE。

回合中途插话用 `POST /api/session/{id}/prompt`，body `{ "text": "...", "delivery": "steer" }`。真实验证：`sleep 8` 任务进行中收到 steer，最终回答变成 steer 文本（`OC_STEERED`）。abort 时 `POST /api/session/{id}/interrupt`。

`GET /api/event`（SSE，按 `data.sessionID` 过滤）的事件映射：

| opencode 事件 | AgentEvent |
|---|---|
| `session.text.delta` / `session.text.ended` | `text_delta`（`text.ended` 只补发流式未覆盖的剩余） |
| `session.reasoning.delta` | `reasoning_delta` |
| `session.tool.called` | `tool_started`（工具名由 `session.tool.input.started` 记下） |
| `session.tool.success` | `tool_finished`（ok，输出截断 4000） |
| `session.tool.failed` | `tool_finished`（error，取 `error.message`） |
| `session.step.ended` | `usage`（该步 tokens：input/output/reasoning/cache.read/cache.write） |
| `session.execution.succeeded` | `done`（finished） |
| `session.execution.failed` | `error` + `done`（error，取 `data.error.message`） |
| `session.execution.interrupted` | `done`（aborted） |

完成判定用显式的 `session.execution.succeeded` / `failed` / `interrupted`，不轮询回退。用量按每步 `session.step.ended` 累加；`session.usage.updated` 是会话累计值，跨回合重复计数，故不采用。

serve 模式权限强制（本轮补验，关闭唯一未验证的安全声明）：agent 的 `permissions` 规则集在 serve 模式生效。规则集以 `[{action:"*",resource:"*",effect:"deny"}]` 起底再追加 allow。实测：允许 `edit` 时 write 工具创建了文件；拒绝 `edit` 时模型回答写工具不可用，文件未创建；`effect:"ask"` 时发出 `permission.asked` 并阻塞回合（无文件）。会话级 `permissions` 规则集同样生效（allow-all agent + 会话级 deny edit 时不写入）。agent 级已足够，实现只在 `OPENCODE_CONFIG_CONTENT` 注入规则集。opencode 工具名到我们的名字：`read→read_file`、`write→write_file`、`edit→edit_file`、`shell→bash`，`glob`/`grep` 同名。

### R5.1 审批桥（已验证：opencode 2.0.24 + 真实 DeepSeek）

规则翻译（`opencodePermissions`，纯函数）。一个工具只有满足下面两种形状之一，才翻译成 opencode 的普通 `allow`：标量 `"allow"`，或整张列表的每一项都是 `{pattern:"*", action:"allow"}`。任何带具体 pattern、或 `deny`、或 `ask` 项的列表都降级为 `ask`；解析为 `deny` 的工具整个动作不暴露。原因是 opencode 的规则是 last-match-wins 的 `{action, resource, effect}`，而我们的规则按 pattern 匹配 subject：`[{pattern:"rm *",action:"deny"},{pattern:"*",action:"allow"}]` 对 subject `"*"` 解析为 `allow`，若照旧翻译成 `effect:"allow"` 就会让 `rm -rf x` 绕过 `rm *` 的 deny。测试用该列表断言 `shell` 得到 `ask` 而非 `allow`。`write_file` 与 `edit_file` 共享 opencode 的 `edit` 动作，按最严格合并：两者都 allow 才是 allow；任一 ask（含带 pattern 的门控）就是 ask；其余（含一 allow 一 deny）整个动作不暴露。基础 `{action:"*",resource:"*",effect:"deny"}` 保持在首位，allow/ask 追加在后。

请求与应答。回合中 opencode 发 `permission.asked` SSE，`data` 字段为 `{id, sessionID, action, resources:[...], save:[...], source:{type:"tool", messageID, id}}`；实测 `action` 取值 `shell`（`resources` 为命令字符串）、`read`（路径）、`glob`/`grep`（pattern）、`edit`（路径）。后端把 `action` 映射回本侧工具（`read→read_file`、`glob`、`grep`、`shell→bash`；`edit` 取规则在 `resources[0]` 上解析为 `ask` 的那个，优先 `write_file`），用 `resources[0]` 构造合成调用（bash 用 `{command}`，read/write/edit 用 `{path}`，glob/grep 用 `{pattern}`），调用该 rob 的 authorizer。authorizer 走共享 FIFO 队列，用户看到带 rob 名字的对话框，`waiting_approval` 状态由既有路径设置。答复用 `POST /api/session/{sessionID}/permission/{requestID}/reply`，body `{decision:"once"|"always"|"reject", message?}`：允许一次回 `once`；authorizer 落了持久规则（`AuthorizeResult.remember === true`）回 `always`；拒绝回 `reject`，`message` 为 authorizer 的理由。危险命令 authorizer 不落规则，因此永远回 `once`。`action` 无法映射回任何工具时回 `reject` 并附清晰理由，绝不静默放行。

生命周期。待决请求记录在 `pendingPermissions`。回合中途 abort 会先对所有待决请求回 `reject`（理由 "Turn aborted before the approval was answered."）再 `interrupt`；`dispose` 同样回 `reject`（理由 "my-agent stopped before the approval was answered."）并结束回合，避免 `Team.stop` 卡住、opencode 阻塞在已停的 server 上。真实验证：TUI 里对 `bash echo APPROVED_ONE` 按 `y` 后工具执行并出现 `APPROVED_ONE` 的 `✓` 卡片与输出；对 `bash echo DENIED_TWO` 按 `n` 后出现红色 `✗` 卡片和理由 "The user denied bash echo DENIED_TWO."；`/quit` 退出码 0，且没有本轮的 `opencode serve` 残留（对照：直接 SIGKILL 父进程会留下孤儿子进程）。离线测试用注入的假 fetch/spawn 和假 authorizer 覆盖上述每条分支。

### 已验证：claude（Claude Code 2.1.296）

后端的 argv 形状：`claude -p <prompt> --output-format stream-json --verbose --append-system-prompt <名册提示> [--allowedTools ...] --tools <精确白名单> [--mcp-config <team-mcp.json> --strict-mcp-config] [--model <alias>] --session-id|--resume <uuid>`。每 rob 一个 `CLAUDE_CONFIG_DIR`（`~/.config/my-agent/claude/<name>`，用 `MY_AGENT_CLAUDE_CONFIG_DIR` 改前缀）。实测：claude 在该目录里创建 `.claude.json`、`projects/`、`sessions/`，rob 的会话不进用户的 `~/.claude`；把 `CLAUDE_CONFIG_DIR` 指向隔离目录后，用户级 `~/.claude.json` 里的 MCP 服务不加载（不设置时会以 `source: "user"` 加载），所以 `--strict-mcp-config` 是双保险。回合进程用 `detached` 起在独立进程组里（`src/util/process.ts` 的 `killProcessGroup`），abort 和 10 分钟超时都杀掉 claude 及其子进程。会话只在回合 `ok` 后记住 `--session-id` 的 uuid，失败的回合不会让下一回合 `--resume` 一个 claude 没保存过的会话。接入 provider env 后实测 `--model`：不带 `--model` 时事件里的模型是 `deepseek-flash`；带 `--model sonnet` 时 claude 把别名解析为 `claude-sonnet-5-5` 并写进事件，请求仍发往配置的端点且回合成功，所以 `[--model <alias>]` 保留。

工具与桥。规则解析为 `allow` 的内建工具进 `--tools` 精确白名单和 `--allowedTools`；`ask` 和 `deny` 不进白名单（没有交互审批桥，`ask` 等价于拒绝）。桥接的团队工具每回合写成 `team-mcp.json`（`mcpServers["myagent-team"]` 是 `node <shim>`，env 是 `turn.bridge.childEnv()` 原样）并以 `mcp__myagent-team__send_message`、`mcp__myagent-team__delegate` 进 `--allowedTools`，claude 只负责放行，授权仍由 gateway 做。真实 claude 探针：用后端写出的 shim 与配置跑 `claude -p`，`system/init` 事件报告 `mcp_servers: [{name: "myagent-team", status: "connected", source: "dynamic"}]`，工具表里出现上述两个 MCP 名字，与 `--allowedTools` 的拼写一致。接入 provider env 前，本机 claude 在隔离的 `CLAUDE_CONFIG_DIR` 里没有凭据，任何回合都在 `result` 事件返回 `is_error: true`、`result: "Not logged in · Please run /login"`（进程退出码 1，`apiKeySource: "none"`），所以「claude 真正调用 `send_message` 并留下私聊记录」当时没有真实验证，只有假 claude 的离线测试。现在 `childProviderEnv` 把 DeepSeek 的 Anthropic 兼容端点写进子进程 env，真实 Team 探针（1 个 claude rob + 1 个 worker，`providerEnv = childProviderEnv(settings, apiKey)`）通过：子进程 env 的键为 `DEEPSEEK_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL`，`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，两个模型变量都是 `deepseek-flash`，`ANTHROPIC_AUTH_TOKEN` 等于解析出的 key；claude 的 `send_message` 返回 `Message queued for "worker".`，DM 日志出现 `planner -> worker: "probe ping from claude"`，worker 回复 `worker -> planner: "pong — worker rob alive..."`；`delegate` 的 `tool_finished` 为 `ok=true output="delegate-ok"`，子 agent `planner-sub-0` 的文本是 `"delegate-ok"`；两次运行都通过，约 6 秒。对照探针把 providerEnv 还原成旧的仅 `DEEPSEEK_API_KEY` 映射：1.6 秒内 `planner errors: ["Not logged in · Please run /login"]`、`done: error`、0 条 DM。preset 没有 Anthropic 兼容端点时（`openai`）`childProviderEnv` 不加 `ANTHROPIC_*`，claude 仍靠自己的登录。

工具面收紧（`eb6d402`）。`--tools` 是 claude 内建工具的精确白名单，后端把按 `allow` 选出的名字原样传入；`--disallowedTools` 不再传。实测（真实 2.1.296，后端写出的 `--mcp-config` 与 `--strict-mcp-config`）：只读规则下 init 工具表恰为 `["Glob","Grep","Read","mcp__myagent-team__delegate","mcp__myagent-team__send_message"]`；read 和 write 都 allow、edit deny 时为 `["Glob","Grep","Read","Write","mcp__myagent-team__delegate","mcp__myagent-team__send_message"]`；全部拒绝时为 `["mcp__myagent-team__delegate","mcp__myagent-team__send_message"]`（`--tools ""`）。同一组参数加上旧的 `--disallowedTools` 前后 init 列表逐项相同，所以它已冗余。`CLAUDE_TOOLS` 仍只覆盖 8 个内建工具（其中 `WebFetch`、`WebSearch` 在本分支没有对应的 my-agent 工具），其余内建工具（`Task`、`Workflow`、`NotebookEdit`、`CronCreate` 等）现在不进白名单，rob 无法使用。

### 建议

1. 先确认是含义 A 还是 B。如果是 A，不需要改设计，只需要配置 `native` 的 `preset`。
2. 如果是 B，把它放在 R3 之后作为 **R4**，并且先做一个验证阶段：在有这些 CLI 的机器上确认它们的非交互模式（参数、输出格式、能否提供工具调用信息）。这台机器上没有安装，所以 R4 的第一步必须是安装并验证，不能凭文档假设。
3. R4 的第一版只做「派发任务、返回最终文本」，不提供私聊和审批，并明确标注这些 rob 的权限边界。

## 下一步实现

1. R1：核心（`Rob` actor、收件箱、`drainInput` 钩子、`send_message` 和 `delegate` 工具、`Team` 的无界面运行）。用 MockProvider 测试。
2. R2：TUI（rob 列表、`@name` 派发、只读的私聊和子 agent 视图、审批队列、插话）。
3. R3：加固（文件路径锁、私聊和深度上限、团队费用统计、端到端测试）。
