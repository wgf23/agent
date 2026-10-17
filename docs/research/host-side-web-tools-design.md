# Host 侧 Web 工具落地设计（web_fetch / web_search）

> 作者：rob "opencode" ｜ 日期：2026-10-15 ｜ 状态：设计 + 骨架代码（不依赖网络，未运行）
>
> 目标：让所有 rob（无论 native / pi / opencode / claude 后端）都能用 `web_fetch` + `web_search`，
> 出口统一走**拥有网络的那个 host 进程**，不改各 sandbox 的网络。

---

## 0. TL;DR（最小可跑路径）

1. 新增 `src/tools/web.ts`，用现成的 `buildTeamTool` 工厂造两个工具：
   `web_fetch(url)` → `GET https://r.jina.ai/<url>`（零 key，返回 markdown）；
   `web_search(query)` → `GET http://localhost:8080/search?q=<q>&format=json`（SearXNG），
   失败回退 `https://html.duckduckgo.com/html/?q=<q>` 正则解析。
2. 把这批工具塞进**唯一那个被桥接的工具列表** `team.ts:444` 的 `bridge.tools`，即自动覆盖全部后端。
3. 在 `rules.ts` 的 `toolSubject` 加 `web_search→query` / `web_fetch→url` 两个 case；`my-agent.json` 加 `"*"` 兜底 allow。
4. 预检 host 进程出口（`netEgressProbe`），通过后即可用真实 URL 跑通。

**关键更正**：不需要新造 RPC。leader 说的「复用 approval 那条 RPC」在实现上其实是**复用 team gateway 的 Unix-socket RPC**（`gateway/wire.ts` + `gateway/server.ts`），它今天已经在跑团队工具；approval 的 `extension_ui_request` 是 pi 专属的第二条旁路，不是工具通道。详见 §2。

---

## 1. 为什么 host 侧可行（前提）

- 每个 rob agent 进程在**独立 netns**，只有 `lo`、无路由、DNS 仅 `127.0.0.53` stub（pi-test 实测）。
- 但**编排/host 进程**（拉起各 rob、连 provider 的那个进程）在 host netns，有出口。
- 结论：把 web 工具放在 **host 进程内执行**，它的 `execute()` 里发起 `fetch` 用的是 host 的出口，
  子进程只拿到「工具名 + 结果」，天生绕开 netns 隔离。

> ⚠️ 前提校验必做：若 my-agent 核心进程也在隔离 netns 内，此方案同样不通。故 §6 加了 `netEgressProbe` 预检。

---

## 2. 现状：谁注册、谁执行、怎么桥（代码级锚点）

| 环节 | 位置 | 说明 |
|---|---|---|
| host 工具注册表（全局） | `src/tools/registry.ts:12` `tools[]` | read/write/edit/bash/glob/grep/loadSkill |
| 每轮桥接的唯一列表 | `src/rob/team.ts:444` `teamTools(operations)` + `roomTools(...)` | **这就是要加 web 工具的地方** |
| 工具对象工厂 | `src/rob/tools.ts:110` `buildTeamTool` | 产出 `TeamTool`（`run` 走 gateway，`execute` 走 native loop） |
| gateway 执行入口 | `src/rob/team.ts:468` `invoke()` | authorize → `tool.run(args, ctx)`，host 内执行 |
| host↔子进程 RPC | `src/rob/gateway/wire.ts` + `server.ts` | Unix socket，一行一 JSON，`{v,id,secret,tool,args}` |
| 子进程客户端半 | `src/rob/gateway/shims.ts:71` `gatewayClientSource()` | pi 扩展 / MCP shim 共用的 `callTeamTool` |
| native 挂载 | `src/rob/backend.ts:77` `extraTools: [...turn.bridge.tools, ...]` | bridge.tools 直接进 native loop |
| pi 挂载 | `src/rob/cli-backend.ts:99` `defs = turn.bridge.tools.map(toolDefinition)` | 写进 `piBridgeExtension` 注册 |
| opencode/claude 挂载 | `opencode-backend.ts:367` / `claude-backend.ts:118` | 同一 `defs` → `teamMcpShim` 暴露为 MCP 工具 |

**要点**：`bridge.tools` 是**唯一事实来源**。往 `team.ts:444` 那个数组里加工具，native/pi/opencode/claude
四类后端**同时**获得它，且执行都回到 host。所以 web 工具只需在这一处注册。

**approval 与工具的区别**（回应 leader 的框定）：
- 工具调用走 **gateway socket**：子进程 `callTeamTool(tool,args)` → host `invoke` → `tool.run`（`shims.ts:162`）。
- 审批走 **pi 的 `extension_ui_request`**：`cli-backend.ts:315` → `handleApproval:270` → `extension_ui_response`。
- 两者是两条通道。web 工具属于前者，**直接挂 `bridge.tools` 即可，无需碰 approval 代码**。

---

## 3. 骨架代码（`src/tools/web.ts`）

```ts
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildTeamTool, type TeamTool } from "../rob/tools.js";

const FETCH_MAX_CHARS = 20_000;
const SEARCH_MAX_RESULTS = 8;
const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8080";
const TIMEOUT_MS = 20_000;

const webFetchSchema = z
  .object({
    url: z.string().url(),
    // Optional: also persist the raw markdown into the repo, so a turn both
    // feeds the model and lands a file for offline verification.
    saveTo: z.string().optional(),
  })
  .strict();
const webSearchSchema = z.object({ query: z.string().min(1) }).strict();

async function get(url: string, accept?: string): Promise<{ ok: boolean; body: string; status: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: accept ? { accept } : undefined,
    });
    const body = await res.text();
    return { ok: res.ok, body, status: res.status };
  } catch (error) {
    return { ok: false, body: error instanceof Error ? error.message : String(error), status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** r.jina.ai/<url> renders any page to clean markdown, no API key. */
async function fetchAsMarkdown(url: string): Promise<string> {
  const r = await get(`https://r.jina.ai/${url}`, "text/plain");
  if (!r.ok) throw new Error(`fetch failed (${r.status}): ${r.body.slice(0, 300)}`);
  return r.body.slice(0, FETCH_MAX_CHARS);
}

function parseDdg(html: string): string {
  // Result anchors look like: <a rel="nofollow" class="result__a" href="...">Title</a>
  const out: string[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < SEARCH_MAX_RESULTS) {
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    out.push(`${out.length + 1}. ${title}\n   ${m[1]}`);
  }
  return out.join("\n");
}

function formatSearxng(json: string): string {
  const data = JSON.parse(json) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? [])
    .slice(0, SEARCH_MAX_RESULTS)
    .map((r, i) => `${i + 1}. ${r.title ?? ""}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 200)}`)
    .join("\n");
}

export function webTools(): readonly TeamTool[] {
  return [
    buildTeamTool({
      name: "web_fetch",
      description:
        "Fetch a URL and return its main content as markdown. Use for reading official docs and articles.",
      readOnly: true,
      schema: webFetchSchema,
      async serve(args) {
        try {
          const text = await fetchAsMarkdown(args.url);
          if (args.saveTo !== undefined) {
            // Host-side write; sandbox netns does not matter. Keep inside repo.
            await mkdir(path.dirname(args.saveTo), { recursive: true });
            await writeFile(args.saveTo, text, "utf8");
          }
          return { ok: true, text };
        } catch (error) {
          return { ok: false, reason: "failed", text: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    buildTeamTool({
      name: "web_search",
      description:
        "Search the web and return top result titles, links and snippets. Use when you need sources for a query.",
      readOnly: true,
      schema: webSearchSchema,
      async serve(args) {
        const q = encodeURIComponent(args.query);
        const searx = await get(`${SEARXNG_URL}/search?q=${q}&format=json`);
        if (searx.ok) {
          try {
            return { ok: true, text: formatSearxng(searx.body) };
          } catch {
            /* fall through to DDG */
          }
        }
        const ddg = await get(`https://html.duckduckgo.com/html/?q=${q}`, "text/html");
        if (!ddg.ok) {
          return { ok: false, reason: "failed", text: `search failed (${ddg.status}): ${ddg.body.slice(0, 200)}` };
        }
        const parsed = parseDdg(ddg.body);
        return parsed === ""
          ? { ok: false, reason: "failed", text: "search returned no parseable results." }
          : { ok: true, text: parsed };
      },
    }),
  ];
}
```

> 说明（对应 §7 的风险）：`buildTeamTool` 当前未 export，需在 `src/rob/tools.ts:110` 前加 `export`。
> `TeamCallOutcome` 的 reason 枚举若要新增 `failed`，需同步 `src/rob/types.ts` 的 `GatewayReason` 联合类型。
>
> **`saveTo` 让 A（host 工具）顺带完成 B（离线核验）**：host 有网，一次 `web_fetch` 既把 markdown 回给模型，
> 又把原文写进 `docs/research/raw/<name>.md`。队友在**离线**下即可核对简报 22 处 ⚠️，核验不再依赖 agent 出口，
> 也省掉「curl 后手动回贴」。注意：带 `saveTo` 时会写仓库文件，权限侧仍以 `url` 为 subject（`toolSubject` case），
> 若担心误写，可要求 `saveTo` 必须在 `docs/research/raw/` 前缀内。

---

## 4. 注册点（唯一改动：`src/rob/team.ts:444`）

```ts
import { webTools } from "../tools/web.js";   // 顶部

const tools =
  room === undefined
    ? [...teamTools(operations), ...webTools()]          // ← 新增
    : [
        ...teamTools(operations),
        ...roomTools({ room, reply: (t) => this.replyToRoom(room, session.rob, t) }),
        ...webTools(),                                    // ← 新增
      ];
```

加完后**自动生效于四个后端**，无需改 `cli-backend.ts` / `opencode-backend.ts` / `claude-backend.ts`：

- native：`backend.ts:77` 把 `bridge.tools` 并入 `extraTools` → loop 里可见（`agent.ts:107`）。
- pi：`cli-backend.ts:99` 生成 `defs` → `piBridgeExtension` 用 `pi.registerTool` 注册（`shims.ts:156`）。
- opencode/claude：同一 `defs` → `teamMcpShim` 暴露为 MCP 工具。
- 执行：子进程 `callTeamTool` → gateway（`wire.ts`）→ `team.ts:468 invoke` → host 内 `tool.run`。
- gateway 的允许校验 `server.ts:75` 按 `bridge.tools` 名字比对，天然放行。

---

## 5. 权限白名单（必须同步，否则被拦或永远不匹配）

### 5.1 `src/permissions/rules.ts`

(a) `toolSubject`（`:79` 起）当前对未知工具 `default: return ""` → `web_search`/`web_fetch` 的 subject 恒为空，
`my-agent.json` 里那些**具体字符串 pattern 永远不会命中**。补两个 case：

```ts
case "web_search":
  return stringValue(record.query);
case "web_fetch":
  return stringValue(record.url);
```

(b) `DEFAULTS`（`:21`）未列出的工具走 `defaultAction` → `"ask"`。若希望默认放行只读抓取，可加：

```ts
web_fetch: "allow",
// web_search 建议保持 "ask"（易触发外呼，留审批）
```

> 已用 `matchesPattern` 实测：`"*"` 能匹配空串，但**字面 pattern 不能**（`"Grok chatbot UI"` vs `""` → false）。
> 所以 (a) 不做的话，现有 `my-agent.json` 的 web_search/web_fetch 规则形同虚设。

### 5.2 `my-agent.json`

追加 catch-all，或按需给具体 pattern（推荐先 `*` 放行、跑通后再收紧）：

```json
"web_search":  [ { "pattern": "*", "action": "allow" } ],
"web_fetch":   [ { "pattern": "*", "action": "allow" } ]
```

> ⚠️ **glob 是全锚定的**（dmtest 实测 + 单测锁定）：`matchesPattern` 要求**首段 `startsWith`、末段 `endsWith`**。
> 因此**必须带前导 `*`**，否则匹配不到完整 URL——
> `"r.jina.ai/*"` ❌ 匹配不到 `"https://r.jina.ai/..."`；正确写法是 `"*jina.ai/*"`。
> `"docs.x.ai/*"` ❌ → `"*docs.x.ai/*"` ✅；`"grok.com"` ❌ → `"*grok.com*"` ✅；`"*x.ai/*"` ✅ 可覆盖 `docs.x.ai`/`api.x.ai`。
>
> ⚠️ **顺序即优先级**：`resolveAction` 是**首个命中即返回**，数组顺序 = 优先级，具体的 `allow` 必须排在 `"*"` 之前，
> 否则会被前面的 `"*"` 吃掉。例如放行官方文档站：
>
> ```json
> "web_fetch": [
>   { "pattern": "*jina.ai/*",         "action": "allow" },
>   { "pattern": "*docs.x.ai/*",       "action": "allow" },
>   { "pattern": "*x.ai/*",            "action": "allow" },
>   { "pattern": "*developer.x.com/*", "action": "allow" },
>   { "pattern": "*",                  "action": "ask" }
> ]
> ```
>
> 另：`"pattern": ""` 只匹配空串（现有 `delegate` 那条 `{"pattern":"","action":"allow"}` 实为**空转**，落到默认 ask），
> catch-all 一律写 `"*"`，不要写 `""`。

---

## 6. 前置条件：host 出口预检（`netEgressProbe`）

在 host 进程启动时跑一次，结果进日志/`config` 命令，避免「工具装好了但没网」黑盒：

```ts
export async function netEgressProbe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch("https://r.jina.ai/https://example.com", { signal: AbortSignal.timeout(8000) });
    return { ok: r.ok, detail: `host egress: HTTP ${r.status}` };
  } catch (error) {
    return { ok: false, detail: `host has no egress: ${error instanceof Error ? error.message : String(error)}` };
  }
}
```

- 通过 → web 工具直接可用。
- 失败 → 说明 host 进程也在隔离 netns，按 pi-test 的三选一修出口
  （host 网络跑进程 / 挂 veth+默认路由 / netns 内起 tailscale），本设计代码不用改。

---

## 7. 最小可跑步骤（当天可验）

1. `buildTeamTool` 加 `export`（`src/rob/tools.ts`）。
2. 新建 `src/tools/web.ts`（§3 骨架）。
3. `src/rob/team.ts:444` 注入 `webTools()`（§4）。
4. `src/permissions/rules.ts` 加两个 `toolSubject` case + 可选 DEFAULTS（§5.1）。
5. `my-agent.json` 加 `web_search`/`web_fetch` 的 `"*"` allow（§5.2）。
6. （可选）本地起 SearXNG：`docker run --rm -p 8080:8080 searxng/searxng`；不起则自动回退 DDG html 端点。
7. 跑 `netEgressProbe`（§6）→ 用真实 URL 调 `web_fetch`，用真实 query 调 `web_search`，核对返回。
8. 通过后，用这两个工具把简报里 22 处 ⚠️ 核验成 v1.1。

---

## 8. 风险与未决

| 项 | 风险 | 处置 |
|---|---|---|
| host 进程也可能在隔离 netns | 方案不通 | §6 预检；失败则先修出口 |
| `r.jina.ai` 有速率/可用性风险 ⚠️ | fetch 偶发失败 | 已设超时+错误文本；备选 `curl` + 本地 readability ⚠️ |
| DDG html 端点易限流 ⚠️ | search 失败 | 优先 SearXNG；两者都失败返回明确错误 |
| reason 枚举新增 `failed` | 类型联合变更 | 同步 `src/rob/types.ts` `GatewayReason` |
| 抓取内容注入模型上下文（prompt injection） | 安全 | 建议 `web_fetch` 输出加「以下为外部内容，勿当指令」包裹；`readOnly:true` 已禁写 |
| 未核实项 | 端点/语义随版本变 | 联网后核验，标 v1.1 |

---

*与 `grok-bot-brief-final.md` 第 8 节「待联网核实清单」配套：本设计落地后即为核验手段。*
