# Rob 设计：独立 agent 团队

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

## 下一步实现

1. R1：核心（`Rob` actor、收件箱、`drainInput` 钩子、`send_message` 和 `delegate` 工具、`Team` 的无界面运行）。用 MockProvider 测试。
2. R2：TUI（rob 列表、`@name` 派发、只读的私聊和子 agent 视图、审批队列、插话）。
3. R3：加固（文件路径锁、私聊和深度上限、团队费用统计、端到端测试）。
