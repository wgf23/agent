# PRD：Web 工具（web_fetch / web_search）的 Provider 覆盖范围与验收标准

- 状态：confirmed（需求侧已拍板）
- 作者：pm（需求）
- 关联设计：`docs/design/web-tools.md` §5 B3、§7
- 关联源码：`src/tools/web.ts`（host 桥接版）、`src/tools/web_fetch.ts` / `web_search.ts`（registry 单 agent 版）、`src/rob/team.ts:createBridge`
- 作用域：这是对 P0 web 工具验收标准的**需求侧补充**，不改变已定稿的挂载/消解重名/权限设计。

## 1. 背景

同一功能名 `web_search` 在两套上下文里由两套实现提供，能力不同：

| 场景 | 实现 | 出口 | Provider 覆盖 |
| --- | --- | --- | --- |
| **team**（房间/群组，native/pi/opencode/claude） | `src/tools/web.ts`（host 桥接版） | host 进程（唯一有网络出口） | 仅 SearXNG + DuckDuckGo 回退 |
| **单 agent**（`cli run` / `tui` / `serve solo`） | `src/tools/registry.ts` 注册的旧文件版 | 自身进程（host netns） | brave / tavily / searxng（读 `search.provider` + `apiKeyEnv`） |

设计文档 §5 B3 把这一差异标为「需 pm 确认」的边界。本文即确认书。

## 2. 决定（需求侧拍板）

1. **保持现状，不下沉 provider。** team 场景的 `web_search` 只保证 **SearXNG（`$SEARXNG_URL`，默认 `http://localhost:8080`）+ DuckDuckGo HTML 回退**；host 进程**不解析、不持有** `search.provider` 的 brave/tavily API key。
2. **brave/tavily 的验收只针对单 agent 版。** 单 agent 场景继续按 `search.provider` 与 `apiKeyEnv` 走原路径，行为不变。
3. **本次不扩大范围。** 若将来要求 team 场景也支持 brave/tavily，必须单独立项，明确「密钥如何进入 host 进程」的安全方案（host 是共享出口，rob 子进程在独立 netns），重新评估后再做。
4. `DEFAULT_SEARCH.provider = "brave"` 在 team 场景被绕开，属**已知能力差异**，不是缺陷；qa/review 不得据此提 bug。

### 为什么不顺手做（记录理由，留痕）
- 未收到「team 必须用 brave/tavily」的需求，现默认即最小可用范围。
- 下沉会把 API key 带进 host 进程，扩大密钥暴露面，属安全边界扩张，需单独评审。

## 3. 验收标准（AC，provider 范围）

> 与 `docs/design/web-tools.md` §7 AC-1..AC-5 并存；本节只补 provider 维度。同步给 qa / review。

- **AC-P1（team，仅 SearXNG/DDG）**：team 轮次的 `web_search` 只读 `$SEARXNG_URL`（默认 `http://localhost:8080`）；未配置或不可用时回退 DuckDuckGo HTML 抓取。可用注入 `fetchImpl`/env 的用例证明请求打到 searxng 或 DDG，而非 brave/tavily 端点。
- **AC-P2（不持有密钥）**：team 场景的 host 工具路径不读取 `search.provider`、不读取 brave/tavily 的 `apiKeyEnv`；即断言缺少 brave/tavily key 时 team `web_search` 仍可正常返回（不回退失败）。
- **AC-P3（单 agent 回归保护）**：`cli run` / `tui` / `serve solo` 的 `web_search` 仍按配置的 `search.provider`（brave/tavily/searxng）与 `apiKeyEnv` 工作；既有 provider 测试保持绿。
- **AC-P4（差异显式化）**：设计/文档显式写明「team 绕开 `DEFAULT_SEARCH=brave`」为已知能力差异；不得被当作 P0 缺陷。
- **AC-P5（不误报）**：host 工具路径在未配置 searxng 且 DDG 回退也失败时，返回**可读的失败原因**，不因缺 brave/tavily key 报错。

## 4. 范围外

- team 场景接入 brave/tavily（含密钥进入 host 进程的方案）——需新的安全评估，不在本次。
- 修改 `SearchSettings` / `config/resolve.ts` 的解析逻辑。
- 启动期阻塞式出口预检（见设计 §5 B1）。
- prompt injection 强隔离（见设计 §5 B2；`EXTERNAL_NOTE` 为软约束，不得当安全控制验收）。
