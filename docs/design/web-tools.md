# 设计：Host 侧 Web 工具（web_fetch / web_search）挂载与权限

> 作者：rob "architect" ｜ 状态：定稿，可直接实现 ｜ 收敛自 `docs/research/host-side-web-tools-design.md`
>
> 目标：让 native / pi / opencode / claude 四个后端下的 rob 都能用 `web_fetch` + `web_search`，
> 且执行统一落在**拥有网络出口的 host 进程**内（各 rob agent 进程在独立 netns，只有 host 有出口）。
>
> 已落地：`src/tools/web.ts`（`webTools()` @ `:223`、`netEgressProbe()` @ `:172`）、
> `src/rob/tools.ts:117` 已 `export function buildTeamTool`。
> 本文档补齐 dev 报的**设计缺口**：挂载点、旧文件版工具去留、权限对齐。

---

## 0. 结论速览（TL;DR）

| 决策 | 内容 |
|---|---|
| **挂载点** | 在 `src/rob/team.ts` 的 `createBridge()` 里，把 `...webTools()` 加进 `const tools` 的两个分支（`:785-794`）。这是**唯一一处**被四个后端共同消费的工具列表。 |
| **旧文件版** | `src/tools/web_fetch.ts` / `web_search.ts` **保留**在 `registry.ts`，继续给**单 agent 场景**（`cli run` / `tui` / `serve solo`）用；它们**不再代表 team 场景**。 |
| **同名冲突** | native team 轮次会同时拿到 registry 版与 bridge 版两名 `web_fetch/web_search`。用 `agent.ts` 的「extraTools 同名覆盖内置」规则消解（D3）。 |
| **claude 内置** | 从 `CLAUDE_TOOLS` 移除 `web_fetch→WebFetch` / `web_search→WebSearch`（D4），claude 走 MCP host 工具。 |
| **权限** | `rules.ts` 的 `toolSubject` 两个 case **已存在**（`:103-106`），无需改；DEFAULTS 两个 `"ask"` 已存在（`:26-27`）。 |
| **GatewayReason** | **不需要**新增 `failed`（D6）。my-agent.json 是本地/untracked，不由 dev 提交。 |
| **未闭合边界** | host 出口预检失败时的降级、prompt-injection 包裹、search provider 语义（§4）。 |

---

## 1. 挂载点：为什么是 `createBridge()`

### 1.1 唯一事实来源

`src/rob/team.ts` 私有方法 `createBridge()`（`:774`）组装每轮唯一的工具列表：

```ts
// src/rob/team.ts:785-794（现状）
const tools =
  room === undefined
    ? teamTools(operations)
    : [
        ...teamTools(operations),
        ...roomTools({ room, reply: (t) => this.replyToRoom(room, session.rob, t) }),
      ];
```

> 注：`docs/research/host-side-web-tools-design.md` §4 写的「`team.ts:444`」锚点已过期——
> 那行现在是 `setWake`。正确锚点是 **`createBridge` @ `:774`，工具数组 @ `:785`**。

### 1.2 四个后端都吃 `bridge.tools`

| 后端 | 挂载处（读 `turn.bridge.tools`） | 落到子进程的方式 |
|---|---|---|
| native | `src/rob/backend.ts:87` `extraTools: [...turn.bridge.tools, ...]` | 直接进本进程的 agent loop（`agent.ts:128`） |
| pi | `src/rob/cli-backend.ts:99` `defs = turn.bridge.tools.map(toolDefinition)` | 写进 `piBridgeExtension`，`pi.registerTool` |
| opencode | `src/rob/opencode-backend.ts:372` 同上 `defs` | `teamMcpShim` 暴露为 MCP 工具 |
| claude | `src/rob/claude-backend.ts:118` 同上 `defs` | `teamMcpShim` → `--mcp-config` |

执行路径统一：子进程 `callTeamTool` → gateway UNIX socket（`gateway/wire.ts`）→
`src/rob/team.ts:809 invoke()` → `host.authorize`（`:836`）→ `tool.run(args, ctx)`（`:844`，**在 host 进程内跑 fetch**）。
gateway 的放行校验 `src/rob/gateway/server.ts:75` 按 `bridge.tools` 的名字比对，挂上即天然放行。

**结论**：在 `createBridge` 一处加 `...webTools()`，四个后端同时获得；不需要改任何 `*-backend.ts` 的挂载代码。

### 1.3 改动（D1）

```ts
// src/rob/team.ts 顶部
import { webTools } from "../tools/web.js";

// :785 两个分支都加
const tools =
  room === undefined
    ? [...teamTools(operations), ...webTools()]
    : [
        ...teamTools(operations),
        ...roomTools({ room, reply: (t) => this.replyToRoom(room, session.rob, t) }),
        ...webTools(),
      ];
```

---

## 2. 旧文件版工具的去留（D2）

`src/tools/registry.ts:14-24` 仍注册 `webFetchTool` / `webSearchTool`，它们：

- 支持 `search` 配置块里的 provider（brave / tavily / searxng，带 API key）与 `format`/`timeout_ms` 参数；
- 服务于**单 agent 场景**：`cli run`（`src/cli/run.ts`）、`tui`、`serve solo`——这些进程本身就在 host netns，有出口，不需要 host 桥。

因此**保留**，不删、不并入 `web.ts`：两套工具服务的上下文不同（单 agent vs team 桥），且旧版带密钥/多 provider 能力，删了会回归。
**但它们不再是 team 场景的实现**——team 轮次由 bridge 的 host 版接管（§1）。

> 若后续要彻底合一，需把 `search` provider 解析（`config/resolve.ts` 的 `SearchSettings`）下沉到 `webTools()`，
> 这会引入 host 工具持有密钥的问题，**明确不在本次范围**。

---

## 3. 同名冲突消解（D3）与 claude 内置（D4）

### 3.1 native 轮次的双份定义（必须修）

`src/agent/agent.ts` 现状：

```ts
const definitions = [...toolDefinitions(), ...extraTools.map(toolDefinition)];   // :128
function lookupTool(name) { return getTool(name) ?? extraTools.find(...); }      // :130
```

`toolDefinitions()` 含 registry 的 `web_fetch/web_search`；team 轮次 `extraTools` 又含 bridge 的同名工具。
→ 发给 provider 的 `tools` 数组出现**重名**（provider 侧易报错/行为未定义），且 `lookupTool` 优先命中 **registry 版**，
host 版永远不会被执行。

**修法（通用、最小）**：让 `extraTools` 按名字**覆盖**内置工具：

```ts
const extraTools = options.extraTools ?? [];
const shadowed = new Set(extraTools.map((t) => t.name));
const definitions = [
  ...toolDefinitions().filter((d) => !shadowed.has(d.name)),
  ...extraTools.map(toolDefinition),
];
function lookupTool(name: string): Tool | undefined {
  return extraTools.find((t) => t.name === name) ?? getTool(name);
}
```

语义：**bridge 工具是轮次内权威**，与内置同名即覆盖。单 agent 场景 `extraTools` 为空，行为不变（registry 版照常）。
这条规则顺带修掉「任何桥接工具与内置重名」的同类隐患。

### 3.2 claude 内置同名工具（D4）

`src/rob/claude-backend.ts:35-44` 的 `CLAUDE_TOOLS` 把 `web_fetch→WebFetch`、`web_search→WebSearch`
映射成 **claude 子进程自带**的抓取工具。它们跑在 claude 进程内（无出口），且与 bridge 的 MCP host 工具功能重叠。

**改**：从 `CLAUDE_TOOLS` 删除这两行，使 `claudeToolAllowlist()`（`:84`）不再暴露 `WebFetch/WebSearch`；
claude team 轮次改用 MCP 的 `mcp__<team>__web_fetch / web_search`（host 执行）。
同步更新 `test/rob/claude-backend.test.ts`（现有 `:113` 断言「exposes web_search as claude's WebSearch」需改成断言其**不再**出现在 allowlist）。

- pi：`PI_TOOLS`（`cli-backend.ts:32-37`）本就没有 web 映射，无需改，bridge 版经 MCP 扩展提供。
- opencode：`TOOL_PERMISSION_ACTIONS`（`opencode-backend.ts:40-47`）本就没有 web 映射，无需改。

---

## 4. 权限与类型对齐（D5 / D6）

### 4.1 `src/permissions/rules.ts` —— 无需改动

- `toolSubject`（`:103-106`）**已含** `web_fetch → record.url`、`web_search → record.query`。✅（research §5.1(a) 已实现）
- `DEFAULTS`（`:26-27`）**已含** `web_fetch: "ask"`、`web_search: "ask"`。✅
- 语义提醒：`web_fetch` 现在是 `readOnly: false`（`web.ts:238`，因为 `saveTo` 会写盘），
  经 `authorize` 必过审批规则，默认 `ask` 是**期望行为**，不要为了「只读」把它改成 allow。

### 4.2 `my-agent.json` —— 不禁由 dev 提交

当前 `my-agent.json` 是 **untracked 本地配置**，其中 `web_fetch`/`web_search` 已有 `"*"` allow 兜底。
本次**不改、不提交**它（提交会污染仓库/评审 diff）。真要在仓库内固化默认，应走单独的 config 变更，不在本设计内。

> 若将来提交，注意 pattern 是全锚定 glob：必须带前导 `*`（`"*jina.ai/*"` 而非 `"r.jina.ai/*"`），
> 且数组**顺序即优先级**，具体 allow 必须排在 `"*"` 之前（见 `matchesPattern` `rules.ts:50`）。

### 4.3 `GatewayReason` —— 不需要加 `failed`（更正 research §7）

- `web.ts` 的 `failure()` 返回 `reason: "failed"`（`:215`）；`team.ts:851` 的 catch 也返回 `"failed"`。
- `GatewayReason`（`src/rob/gateway/wire.ts:19-29`）**已经** union 了 `DelegateReason`，而
  `DelegateReason`（`src/rob/types.ts:163`）含 `"failed"`。→ 类型已闭合，**无需改动**。
  （`docs/research/host-side-web-tools-design.md` §7 那条风险已过时。）

---

## 5. 未闭合边界（明确写出，避免以后返工）

### B1 host 出口预检失败时的降级
- 现状：`assertEgress`（`web.ts:196`）按每次 `webTools()` 实例做**懒预检**；预检失败即 `throw`，
  `serve` 捕获后返回 `{ ok:false, reason:"failed", text:"host has no network egress: ..." }`。
  失败的预检**不缓存**（`:207` 清 `cache.promise`），下次调用重试——避免一次抖动把工具永久卡死。
- 决策：**不做启动期阻塞预检**（会拖慢 team start）；只在第一次真正调用时探测，失败返回可读错误。
- 待办（可选、非本次）：把 `netEgressProbe()` 结果暴露到 `config` 命令/启动 notice，方便排障。

### B2 prompt injection 包裹策略
- 现状：外部正文前拼 `EXTERNAL_NOTE`（`web.ts:14-15`），截断至 `FETCH_MAX_CHARS`；`saveTo` 经
  `resolveInWorkspace` + `withFileLock`（`:245-249`）限制在 workspace 内。
- 边界声明：**该包裹只是「告知模型把外部文本当数据」的软约束，不是强隔离**。抓来的页面仍可能诱导模型行事。
- 护栏：`web_fetch` 非只读（写盘受控）、`web_search` 只返回标题/链接/摘要、输出截断。
  **不实现**「抓取内容里的指令自动执行」这类路径；qa/review 不得把 `EXTERNAL_NOTE` 当作安全控制来验收。

### B3 search provider 语义差异 —— 已由 pm 确认「保持」
- bridge 版 `web_search` 只用 `$SEARXNG_URL`（默认 `http://localhost:8080`）+ DDG 回退；
  **不读** `search.provider`（brave/tavily/密钥）。单 agent（`cli run` / `tui` / `serve solo`）
  继续走 `search.provider`（brave/tavily/searxng）与 `apiKeyEnv`。
- **决策（pm 拍板）**：保持现状，不把 `SearchSettings` 下沉到 host 工具。
  理由：①需求侧无「team 必须用 brave/tavily」诉求；②下沉会把 **API key 带进 host 进程**（host 是共享出口，
  rob 子进程各自在独立 netns），属安全边界扩张，须单独评审，不该顺手做；③旧 registry 版已覆盖 brave/tavily，
  不构成能力回归。若将来用户要求 team 支持多 provider，另起一次「host 持密钥」变更评估。
- **已知能力差异（显式声明，勿当 bug 报）**：`DEFAULT_SEARCH.provider = "brave"`（`src/config/resolve.ts:97-100`）
  这个默认值在 **team 场景被绕开**——host 版不看它，改用 `$SEARXNG_URL`/DDG。
  即「team 默认搜索后端 = searxng/DDG」而非 brave，这是设计选择，不是缺陷。
- 对应 AC-W1 / AC-W2 / AC-W3，见 §7。

### B4 超时/缓存
- 单请求 `TIMEOUT_MS = 20_000`（`web.ts:9`），无结果缓存。若后续要控成本，另开设计。

---

## 6. 任务拆分（交 dev，按此顺序小步提交）

1. **挂载**：`src/rob/team.ts` import `webTools`，`createBridge` 两个分支加 `...webTools()`。（D1）
2. **消解重名**：`src/agent/agent.ts` extraTools 同名覆盖内置（definitions 去重 + lookup 优先 extraTools）。（D3）
3. **claude 内置下线**：`claude-backend.ts` 删 `CLAUDE_TOOLS` 两条 web 映射，改 `test/rob/claude-backend.test.ts`。（D4）
4. **测试**（qa 可按 §7 补）：
   - bridge 级：某 rob 的 `bridge.tools` 含 `web_fetch/web_search`（对齐 `test/rob/cli-backend-team-tools-gap.test.ts` 写法）。
   - native：`definitions` 中 `web_fetch` 只出现一次，且 lookup 命中 bridge 版（host 版）。
   - 单 agent：registry 仍暴露 `web_fetch/web_search`（`test/tools/web_*.test.ts` 保持绿）。
5. **不动**：`rules.ts`、`my-agent.json`、`GatewayReason`。

---

## 7. 验收挂钩（供 qa / review）

- AC-1：四后端 rob 在 team 轮次的工具列表都含 `web_fetch`/`web_search`（挂载点断言）。
- AC-2：native 轮次不存在重名工具；`web_fetch` 实际走 `src/tools/web.ts` 的 host 版（可用注入 `fetchImpl` 的用例证明）。
- AC-3：单 agent（`cli run`/`tui`/`solo`）行为不变，registry 版 web 工具及其 provider 测试仍绿。
- AC-4：`web_fetch` 为 `readOnly:false` 且默认 `ask`；`saveTo` 越界路径被 `resolveInWorkspace` 拒绝。
- AC-5：host 无出口时，`web_fetch/web_search` 返回 `ok:false` 且错误可读，不挂死；下一次调用会重试预检。

### 7.1 search provider 专项（pm 确认口径）

- **AC-W1（team）**：`web_search` 在 team 轮次只读 `$SEARXNG_URL`（默认 `http://localhost:8080`）；
  未配置或不可用时回退 DuckDuckGo HTML；host 进程**不解析/不持有** brave/tavily key
  （断言 `SearchSettings.provider` 不参与 host 工具路径——可用注入 `fetchImpl` + 不给 `BRAVE_API_KEY`/`TAVILY_API_KEY` 的用例证明）。
- **AC-W2（单 agent，回归保护）**：`cli run` / `tui` / `serve solo` 的 `web_search` 仍按 `search.provider`
  （brave/tavily/searxng）与 `apiKeyEnv` 走原路径，行为不变。
- **AC-W3（可测）**：host 工具路径下 searxng 未配置/失败时，不应因缺 brave/tavily key 报错，
  只走 DDG 回退或给出明确失败原因。

- review 范围：仅上述 4 个源码文件 + 两个测试文件的 commit，`screenshots/**` 噪声不入 diff。

---

## 8. 落地与验证（2026-10-16，已推送）

**提交（origin/main `d596fcd..18022f5`，fast-forward 8 笔）**

| 提交 | 内容 |
|---|---|
| `85e3a94` | D1：`src/rob/team.ts` `createBridge` 两分支 `...webTools()`（+ `test/rob/cli-backend.test.ts` pi `--tools` 断言） |
| `d8ea86a` | D3：`src/agent/agent.ts` bridged tool 同名覆盖内置（`+ test/agent/agent.test.ts`） |
| `18022f5` | D4+去重：`src/rob/claude-backend.ts` 删 WebFetch/WebSearch；`agent.ts` extraTools first-wins 去重（+ `test/rob/claude-backend.test.ts`、`test/rob/team-bridge-web-tools.test.ts`、`test/tools/web-provider-scope.test.ts`） |

**评审**：review 正式复评**通过**（范围 3 源码 + 5 测试，无越界）；5 个检查点全过（去重闭合 / shadowing 语义 / D4 不削弱 claude 可用性 / readOnly 未动 / provider 边界 AC-W1·W3）。
第 4 个源码文件即 `src/tools/web.ts`（`e9d3af9`，已过）。

**验证**：`tsc --noEmit` 0 错；`biome check` 0 error；`vitest` 全量 157 文件 / 1368 用例绿（干净 HOME）；聚焦 6 文件 82/82。

**已知 / 非阻塞**
- `webTools()` 每轮实例化 → egress 每轮各探一次（≤20s），见 §5 B1。
- `readOnly` 保持 `false` + 默认 ask（review 拍板，不做 per-call 拆分）。
- 环境：本机 `~/.config/my-agent/credentials.json` 会让 2 例「缺 key」用例假失败，CI 须在干净 HOME 下跑全量。
