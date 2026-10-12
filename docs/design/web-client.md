# Web 客户端设计：浏览器 UI + Bot 广场

目标：给 my-agent 做一个非 TUI 的本地 Web 客户端。用浏览器聊天，保留工具调用、权限审批、会话切换，并在配了 `robs` 时提供「Bot 广场」多 Bot 布局。内核（`src/agent`、`src/tools`）不改，只新增一个渲染器 + 一层薄服务。

## 实现状态

已全部实现（M0–M5），分支 `feat/web-client`。

- 服务端 `src/serve/`：`hub`（接口与事件总线）、`solo`（`runAgent` + `drainInput` + session store）、`team`（包 `Team`，映射 `TeamEvent`）、`server`（Fastify：SSE、POST 路由、`@fastify/static` + SPA 回退）、`open-browser`。
- 协议 `shared/protocol.ts`，前后端共用（无 import，Vite 与 tsc 都能直接读）。
- CLI `my-agent serve`，默认端口 4317，默认绑 `127.0.0.1`。
- 前端 `web/`：Vite + React + TS，`state.ts` 纯 reducer、`useHub.ts` 管 SSE 与 POST，组件对应线框图的 ①–⑤。
- 测试：`test/serve/`（Solo 闭环、插话、审批拒绝、会话切换、中断、Team 中断、真实 HTTP/SSE 端到端）与 `test/web/state.test.ts`（reducer）。

### 与设计的偏差

- **插话语义**：设计原写「与 TUI 的 `drainInput` 一致」，但 TUI 在 `streaming` 时直接丢弃提交（`src/tui/App.tsx` 的 `if (controllerRef.current !== null) return`）。Web 客户端改为真正的插话：消息入队，在下个步边界注入；若回合先结束，队列里剩下的消息自动作为新回合续跑，绝不丢失。「停止」清空待发队列。
- **对内核的改动不止一处**：除 `Rob.abortTurn` 与 `Team.interrupt`，`ApprovalQueue` 另加 `denyRob`，让中断先拒绝该 rob 的待决审批，否则 authorizer 会一直等待。`abortTurn` 只在 rob 处于 `working`/`waiting_approval` 时 abort，避免在空闲时取消 `waitForBatch` 而结束 run 循环。
- **根 tsconfig 加 `esModuleInterop`**：`fastify` 与 `@fastify/static` 的声明用 `export =`，默认导入需要它。同时 `include` 加 `shared`、`exclude` 加 `test/web`（该测试 import 前端源码，前端用 bundler 解析，不走 NodeNext）。
- **前端 JSON 处理**：`web/tsconfig.json` 用单文件 + `tsc --noEmit`，未用 `tsc -b` 的项目引用（引用要求 `composite`，与 `noEmit` 冲突）。前端独立用 TypeScript 5.9，根仓库是 7.x。
- **`summarizeArgs` 在前端有一份本地副本**，避免前端构建依赖 Node 侧模块图；`shared/protocol.ts` 里的 `AgentEvent` 同样是 `src/agent/events.ts` 的镜像。
- **组件测试**：只提交了纯 reducer 测试。DOM 级渲染测试需要 jsdom，未纳入首版。
- **CSS 抑制**：`web/src/styles.css` 两处 `code` 覆盖规则加了带理由的 `noDescendingSpecificity` 抑制。


## 已确认的决策

- 形态：本地 Web UI，`my-agent serve` 起本地服务，浏览器打开。
- 依赖：允许引入框架（后端 Fastify，前端 Vite + React）。
- 范围：单 Agent 聊天闭环 +「Bot 广场」多 Bot 布局。
- 默认端口：**4317**。
- DM 流：**首版要做**。
- interrupt（运行中取消）：**两种模式都要做**（含 Team 模式）。

## 完成定义（可验证）

1. `my-agent serve` 启动后打印 URL，浏览器打开即见 UI；Ctrl+C 退出且不残留子进程。
2. 发一条消息，回答**逐字流式**出现；助手消息里的 Markdown 与代码块正确渲染。
3. 需要审批的工具（`bash` / `write_file` / `edit_file`）会弹窗；`allow once` 放行一次，`allow always` 写入 `my-agent.json` 并在后续同规则请求不再弹窗，`deny` 让工具以拒绝理由结束。危险命令不可 `allow always`。
4. 运行中点「停止」能中断当前回合（Solo 与 Team 都生效），UI 回到 idle，之后还能继续对话。
5. 运行中再发消息作为插话：在下一步注入；若回合先结束则自动续跑，不丢消息。点「停止」会清空待发队列并中断当前回合。
6. Solo 模式：左侧列出工作区历史会话，可新建/打开/切换；刷新页面后历史仍在（走现有 session store）。
7. 配了 `robs` 时：Bot 广场列出每个 Bot 及其状态（idle/working/waiting_approval/stopped），能看到 Bot 之间的 DM 流；对某个 Bot 发送即 `dispatch`。
8. allow-all 开关随时可切；被自动放行的危险调用在对话里留一条 `notice`。
9. `pnpm test`、`pnpm typecheck`、`pnpm lint` 通过。

## 总体架构

```
浏览器 (web/  React + Vite)
   │  EventSource  GET  /api/events                    服务器 → 浏览器（SSE）
   │  fetch  POST   /api/send|interrupt|approval|allow-all|sessions/*
   ▼
my-agent serve (Fastify, 默认 127.0.0.1:4317)
   ├─ Hub 抽象 ──┬─ SoloHub  : robs 为空 → runAgent + 会话持久化
   │             └─ TeamHub  : 配了 robs → Team（多 Bot）
   ├─ 静态托管 web/dist（SPA fallback 到 index.html）
   └─ 复用 resolveConfig / provider / MCP / authorizer / session store
```

运行模式与 `runTui` 的判断一致：`resolved.config.robs.length > 0` 走 TeamHub，否则走 SoloHub。DEFAULT_PORT = 4317，默认只绑 `127.0.0.1`。

## 复用点（不改内核）

| 能力 | 现有实现 | 用途 |
|---|---|---|
| 事件流引擎 | `runAgent()` + `AgentEvent`（`src/agent/agent.ts` / `events.ts`） | SSE 推送的原始事件 |
| Provider | `createOpenAICompatibleProvider()` | 同上 |
| 配置解析 | `resolveConfig()`（`src/config/resolve.ts`） | provider / apiKey / permissions / robs / mcp / compaction |
| 权限 | `createAuthorizer()` + `createAllowAll()` + `approval` 回调 | 弹窗与 allow-all |
| MCP | `connectMcpServers()`（`src/mcp/manager.ts`） | 额外工具 |
| 会话持久化 | `session/store.ts` | Solo 的历史会话 |
| 多 Bot | `Team` / `Rob` + `TeamEvent`（`src/rob/`） | Bot 广场 / DM / 跨 Bot 审批 |
| setup 向导 | `missingKeyDecision` / `runSetupWizard` | 首次无 key 时引导 |
| 参数摘要 | `summarizeArgs()`（`src/tui/summarize.ts`） | 回填历史会话时重建工具卡 |

## 对现有代码的唯一改动：Team 的可中断回合

`Rob` 已经持有 `private currentRun: AbortController | null`，`stop()` 会 abort 它但会把 rob 永久置为 `stopped`。为了「中断当前回合、保住 Bot 存活」，做一次小幅**增量**改动：

- `src/rob/rob.ts`：新增 `abortTurn(): void { this.currentRun?.abort(); }`。
- `src/rob/team.ts`：新增 `interrupt(name: string): void`，内部 `requireRob(name).abortTurn()`。

abort 后 `runAgent` 以 `reason: "aborted"` 收尾并发 `done`，`Rob.run` 的循环继续等待下一批输入，状态回到 `idle`。Solo 模式用同样的 `AbortController` 语义，两条路径行为一致。

## 线上协议（新增 `shared/protocol.ts`，纯类型、前后端共用）

放在仓库根的 `shared/`，内容**不 import 任何 Node 代码**（从 `src/agent/events.ts` 镜像一份事件联合类型），这样 Vite 能直接引用又不牵扯 Node 依赖树。根 `tsconfig.json` 的 `include` 加 `shared`；`web/tsconfig.json` 的 `include` 加 `../shared`。

### 服务器 → 浏览器（SSE `data:` 行）

| 事件 | 负载 | 作用 |
|---|---|---|
| `hello` | `{ workspaceRoot, model, mode, bots, sessions, allowAll }` | 连接即发快照 |
| `session_opened` | `{ bot, sessionId, messages: TranscriptMessage[], usage }` | 打开会话时回填已渲染记录 |
| `sessions` | `{ sessions: SessionSummaryInfo[] }` | 会话列表变化 |
| `bot_status` | `{ bot, status, messageCount, pending, lastMessage, usage }` | 状态点/计数 |
| `agent_event` | `{ bot, event: AgentEvent }` | 原样转发流事件 |
| `approval_requested` | `{ request: { id, bot, toolName, subject, dangerous, rule } }` | 弹窗 |
| `approval_resolved` | `{ id, decision }` | 关弹窗 |
| `notice` | `{ bot, text }` | allow-all 自动放行等 |
| `dm` | `{ entry: { from, to, text, at } }` | Bot 广场 DM 流 |
| `subagent` | `{ entry: { parent, id, at, event } }` | （可选）子 agent 事件 |
| `error` | `{ bot?, message }` | 致命错误 |

核心事件类型（与 `src/agent/events.ts` 对齐）：

```ts
type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_started"; id: string; name: string; args: unknown }
  | { type: "tool_finished"; id: string; name: string; ok: boolean;
      status: "ok" | "error" | "blocked"; summary: string; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number;
      cacheHitTokens?: number; cacheMissTokens?: number; reasoningTokens?: number }
  | { type: "compacted"; removedMessages: number; summaryChars: number }
  | { type: "error"; message: string }
  | { type: "done"; reason: "finished" | "max_steps" | "aborted" | "error"; steps: number };
```

`TranscriptMessage`（回填历史用，前端直接渲染）：

```ts
interface ToolCallView { id: string; name: string; args: unknown;
  summary: string; status: "ok" | "error" | "blocked"; output: string }
interface TranscriptMessage {
  id: number; role: "user" | "assistant" | "system";
  text: string; reasoning?: string; tools?: ToolCallView[]
}
```

### 浏览器 → 服务器（POST JSON）

| 路由 | 负载 | 作用 |
|---|---|---|
| `POST /api/send` | `{ bot, text }` | 发送；运行中则作为插话入队 |
| `POST /api/interrupt` | `{ bot }` | 中断当前回合 |
| `POST /api/approval` | `{ id, decision: "allow_once" \| "allow_always" \| "deny" }` | 回答审批 |
| `POST /api/allow-all` | `{ on: boolean }` | 切换 allow-all |
| `POST /api/sessions/new` | `{ bot }` | 新建会话（Solo） |
| `POST /api/sessions/open` | `{ bot, id }` | 打开会话（Solo） |
| `GET  /api/sessions` | — | 会话列表（Solo） |

## 后端文件（新增 `src/serve/`）

| 文件 | 职责 |
|---|---|
| `protocol.ts`（或直接用 `shared/`） | 服务端侧引用协议类型 |
| `hub.ts` | `Hub` 接口 + 工厂（按 robs 选 Solo/Team） |
| `solo.ts` | 单 Agent：`runAgent` 循环、`drainInput` 队列、会话 save/load、审批桥、`AbortController` |
| `team.ts` | 包一层 `Team`：`subscribe` 映射 `TeamEvent` → `ServerEvent`、dispatch/interject/interrupt/审批 |
| `server.ts` | Fastify：SSE 路由、POST 路由、`@fastify/static` 托管 `web/dist`、SPA fallback、心跳 |
| `open-browser.ts` | 跨平台打开浏览器（`xdg-open` / `open` / `start`） |

`Hub` 接口（两种模式同构）：

```ts
interface Hub {
  readonly mode: "solo" | "team";
  hello(): Promise<HelloEvent>;
  subscribe(listener: (event: ServerEvent) => void): () => void;
  dispatch(bot: string, text: string): void;
  interrupt(bot: string): void;
  resolveApproval(id: string, decision: ApprovalChoice): void;
  setAllowAll(on: boolean): void;
  newSession(bot: string): Promise<void>;
  openSession(bot: string, id: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`src/index.ts` 新增命令：

```
my-agent serve [--port 4317] [--host 127.0.0.1] [--open] [-m <model>] [--max-steps <n>]
```

web/dist 路径在 `src/index.ts` 用 `new URL("../web/dist", import.meta.url)` 解析（与读 `package.json` 同一技巧，`tsx src/index.ts` 与打包后的 `dist/index.js` 都成立），再传给 `runServe`。

## 前端文件（新增 `web/`，Vite + React + TS）

| 文件 | 对应线框图 |
|---|---|
| `src/main.tsx` / `index.html` | 入口 |
| `src/App.tsx` | 整体三栏网格 + 视图切换（对话 / Bot 广场） |
| `src/useHub.ts` | `EventSource` 订阅 + reducer，产出客户端状态；封装 POST |
| `src/state.ts` | 客户端 reducer（移植 `src/tui/state.ts` 的 `applyAgentEvent` 思路） |
| `src/protocol.ts` | `export * from "../../shared/protocol"` |
| `src/components/TopBar.tsx` | ① 顶栏：Logo、视图切换、model、连接状态 |
| `src/components/Sidebar.tsx` | ② 左侧：Bot 列表（状态点）、当前 Bot 的会话列表、＋新会话、allow-all、主题 |
| `src/components/BotPlaza.tsx` | Bot 广场：Bot 卡片 + DM 流 |
| `src/components/BotHeader.tsx` | ③-A Bot 头像 / 名字 / 描述（只读展示） |
| `src/components/SessionTabs.tsx` | ③-B 会话标签页 |
| `src/components/MessageList.tsx` | ③-C 消息流 |
| `src/components/ToolCard.tsx` | 工具卡：状态、摘要、展开输出、Diff 着色 |
| `src/components/Markdown.tsx` | `marked` 解析 + `dompurify` 清洗 |
| `src/components/Composer.tsx` | ③-D 输入区：多行、Enter 发送、Shift+Enter 换行、发送/停止、allow-all |
| `src/components/PermissionModal.tsx` | 权限弹窗：allow once / allow always / deny，危险标记 |
| `src/components/StatusBar.tsx` | ⑤ 底部：usage、session id、连接状态 |
| `src/styles.css` | 深色主题变量（Grok 风） |

## 关键流程

### 发送与流式
前端乐观追加用户气泡 → `POST /api/send` → 服务端 `runAgent` → 逐步 `agent_event` → reducer 累积到该 Bot 的助手消息（`text_delta` 追加正文，`reasoning_delta` 追加折叠区，`tool_started` 建卡，`tool_finished` 更新卡）。

### 插话（运行中再发）
Solo：消息进 `drainInput` 队列，`runAgent` 每步边界取走并注入。若回合在下一步之前就结束，队列里剩下的消息会自动作为新回合续跑，绝不丢失；点「停止」会清空待发队列。（TUI 在 `streaming` 时直接丢弃提交，Web 客户端在这里是增强。）
Team：走 `Team.interject(name, text)`，由 `Rob` 收件箱在回合中途注入。

### 权限审批
authorizer 的 `approval(request)` 挂起 → Hub 注册 `id` 并广播 `approval_requested` → 弹窗 → `POST /api/approval` → `resolveApproval(id, decision)`。
- `allow_always` 由 authorizer 写 `my-agent.json`（危险命令除外），Team 侧的 `ApprovalQueue` 会对同规则重复请求去重。
- Team 模式的 id 来自 `TeamEvent.approval_requested.request.id`，用 `Team.resolveApproval(id, decision)` 回答。

### 中断
- Solo：`AbortController.abort()`，`runAgent` 以 `aborted` 收尾，`done` 事件让 UI 回 idle。
- Team：`Team.interrupt(name)` → `Rob.abortTurn()`（本文「对现有代码的唯一改动」）。回合结束、Bot 存活，可继续对话。

### 会话（Solo）
`GET /api/sessions` 返回摘要；`sessions/new` 建新会话；`sessions/open` 加载并用 `TranscriptMessage[]` 经 `session_opened` 回填。每回合结束 `saveSession`（`withoutSystem`），并广播更新后的 `sessions`。

### allow-all
`createAllowAll()` 每个 Hub 一个；`POST /api/allow-all` 切换。危险调用被自动放行时经 `onAutoApproved` 广播 `notice`，Deny 规则仍然优先。

### Bot 广场（Team 模式）
`Team.statuses()` 给 Bot 卡；`Team.subscribe` 的 `rob_status` / `dm` / `notice` 广播给前端。Solo 模式下广场只有 1 个默认 Bot，DM 流为空。

## 依赖与构建改动

- 根 `package.json`：新增运行时依赖 `fastify`、`@fastify/static`；`files` 加 `web/dist`；`build` 追加前端构建（如 `pnpm --filter my-agent-web build`）。
- `pnpm-workspace.yaml`：加 `packages: [web]`（现已有 `allowBuilds.esbuild: true`，Vite 依赖的 esbuild 可直接构建）。
- `web/package.json`：`vite`、`react`、`react-dom`、`@vitejs/plugin-react`、`typescript`、`marked`、`dompurify`、`@types/react`、`@types/react-dom`。
- `web/vite.config.ts`：dev 时把 `/api` 代理到 `http://localhost:4317`，便于热更新开发。
- 根 `tsconfig.json` 的 `include` 加 `shared`。

## 里程碑（每步可独立验收）

- **M0 骨架**：`shared/protocol.ts` + `serve` 命令 + Fastify 起服务 + `hello` + 静态页占位。
- **M1 Solo 闭环**：SSE 流事件、发送、中断、Markdown 消息流、工具卡。
- **M2 权限**：审批弹窗 + allow-all + 落规则 + 危险标记。
- **M3 会话**：列表 / 新建 / 打开 / 标签页 + `session_opened` 回填。
- **M4 多 Bot**：`Rob.abortTurn`/`Team.interrupt` + TeamHub + Bot 广场 + DM 流 + 状态。
- **M5 打磨**：主题、状态栏、空态、错误提示、README / CHANGELOG 文档。

## 测试计划

- 后端（vitest + `test/helpers/mock-provider.ts`）：
  - Solo：发送 → 事件序列；`interrupt` 后 `done.reason === "aborted"` 且可再次发送。
  - 审批：`allow_once` / `allow_always`（含 `my-agent.json` 落规则）/ `deny` 三分支；危险命令不可记忆。
  - 会话：`save`/`open` 往返；`session_opened` 的 `TranscriptMessage` 与工具卡状态正确。
- Team：`TeamEvent` → `ServerEvent` 映射；`Team.interrupt` 中断当前回合且 rob 仍可再次 dispatch。
- 协议：`hello` 快照内容（bots/sessions/allowAll）。
- 前端：先覆盖 `state.ts` reducer 的纯函数；组件测试需另引 jsdom，可后续补。

## 新增能力：在 UI 上创建 Bot

Bot 模型修正为两个并存的概念：

- **工作区**：`assistant`，`kind: "workspace"`。普通对话 + 会话，持久化。永远在，不是 rob。
- **Rob 区**：`kind: "rob"`。单独区域，点 `＋ 创建 Bot` 填表即可新建。

因此没有模式切换。`serve` 启动时总是同时构造 `SoloHub`（工作区）和 `TeamHub`（rob 区，允许 0 个 rob），由 `CompositeHub` 合并成一个 `Hub`；两个 hub 共用一个 `AllowAll`，`CompositeHub` 按 target 路由 `dispatch` / `interrupt` / `resolveApproval`。

- 协议：`BotInfo` 加 `kind`；`hello` 去掉 `mode`；新增 `bots` 事件（roster 变化时广播）；`assistant` 为保留名，rob 不能用（`robConfigSchema` 拒绝）。
- 端点：`POST /api/bots`，body `{ name, role, model?, backend? }`，成功 `200 {ok:true, bot}`，失败 `400 {ok:false, error}`。
- 落盘：`addRob()` 复用 `writeChain` 的串行读-改-写，保留 `permissions` 与未知字段。手工写进 `my-agent.json` 的 rob 一样生效。
- 运行时：`Team.addRob()`（构造 `Rob`、入 Map、已在运行时起循环），构造路径抽成 `Team.createRob()` 供构造器与 `addRob` 共用。
- 审批 id：工作区用 `ws-approval-` 前缀，`CompositeHub` 按前缀路由，避免与 rob 队列的 `approval-` 冲突。
- 测试：`test/serve/composite.test.ts` 覆盖创建、重名、保留字段、保留名、非法 name 与不完整 cli 后端。

## 新增能力：无 key 启动 + 网页设置

- 「未配置」是 `resolveConfig` 的一个正常结果（`apiKey === undefined`），不是错误。`serve` 不再退出、不再跑 TTY 向导（向导仍保留为 `my-agent setup`）；只有配置解析失败才退出。
- `src/serve/runtime.ts` 的 `ProviderRuntime` 持有可热替换的 `Provider` + `ProviderSettings`，未配置时用 stub provider。`HubOptions` 的 `provider` / `settings` 在 `runServe` 里绑到 runtime 的 getter 上，所以 `SoloHub` 每次回合自动读到新 provider，**一行未改**；`TeamHub` 因 `Rob` 在构造时固化 provider，改为 `reconfigure` 重建 `Team`（有 rob 忙碌时拒绝）。
- 未配置时两个 hub 的 dispatch 都拦截并发一条 error，不发注定失败的请求；前端同时禁用输入。
- 端点：`GET /api/settings` → `{provider, presets}`；`POST /api/settings`（`SaveProviderBody`）→ `200 / 400 / 409 / 500`。POST 在非回环绑定时被拒绝。
- 保存流程（`src/serve/settings.ts`，单条 promise 链串行）：`validateProviderSelection` → 可选 `verifyApiKey`（失败可「仍然保存」`verify:false`）→ `writeCredential` → `writeGlobalProviderSettings` → 重新 `resolveConfig` → `buildProvider` → `applyRuntime` → 广播 `settings`。
- 密钥只进 `credentials.json`（0700/0600，原子写），不进 `config.json`，不上线，不落日志。`ProviderView` 没有密钥字段，浏览器结构上拿不到。
- 项目 `my-agent.json` 的 `provider` 会盖过全局配置。保存后检测到不一致只返回 `warning`，不假装回滚（文件此时已写入）。

## 风险与边界

- **系统提示差异**：工作区走 `SoloHub`，用标准编码 agent prompt；rob 走 `Team`，带团队提示词。两者并存，互不影响。
- **Rob 会话不持久化**：rob 的对话只在内存，刷新即丢；工作区走 session store 持久化。
- **前端构建与发布**：必须保证 `web/dist` 进 `files`，并处理 dev（`tsx src/index.ts`）与打包（`dist/index.js`）两处路径差异。
- **依赖体积**：Fastify + Vite + react-dom 明显重于现有极简风格（已确认接受）。
- **认证**：默认只绑 `127.0.0.1`，不加鉴权；若改 `--host 0.0.0.0` 需另加 token 方案（不在首版）。
- **CLI 后端 Bot 的中断**：`abortTurn` 依赖 `turn.signal` 被 cli 后端正确响应，需在真实 `pi`/`opencode` 后端上验证；未验证前 UI 至少不挂起。
