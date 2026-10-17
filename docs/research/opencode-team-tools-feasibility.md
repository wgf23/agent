# opencode 后端暴露团队工具的可行性调研

> 状态：**已核实（含联网核对 opencode 官方 schema/文档 + 本机二进制字符串 + 本仓库代码）**
> 作者：rob "opencode" ｜ 日期：2026-10-15
> 委派人：rob "leader"
> 目标：判断 `opencode` CLI 后端能否向 opencode 暴露 `send_message` / `read_messages` / `list_robs` / `delegate`，让 opencode bot 也参与 bot 间聊天。

---

## 0. 结论速览（TL;DR）

**可行。** 推荐用 **opencode 的 MCP（remote / Streamable HTTP）**：由 `createOpencodeBackend` 自己起一个只绑 `127.0.0.1` 的随机端口 HTTP MCP server，在 `OPENCODE_CONFIG_CONTENT` 里把它注册成 `mcp.servers.<name>`。opencode 子进程调用 MCP 工具时，HTTP 请求回到 **my-agent 进程内的处理器**，处理器直接调用 `Team.postDm` / `readMessages` / `Team.roster` / `runSubagent`——**只跨一次回环 HTTP，不跨 Team 语义边界**。

- **DM 游标与 Team 引用仍归 my-agent**：游标继续放在 `Rob.dmCursor`（`src/rob/rob.ts:105,409-413`），Team 仍是 `src/rob/team.ts` 里的 `Team` 实例；两者都原地复用，不引入跨进程状态。
- **卡点不在「无法暴露工具」**：opencode 明确支持 MCP（local stdio + remote HTTP）与自定义工具/插件，见 §2。真正需要处理的是 **① 权限规则集的总 deny 基线**、**② MCP 工具的动作名映射**、**③ `delegate` 的 ask 门控**，见 §4/§5.4。
- **最小改动点**：`createOpencodeBackend` 增加 `team` / `readMessages` / `runSubagent` 三个入参（与 `NativeBackendOptions` 对称），配置里加 `mcp`，加一个回环 MCP server + `dispose` 关停。不需要改 fastify server，也不需要往磁盘写任何文件。

---

## 1. 问题拆解

要让 opencode bot 用上团队工具，必须同时满足三件事：

1. **opencode 能发现并调用外部工具**（扩展机制）。
2. **工具执行能回到 my-agent 的 `Team`**（跨进程回调）。
3. **不破坏权限模型**（opencode 的审批/规则集不能把工具全 deny，也不能让 `delegate` 绕过 my-agent 审批）。

§2 回答 1，§4/§5 回答 2、3。

---

## 2. opencode 侧扩展机制（已核实）

### 2.1 MCP：支持 local（stdio）与 remote（HTTP）

来自本机 `~/.config/opencode/opencode.json` 声明的 `$schema = https://opencode.ai/config.json`，该 schema 顶层含 `mcp`：

```jsonc
"mcp": {
  "timeout": { "startup": …, "catalog": …, "execution": … },
  "servers": {
    "<name>": { /* Mcp.LocalConfigEncoded | Mcp.RemoteConfigEncoded */ }
  }
}
```

- **local**：`{ "type": "local", "command": ["npx", "-y", "…"], "cwd"?, "environment"?, "timeout"?, "protocol"? }`
- **remote**：`{ "type": "remote", "url": "https://…", "headers"?, "oauth"?, "timeout"?, "protocol"? }`

官方文档 `https://opencode.ai/docs/mcp-servers/` 印证：

> “You can add external tools to OpenCode using the Model Context Protocol, or MCP. OpenCode supports both local and remote servers. Once added, MCP tools are automatically available to the LLM alongside built-in tools.”

并以 `type:"local"/"remote"`、`command`、`url`、`headers` 给出示例；远程还自动处理 OAuth。MCP 工具带 **server 名前缀注册**（文档原文：“MCP server tools are registered with server name as prefix”）。

### 2.2 自定义工具 / 插件：两条额外通道

- **Custom Tools**（`https://opencode.ai/docs/custom-tools/`）：放进 `<project>/.opencode/tools/*.ts` 或 `~/.config/opencode/tools/*.ts`，文件名即成工具名；用 `tool({ description, args, async execute(args, context) })` 定义，可执行任意代码（含 `fetch`）。
- **Plugins**（`https://opencode.ai/docs/plugins/`）：`.opencode/plugins/*.ts` 或 `~/.config/opencode/plugins/*.ts` 自动加载，或在配置 `plugin: [...]` 里声明 npm 包。插件返回的 hooks 里可 `tool: { mytool: tool({...}) }` **动态注册自定义工具**，并可订阅 `permission.asked`、`session.*`、`tool.execute.before/after` 等事件。

两条通道都能让 opencode 发起自定义工具调用，但**它们跑在 opencode 的 bun 进程里**，仍需 §4 的回调桥才能触达 `Team`。

### 2.3 权限模型（关键约束）

`https://opencode.ai/docs/permissions/`：权限按**工具名**索引（`read`/`edit`/`glob`/`grep`/`bash`/`task`/`skill`/`webfetch`/`websearch`/`external_directory`/`doom_loop`…），last-match-wins，动作 `allow|ask|deny`。agent 级 `permissions` 与全局合并，且 agent 优先。

本仓库后端用的是**新版 ruleset 数组**（`agents[].permissions` = `[{action, resource, effect}]`，schema 里的 `Permission.Ruleset`），并以一个 **总 deny 基线** 起底：

```
src/rob/opencode-backend.ts:98-100
  [{ action: "*", resource: "*", effect: "deny" }, …allow/ask…]
```

因此：**任何 MCP 工具都默认落在 `*` deny 之下，必须显式追加 allow，否则模型看得到、调不动。**

### 2.4 二进制与版本证据

本机 `opencode` 2.0.24（`~/.opencode/bin/opencode`）内嵌字符串统计到：
`tools/list` ×56、`notifications/initialized` ×15、`Mcp-Session-Id` ×2、`text/event-stream` ×17、`application/json` ×147 —— 说明其 MCP 客户端实现了 **initialize 握手 + tools/list + Streamable HTTP 会话头/SSE**，即 §5 的 remote 方案所需协议面齐备。

---

## 3. 我方现有接入点（`src/rob/opencode-backend.ts`）

| 关注点 | 现状 | 位置 |
|---|---|---|
| 启动 opencode | `opencode serve --port 0 --hostname 127.0.0.1` | `:360-376` |
| 注入配置 | `OPENCODE_CONFIG_CONTENT` = `{ agents: { "myagent-<rob>": { description, mode:"primary", system, permissions } } }`，**目前只有 agents，无 mcp/plugin/tools** | `:215-224` |
| 环境隔离 | 设 `XDG_DATA_HOME`/`XDG_STATE_HOME` 到私有目录；**未**设 `XDG_CONFIG_HOME` | `:367-373` |
| 事件流 | SSE `GET /api/event`，`handleEvent` 处理 `permission.asked` 与 `session.*` | `:458-576` |
| 权限桥 | `permission.asked` → `permissionToolFor` 映射回本侧工具 → rob authorizer → `POST /api/session/{id}/permission/{id}/reply` | `:288-343`, `:867-897` |
| 工具名映射 | `TOOL_PERMISSION_ACTIONS`（6 个内置工具）、`OPENCODE_TOOL_NAMES`、`mapToolName` | `:34-58`, `:863-865` |
| 会话/回合 | `ensureSession` / prompt / 中途 steer（`drain()` 轮询） | `:703-733`, `:804-810` |
| 生命周期 | `dispose()` 关 SSE、拒绝待决权限、SIGTERM 子进程 | `:815-836` |

**从未向 opencode 注册团队工具**，与组长描述一致。原生后端则是在 `src/rob/backend.ts:86-99` 直接把四个工具交给 `runAgent`；`Rob` 构造器只为原生后端传 `team` / `readMessages` / `runSubagent`（`src/rob/rob.ts:155-174`）。opencode 分支（`:124-136`）目前只传 `rules`/`authorize`/`drain`/`extraEnv`。

另外注意：`src/rob/types.ts:45-52` 的 `CLI_UNSUPPORTED_TOOLS` 把 `send_message`/`delegate`/`remember`/`forget` 列为 CLI 后端配置禁区（README:539 同步声明 cli rob 不能发私聊）。本方案落地时需要同步调整该白名单/文档。

---

## 4. 可行性判定与卡点

**判定：可行（推荐 remote MCP）。** 三个卡点及其解法：

| 卡点 | 说明 | 解法 |
|---|---|---|
| C1 发现工具 | opencode 默认不知道团队工具 | 配置 `mcp.servers.<name> = { type:"remote", url:"http://127.0.0.1:<port>", headers:{Authorization:"Bearer <token>"} }` |
| C2 跨进程回调 | opencode 子进程无法直接拿 `Team` 引用 | MCP server **就跑在 my-agent 进程内**（`createOpencodeBackend` 里 `node:http` 起回环端口），工具处理器直接调 `Team`，无第二跳 |
| C3 权限模型 | 总 deny 基线会挡住所有 MCP 工具；`delegate` 需保留 ask | 给四个工具动作追加 allow/`delegate` 走 my-agent 自身 authorizer（见 §5.4） |

**「不可行」的情形是否成立？不成立**：opencode 既非「无此 API」（有 MCP + 插件 + 自定义工具），也非「只读返回值」（MCP `tools/call` 是双向 RPC，可带副作用），权限模型也只影响规则翻译而非阻断。唯一需要实测确认的是 **MCP 工具在 ruleset 里的确切 `action` 名**（见 §6）。

---

## 5. 最小方案（推荐：backend 自持回环 MCP server）

### 5.1 谁持有 DM 游标与 Team 引用

**保持不变，全部留在 my-agent 进程：**

- `Team` 实例：`src/rob/team.ts` 的 `Team`（`TeamPort`，`src/rob/types.ts:170-183`）。
- DM 游标：`Rob.dmCursor`（`src/rob/rob.ts:105`），由 `Rob.readMessages()`（`:409-413`）推进；「自上次读取以来」的语义已在原生后端验证。
- 子 agent：`Rob.runSubagent()`（`src/rob/rob.ts` 内既有实现）。

### 5.2 回调如何回到 `Team.postDm`

```
opencode serve (子进程)
  └─ 模型发起 mcp 工具调用  ──HTTP POST JSON-RPC──▶  127.0.0.1:<random>/mcp
                                                      （node:http server，活在 my-agent 进程内）
                                                        └─ tools/call 处理器
                                                             ├─ send_message → team.postDm(from, to, text)
                                                             ├─ read_messages → readMessages()
                                                             ├─ list_robs    → team.roster()
                                                             └─ delegate     → authorize(...) → runSubagent(...)
```

只有 **一次回环 HTTP**；`Team`/游标语义完全在进程内，不需要 IPC 复制、不需要改 fastify。

### 5.3 涉及改动（最小集）

1. **`createOpencodeBackend` 增参**（`src/rob/opencode-backend.ts:160-178`）：
   ```ts
   team: TeamPort;
   readMessages: () => DmEntry[];
   runSubagent: (task: string, signal?: AbortSignal) => Promise<string>;
   ```
   并在 `src/rob/rob.ts:127-136` 的 opencode 分支传入 `team: options.team`、`readMessages: () => this.readMessages()`、`runSubagent: (t, s) => this.runSubagent(t, s)`（与原生分支 `:159-164` 一致）。

2. **起回环 MCP server**：在 backend 内用 `node:http` `listen(0, "127.0.0.1")`，随机 `randomBytes` bearer token（复用 `randomPassword()`）。实现 MCP JSON-RPC 方法：
   - `initialize` → `{ protocolVersion, capabilities:{ tools:{} }, serverInfo:{ name:"my-agent-team", version } }`
   - `notifications/initialized` → 204/空
   - `tools/list` → 四个工具的 `name/description/inputSchema`（直接复用 `src/rob/tools.ts` 的 zod schema 转 JSON Schema，或手写等价的 `inputSchema`）
   - `tools/call` → 分发到 §5.2 的处理器，返回 `{ content: [{ type:"text", text }] , isError? }`
   仅接受 `Authorization: Bearer <token>`，其余一律 401。

3. **注册进配置**（改 `src/rob/opencode-backend.ts:215-224`，在构建 `configContent` 前先 `await startMcpServer()` 拿端口/token）：
   ```jsonc
   {
     "agents": { "myagent-<rob>": { …, "permissions": [...] } },
     "mcp": {
       "servers": {
         "myagent": {
           "type": "remote",
           "url": "http://127.0.0.1:<port>/mcp",
           "headers": { "Authorization": "Bearer <token>" }
         }
       }
     }
   }
   ```

4. **`dispose()`**（`:815-836`）里 `server.close()`，释放端口。

5. **工具名映射**：`OPENCODE_TOOL_NAMES`（`:44-49`）追加 `myagent_send_message→send_message` 等，纯展示用（事件流卡片名字）。

### 5.4 权限（C3）细化

基线是 `{action:"*",resource:"*",effect:"deny"}`，需按 rob 规则追加：

- `send_message` / `read_messages` / `list_robs` 映射自 `robToolRules()`（`src/rob/tools.ts:14-23`）均为 `allow` → 追加 `{action:"<mcp工具的action名>", resource:"*", effect:"allow"}`。
- **`delegate` 保留 ask 语义**。两条路：
  - **推荐**：opencode 侧给该 MCP 工具动作 `allow`（让 opencode 不拦），由 **MCP 处理器内部**调用 `options.authorize({id, name:"delegate", args:{task}}, delegateTool)`，复用既有审批队列与 `waiting_approval` 状态；拒绝则返回 `isError:true`。这样 `delegate` 的审批行为与原生后端一致。
  - 备选：opencode 侧给 `ask`，但需扩展 `ACTION_TOOLS`/`permissionToolFor`（`:53-58`,`:867-897`）以识别 MCP 动作名，否则现有桥会以「无法映射」直接 reject。

- 若 MCP 工具动作名与内置动作同名冲突（如 `send_message` 与某内置名），用 server 前缀 `myagent_*` 规避。

### 5.5 系统提示与工具描述

MCP 工具描述会被 opencode 自动提供给模型（§2.1），因此模型能发现工具；但 `system` 目前只注入 `options.role`（`:221`），**不含** `renderCollaboration` 的协作提示（原生后端在 `src/rob/rob.ts:415-423` 注入）。建议在 `system` 后追加同样的协作段（含 roster），提升工具使用可靠性。

---

## 6. 备选方案与对比

| 方案 | 跨进程方式 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. remote MCP（推荐）** | opencode → 回环 HTTP → my-agent 进程内 | 一次 HTTP、无文件落盘、复用 `Team`、TUI/serve 通用 | 需实现 MCP JSON-RPC + Streamable HTTP 握手 | **首选** |
| B. local stdio MCP + 桥 | opencode 起桥子进程 → 仍需回环 socket 回 my-agent | MCP stdio 帧简单（可镜像 `src/mcp/client.ts`） | 多一个子进程 + 第二条回环通道，改动更大 | 次选 |
| C. 插件 / `.opencode/tools` | opencode bun 进程内工具 → 回环 HTTP | 无需实现 MCP，`tool()` API 直观 | 需把文件写进项目 `.opencode/` 或 `XDG_CONFIG_HOME`（当前未隔离配置目录，会污染用户目录），或用 `plugin` npm 包（启动要 bun install） | 不推荐 |

A 与 B/C 的**共同必要条件**都是「工具调用能回到 my-agent 进程」；A 把这一点做得最省。

---

## 7. 风险与待实测清单

1. **MCP 工具在 `Permission.Ruleset` 里的确切 `action` 名**（§5.4）——最需要实测：起一次真实的 opencode，注册一个只读 MCP server，观察 `permission.asked` 的 `action` 字段值。若 MCP 工具走独立动作名，则按 §5.4 追加即可；若共用某动作，需相应调整。
2. **Streamable HTTP 应答形态**：opencode 是否接受「单个 `application/json` JSON-RPC 响应」而非必须 `text/event-stream`。二进制含两者，风险低；实现时优先回 JSON，必要时补 SSE。
3. **`Mcp-Session-Id` 会话头**：远程传输可能要求服务端在 initialize 响应里回 `Mcp-Session-Id` 并在后续请求校验。实现时按需回该头。
4. **配置字段名**：schema 新版 `mcp.servers.<name>` 用 `disabled`（缺省即启用）；旧文档用 `enabled`。建议用 `servers` 形式 + `type/url/headers`，兼容两端。
5. **`CLI_UNSUPPORTED_TOOLS` 与 README**：`src/rob/types.ts:45-52` 及 README:539 的「cli rob 不能发私聊」需随实现更新，否则配置校验会挡住 `send_message`/`delegate`。
6. **MCP 工具名前缀**（`myagent_send_message`）需进入事件流的 `mapToolName`，否则 UI 卡片名难看。
7. **安全**：回环端口仅绑 `127.0.0.1`、每 backend 随机 bearer、随 `dispose` 关闭；不要暴露到 0.0.0.0。

---

## 8. 附录：证据索引

**代码（本仓库）**
- `src/rob/opencode-backend.ts:34-58` 工具↔动作/名字映射；`:98-100` 总 deny 基线；`:160-178` 选项；`:215-224` `agents` 配置注入；`:288-343` 权限桥；`:360-376` spawn/env；`:458-576` SSE 事件；`:703-733` 会话/steer；`:815-836` dispose；`:867-897` 动作→工具映射。
- `src/rob/rob.ts:105,409-413` DM 游标与 `readMessages`；`:124-175` 后端构造（opencode vs native）；`:415-423` 协作系统提示。
- `src/rob/backend.ts:35-99` `NativeBackendOptions` 与四个团队工具的注册方式。
- `src/rob/tools.ts:6-23` 工具 schema/描述与 `robToolRules`；`:32-165` 四个工具实现。
- `src/rob/types.ts:45-52` `CLI_UNSUPPORTED_TOOLS`；`:170-183` `TeamPort`。
- `src/mcp/client.ts` / `src/mcp/manager.ts` 现有 MCP **客户端**（仅 stdio，可作 stdio 方案的帧参考；本仓库目前**没有** MCP server）。
- `src/serve/server.ts` fastify 路由面（无 MCP 端点，本方案也无需新增）。
- `test/rob/opencode-backend.test.ts:525-540,576-580` 锁定 `OPENCODE_CONFIG_CONTENT` 只含 `agents`（改动影响面）。

**opencode 官方**
- config schema：`https://opencode.ai/config.json`（`mcp.servers`、`plugins`、`agents`、`Permission.Ruleset`、`Mcp.Local/RemoteConfigEncoded`）。
- `https://opencode.ai/docs/mcp-servers/`（local/remote、前缀注册、自动提供给 LLM）。
- `https://opencode.ai/docs/plugins/`（插件 hooks，含 `tool:{}` 注册自定义工具）。
- `https://opencode.ai/docs/custom-tools/`（`.opencode/tools/*.ts`、`tool()` API）。
- `https://opencode.ai/docs/permissions/`（按工具名、last-match-wins、`allow/ask/deny`、agent 级覆盖）。

**本机二进制**
- `~/.opencode/bin/opencode`（2.0.24）字符串：`tools/list`、`notifications/initialized`、`Mcp-Session-Id`、`text/event-stream`、`application/json`。
