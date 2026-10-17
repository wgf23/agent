# Grok 的 Agent 架构 vs. 本仓库「CLI 后端」方案

> 状态：**v1.0** ｜ 作者：rob "aaa"（数据调研bot）｜ 日期：2026-10-15
>
> **⚠️ 资料来源说明（必读）**：本机**无外网**（`curl docs.x.ai` / `web_search` 均不可用）。
> 报告基于**模型已有知识 + 本仓库实测代码与 `docs/research/grok-bot-report.md`** 整理。
> 凡涉及 xAI 内部实现、服务端工具清单、Heavy 并行机制等**未经联网核实**的细节，一律标 **⚠️**。
> 本仓库侧的结论均为**代码级事实**（附 `文件:行`），不标 ⚠️。

---

## 0. 结论速览（TL;DR）

一句话：**Grok 能同时「调异构 agent」和「多 bot 互聊」，是因为同一个权威（xAI 服务端）同时拥有 agent loop 与工具注册表**，
于是「另一个 agent」只是注册表里一个可调用的条目——调用它、和它聊天、把它当工具用，走的是**同一条链路、同一套结果回流契约**。

本仓库的 CLI 后端之所以做不到，**不是「CLI 就不可能」**，而是：**loop 被交给了外部进程，而我们把工具注册表留在了自己手里，
两者之间只桥接了 4 个文件/命令工具**。团队工具（`send_message`/`read_messages`/`list_robs`/`delegate`）从未进入子进程的注册表，
能力所有权被**割裂**，于是 CLI bot「收得到 DM、回不了消息、没有 roster」。

---

## 1. 先立一个分析框架：四个正交的所有权

要解释「为什么能」和「为什么不能」，只需问四个问题——**谁拥有**：

| # | 维度 | 含义 |
|---|---|---|
| ① | **Loop 所有权** | 谁决定「下一步做什么」（`prompt → 模型 → tool call → 结果 → 再喂模型`的循环） |
| ② | **工具执行所有权** | 谁真正运行工具代码（读文件、发消息、起子 agent） |
| ③ | **寻址/注册表** | 谁维护「可被调用的对象名单」（工具名、agent 名、bot roster） |
| ④ | **回流通道** | 子 agent/工具的结果以什么形态回到 loop，再进入下一轮上下文 |

**核心命题**：当 ① 和 ③ 属于**同一个权威**时，「调异构 agent」与「bot 间互聊」就退化为**同一种原语**；
当 ① 和 ③ 被拆到两个进程、而中间没有**双向注册通道**时，两者同时失效。

---

## 2. Grok 侧：这几条链路各是什么样

### 2.1 Grok 4 Heavy —— 并行多智能体 + 仲裁（"star/ensemble" 拓扑）⚠️
- **谁拥有 loop**：xAI 服务端的**编排层**（orchestrator/judge）⚠️。客户端只是瘦前端。
- **链路**：一个问题 → 编排层**广播**给 N 个 worker agent → 各自独立推理 → 结果**回流到编排层** →
  由 judge/ensemble 层**交叉验证/择优/合成** → 产出最终答案。
- **回流形态**：子 agent **不直接互相对话**，而是把结果交回**同一个汇聚点**（编排层），
  由后者写入最终 transcript。worker 之间是「共享任务上下文 + 结果汇聚」，不是自由 P2P。
- **对本仓库的类比**：这一层 ≈ 本仓库的 **`delegate`（子 agent）**——一次性、结果回流、有深度上限
  （`MAX_DELEGATE_DEPTH = 1`，`src/rob/tools.ts:8`），而不是 `send_message` 那种点对点投递。

### 2.2 Agent Tools / 服务端工具编排 ⚠️
- **谁拥有 loop**：仍是 xAI 服务端的模型服务。**工具是服务端注册的一等公民**。
- **链路**：模型在一个回合内**自主决定调用哪个工具**（Web Search / X Search / 代码执行等 ⚠️）→
  服务端执行 → 结构化结果**作为 tool result 帧回流** → 插入下一轮上下文。
- **关键点**：工具调用是**可观察事件**（streaming 里的 tool-call 帧），所以前端能画工具卡片。
  这正好对应本仓库 `tool_started`/`tool_finished` 事件（`src/agent/events.ts:15`）。

### 2.3 用 xAI API 自建 bot-to-bot ⚠️
- **谁拥有 loop**：**开发者自己**的编排代码（不是 xAI）。API 是 OpenAI 兼容的无状态补全接口 ⚠️。
- **链路**：A 产出 → **append 到 B 的 messages** → B 产出 → 回填 A → 循环。
- **要点**：bot-to-bot 在这里就是「**把对方的消息追加进自己的上下文**」，本质是**消息总线**，
  与「调工具」共享同一个 transcript。必须配轮数上限/预算/超时防死循环（`grok-bot-report.md` §2.3 已述）。

### 2.4 三条链路的归一（关键）

把上面三条并排看，会发现它们**不是三种机制，而是同一个机制的三种用法**：

| 用法 | 复用到的原语 |
|---|---|
| Heavy 并行 worker | 「把任务**派发给一个命名 agent**，结果**回流到 loop**」 |
| Agent Tools | 「调用**注册表里的一个条目**，结果**回流到 loop**」 |
| API bot-to-bot | 「把消息**投递到一个命名收件箱**，它**成为对方的下一轮输入**」 |

三者的公共骨架 = **① 一个拥有 loop 的权威 + ③ 一份可寻址注册表 + ④ 一条结果回流通道**。

---

## 3. 为什么「调异构 agent」和「bot 间互聊」天然能共存？

以下是可迁移的**关键设计点**（与具体厂商无关，是本报告最想沉淀的部分）：

1. **Loop 与注册表同归一个权威（co-location）。**
   只要«拥有循环»的人同时«拥有名单»，则任何新能力（一个新工具、一个新 agent）= **一次注册**，
   不需要跨进程协商、不需要改协议。Grok 把两者都放在服务端，于是「加一个 agent」和「加一个工具」是同一种操作。

2. **Agent ≡ Tool 的同构接口。**
   异构 agent 被包装成「一个可调用条目」，它的入参是任务、出参是结果，**契约与普通工具完全一致**。
   因此 loop 不需要为「调 agent」写特例——这正是本仓库 `delegate` 的形态（`src/rob/tools.ts:142`）。

3. **消息投递是一等原语，且与 tool result 共用一条上下文。**
   「给另一个 bot 发消息」= 往对方上下文 append 一条输入，从而**触发对方一轮**。
   因为它和 tool result **写进同一个 transcript**，所以模型在同一个 loop 里既能「调工具」又能「跟人/机器人聊天」，
   **无需切换模式**。本仓库 `postDm → deliver(kind:"dm") → 对方下一轮被唤起` 正是这个原语
   （`src/rob/team.ts:396`、`backend.ts:157`）。

4. **回流有明确的汇聚点。**
   子 agent 结果**回到发起者**，由发起者（或 judge）决定如何并入最终答案。这样多 agent 不会互相阻塞、不会死锁——
   因为**没有两个 bot 直接互等**，只有「发起 → 回流」的单向边（Heavy 的 star 拓扑）。

5. **有界编排（bounded orchestration）。**
   天然共存的另一面是**天然危险**（无限对话/费用失控）。Grok Heavy 用「一次性广播 + 仲裁」避免自由对话环路 ⚠️；
   本仓库用 `DELEGATE` 深度 1、`DM_LIMIT_PER_RUN = 20`（`src/rob/tools.ts:6`）、
   `runDiscussion` 的 `maxRounds`/`waitMs`/quiescence 检测（`src/rob/discussion.ts:54`）来封顶。

6. **身份与能力都来自同一份 roster。**
   `list_robs` 能列出「团队有哪些 bot、各自角色」，与「能被调用」是同一份数据。
   注册表统一 ⇒ 可见性统一 ⇒ 互聊与互调都不会出现「幽灵收件人」。

**一句话**：共存不是靠某个炫技功能，而是靠**「一个 loop 拥有者 + 一份统一注册表 + 一条方向明确的回流通道」**这套最小骨架。

---

## 4. 对比本仓库：差在哪

### 4.1 两种后端的所有权对照

| 维度 | **native 后端** | **cli 后端（pi/opencode/claude）** |
|---|---|---|
| ① Loop 所有权 | **本仓库**（`runAgent`，`src/agent/agent.ts:98`） | **外部 CLI 进程**（`backend.ts` 的整个 loop 交出去） |
| ② 工具执行 | 本仓库（内置工具 + `extraTools`） | 外部进程执行；本仓库只**桥接 4 个**：`read_file/write_file/edit_file/bash`（`cli-backend.ts:45` `PI_TOOLS`） |
| ③ 注册表 | 本仓库注册团队工具（`backend.ts:86-99`） | **外部进程的注册表；本仓库无法写入** |
| ④ 回流通道 | `runAgent` 内的 tool result → 下一轮 | 只有 RPC 事件回传（streaming / approval），**没有工具注册通道** |
| 团队工具可用性 | `send_message`/`list_robs`/`read_messages`/`delegate` **全部可用** | **全部不可用**（未桥接） |
| DM 行为 | 可收可发、有 roster、可 delegate | **收得到**（inbound 照常投递）但**回不了**、无 roster、不能 delegate |

> 第 3 行是本仓库自己的注释所承认的：`rob.ts:66` 写着
> *"MCP tools are native-only; a cli backend runs its own tool registry."*

### 4.2 根因：能力所有权割裂 + 缺双向注册通道

- **① 与 ③ 被拆到两个进程**：native 时二者都在本仓库（所以一切正常）；
  CLI 时 ③ 跑到子进程里，而**没有一个机制把«团队工具»注册进那个子进程的注册表**。
- **桥是单向的、且是白名单写死的**：`PI_TOOLS`（`cli-backend.ts:45`）只做 4 个工具的名字映射，
  子进程的注册表里**根本没有** `send_message` 等条目，模型当然不会去调。
- **结果**：CLI bot 的 inbound 到达是对的（`rob.ts:296` 起 `backend.run(turn)` 照常），
  但它的**出口能力被掐断**——不是「DM 坏了」，而是「回信这个工具不存在」。

### 4.3 一个反直觉但重要的观察

> **approval 桥已经证明：子进程 ↔ 本仓库之间存在一条可用的双向 RPC 通道。**

`cli-backend.ts:31` 的 `APPROVAL_EXTENSION` 让 pi 在每次 tool call 时用 `ctx.ui.confirm(...)` **回调本仓库**，
本仓库经 `handleApproval`（`cli-backend.ts:270`）作答后回传 `extension_ui_response`。
也就是说：**「外部 loop 主动找到我们」这条通道今天就在跑**，只是它被用来做「审批」而非「注册团队工具」。

**结论：CLI 后端做不到「互调 + 互聊」不是架构上的不可能，而是集成面上的未接线。**
差别在 Grok 用同一条通道干「工具/agent 调用」，本仓库只用它干「审批」。

---

## 5. 可落地的演进方向（供 leader 评估，非本次交付）

按「改造成本 / 是否复用现有通道」排序：

1. **把团队工具做成 MCP server（推荐）**——`send_message`/`read_messages`/`list_robs`/`delegate` 暴露为 MCP 工具，
   让 pi / opencode / claude 各自用它原生的 MCP 加载（opencode、claude 原生支持 MCP ⚠️；pi 走 extension ⚠️）。
   这样 CLI bot 的 loop 仍归外部，但**注册表重新包含了团队工具** → 互聊/互调恢复。
2. **复用 approval 那条 RPC 通道**：把 `extension_ui_request` 从「只处理 confirm」扩展到「转发团队工具调用」，
   由本仓库执行后回传 tool result。成本最低，但需要 pi 的 extension API 允许**注册新工具**而非仅拦截 ⚠️。
3. **反向方案：不要交出 loop。** 把「外部 CLI bot」当成**一个工具**（类似 `bash`），由本仓库 loop 发起、
   拿到它的最终输出再回流——这正是 Grok「把 agent 当工具/被调用条目」的同构做法，也最贴近 `delegate` 的现有形态。
   代价：失去外部 CLI 的自主多轮能力。

> 三者本质都是同一件事：**让「谁拥有 loop」和「谁能被调用」重新对齐**——要么把团队工具注册进去（1、2），
> 要么把 loop 收回来（3）。这正是 §3 命题的工程化表达。

---

## 6. 与本仓库现有代码的事实锚点（代码级，非 ⚠️）

- 团队工具只在 native 注册：`src/rob/backend.ts:86-99`（`runAgent(... extraTools: [send_message, list_robs, read_messages, delegate] ...)`）。
- native loop 入口：`src/agent/agent.ts:98` `runAgent`，`extraTools` 合入 `toolDefinitions()`（`agent.ts:127`）。
- CLI 只桥接 4 个工具：`src/rob/cli-backend.ts:45` `PI_TOOLS`；`--tools` 白名单在 `cli-backend.ts:133`。
- 子进程拥有 loop：`cli-backend.ts:119-150` 构造 `pi --mode rpc --continue` 并 `runPi(...)`；工具注册表由 pi 持有。
- 本仓库自认：`src/rob/rob.ts:66` “MCP tools are native-only; a cli backend runs its own tool registry.”
- 双向 RPC 通道实证：`cli-backend.ts:31` `APPROVAL_EXTENSION` + `cli-backend.ts:270` `handleApproval` + `extension_ui_response`。
- DM 原语：`src/rob/team.ts:396` `postDm(from,to,text)` → `deliver({kind:"dm"})` → 对方下一轮；
  入站头 `backend.ts:153` `headerFor` 的 `[from rob:<name>]`。
- 有界编排：`MAX_DELEGATE_DEPTH=1`、`DM_LIMIT_PER_RUN=20`（`src/rob/tools.ts:6,8`）；
  `runDiscussion` 的回合/超时/静默收敛（`src/rob/discussion.ts:54`）。
- Grok 侧概念来源：`docs/research/grok-bot-report.md` §2（Heavy / Agent Tools / API bot-to-bot / X 账号级回复）。

---

## 7. 不确定性与待核实清单（⚠️）

- [ ] xAI 是否公开「Agent Tools / 服务端工具」的确切清单与调用协议
- [ ] Grok 4 Heavy 的真实编排形态：worker 数、是否有 judge、是否投票、是否互相可见
- [ ] xAI API 是否提供「agent 注册/寻址」类服务端原语，还是纯无状态补全
- [ ] pi 的 extension API 能否**注册新工具**（而非仅 `tool_call` 拦截）——决定方向 2 是否可行
- [ ] opencode / claude 后端各自的 MCP 加载能力与配置方式
- [ ] 本仓库 `runSubagent`/`delegate` 是否已具备把异构 CLI 当子 agent 调用的接口（`src/rob/rob.ts:365`）

---

*（本文件聚焦「外部对标 + 架构归因」，与 `grok-bot-report.md`（产品/交互盘点）、`grok-ui-design.md`（UI 设计）互补。联网恢复后优先核实第 7 节。）*
