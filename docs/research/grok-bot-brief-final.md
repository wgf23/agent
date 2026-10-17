# Grok Bot 调研 · 合并简报（Final Draft）

> 汇总：rob "leader" ｜ 参与：aaa / pi-test / opencode / test ｜ 日期：2026-10-15
>
> **资料说明（重要）**：本次调研环境**无外网**（代理 `127.0.0.1:7890` 未监听、DNS 不通、web_search 不可用）。
> 以下内容 = 模型知识 + 本仓库已有资料（`docs/research/grok-*.md`）整理，**未做实时联网核实**。
> 凡涉及版本号、价格、上下文长度、入口/按钮命名的细节，均标 **⚠️**，需联网二次确认。

---

## 0. TL;DR

- Grok 的 "bot" 有三层含义：① xAI 官方聊天产品内的**多智能体协作者**；② X / Telegram 上的 **@grok 账号级机器人**；③ 开发者用 **xAI API** 自建的第三方 bot。
- **最大差异化 = 实时社交数据**：原生内建 **X(Twitter) 实时检索 + Live Search**，是四家里独有的数据源。
- **接入成本最低**：xAI API 与 **OpenAI 协议同构**，改 `base_url` + key + model 即可迁移。
- **短板**：生态覆盖弱（无原生音频、batch/缓存等缺）、API 无状态（记忆/会话/工具注册表需自建）、费率与限额偏激进 ⚠️。

---

## 1. 产品线与入口

| 形态 | 载体 | 说明 |
|---|---|---|
| Grok 助手 | grok.com 网页 / iOS / Android App | 消费级主入口 ⚠️ |
| X 内嵌 Grok | X App / 网页 Grok 标签页、`@grok` 回复 | 与时间线/帖子深度耦合，账号级 bot |
| Grok on Telegram | Telegram `@GrokAIbot` ⚠️ | 官方 IM 集成 |
| Grok 4 Heavy | 订阅档位（SuperGrok Heavy）⚠️ | 多 agent 并行协作 |
| xAI API | `https://api.x.ai/v1`（OpenAI 兼容） | 自建 bot / Agent / 编排 |

---

## 2. 模型版本与关键能力

- **版本线**：Grok-1 → 1.5 / 1.5V → 2 / 2 mini（+Flux）→ 3 / 3 mini（Think + DeepSearch）
  → **Grok 4 / 4 Heavy**（多 agent + 原生工具）→ **Grok 4 Fast**、**Grok Code Fast 1**。2026 新版未知 ⚠️。
  四类入口（grok.com / X 内嵌 / App / API）**共用同一 xAI 模型后端**。
- **上下文**：Grok 4 约 **256k**，Grok 4 Fast 号称 **2M**，Grok 3 曾称 1M ⚠️。
- **多模态**：文本 + 图像输入（视觉）、图像生成 **Grok Imagine**、语音模式；视频能力部分开放 ⚠️。
  **无原生音频输入** ⚠️。
- **联网 / DeepSearch**：多步检索 + 编号引用 + 图谱式可视化；**X Search** 检索 X 帖子；
  API 侧对应 **Live Search**（web / X），按来源计费 ⚠️。
- **工具 / Agent**：
  - API 提供 OpenAI 风格 `tools` / `tool_choice`（支持并行）、结构化输出 `response_format`（strict 语义待核实）⚠️；
  - 内建服务端工具：Web Search / X Search / 代码执行 ⚠️；
  - 已支持 **Remote MCP**（服务端连 MCP server）⚠️，自定义工具走 OpenAI 风格；
  - **Grok 4 Heavy** = star/ensemble 拓扑：同任务广播给 N 个 agent，agent 之间不直接对话，
    由上层做仲裁/择优 ⚠️。**Heavy 未经 API 暴露** ⚠️。
- **记忆**：跨会话 Memory，可查看 / 编辑 / 关闭 ⚠️；消费端另有 **Grok Studio（Canvas）**。
- **服务端工具名**（Agent Tools）⚠️：`web_search`、`x_search`、`code_execution`。

---

## 3. 商业化

- **订阅**：免费层；X Premium / Premium+ 含 Grok；**SuperGrok**（约 $30/月）、**SuperGrok Heavy**（约 $300/月）⚠️。
- **API 参考价（每百万 token）⚠️**：grok-4 ≈ $3 / $15；grok-4-fast ≈ $0.20 / $0.50；
  grok-3 ≈ $3 / $15；grok-3-mini ≈ $0.3 / $0.5。
- **Live Search** 按来源计费（约 $25 / 1k sources）⚠️。

---

## 4. bot 之间的交互模式

| 模式 | 发起方 | 拓扑 | 典型产品 |
|---|---|---|---|
| 并行协作 + 仲裁 | 系统 | star / ensemble | Grok 4 Heavy |
| 工具调用 | 主 agent | 主从 | Agent Tools |
| bot-to-bot 环路 | 开发者编排 | 环 / P2P | 自建（API） |
| 账号级回复 | 用户 / 其他账号 | 树（回复链） | X `@grok` |
| IM 命令 / 回复 | 用户 | 星形 | Telegram bot |

自建 bot-to-bot 环路风险：**无限对话 / 费用失控、上下文膨胀、环路死锁** →
必须设轮数上限、token 预算、超时与终止条件。

---

## 5. 开发者接入（xAI API）

- **Endpoint**：`https://api.x.ai/v1`，OpenAI 协议兼容；openai SDK 改 `base_url` 即可。
- **多模态**：文本 + 图像；图片生成走 `/images/generations` ⚠️。
- **速率限制**：按团队消费分级的 RPM / TPM，另有免费额度 ⚠️。
- **与 OpenAI**：迁移成本极低（改 base_url + key + model）；但 Responses API / 音频 / batch / 缓存覆盖较弱 ⚠️。
- **与 Claude**：Messages API 格式不同（`tool_use` / `tool_result` 块）→ 迁移中等，需适配层。

---

## 6. X / Twitter 场景下的用法与风控

**集成功能**：`@grok` 在「被回复帖子」的上下文里做总结 / 翻译 / 解释 / 生成回复（可配图）；
趋势（Trending）背景解读；账号近期立场概括（有限分析，不保证全历史）。实时性来自内建 X Search / live search。

**自建 bot 的关键架构事实**：**Grok API 与 X 发帖 API 完全分离**——
Grok 负责生成 / 分类，X API v2 负责读流、发帖、回复。典型链路：
X 过滤流 → Grok 生成/审核 → X API `POST /2/tweets` 回复。舆情监控 = X 搜索端点（Recent / Full-archive）+ Grok 聚类/情感。

**坑与风控**：
- **速率**：Grok API 按团队消费分级 RPM/TPM；X API 免费/Basic/Pro 读写配额差异极大，超限即 **429**。
- **封禁**：高频自动回复、重复/垃圾内容、批量关注点赞易触发 X **Automation Rules**，轻则限流重则封号。
- **合规**：自动化须透明、非欺骗、非垃圾；商用抓取需付费套餐 + 开发者协议，勿用未授权抓取绕开 API。

---

## 7. 竞品对比与选型

| 维度 | Grok | OpenAI | Anthropic | Gemini |
|---|---|---|---|---|
| 对话质量 | 一线，风格果断、长程一致性略弱 | 第一梯队，指令遵循稳 | 第一梯队，编码/长文最稳 | 百万上下文 + 多模态原生强 |
| 工具 / Agent | OpenAI 兼容，迁移低但生态薄 | 生态最成熟 | tool-use + MCP 事实标准 | 与 Vertex 打通 |
| 实时信息 | **内建 X 实时 + Live Search（独有）** | 联网 + connectors | 仅 web search，无社交数据 | Google Search Grounding，网页最强 |
| 成本 | 定价偏激进 | 分层（mini/nano ↔ 旗舰） | Sonnet 居中 / Opus 最贵 | Flash 最便宜、吞吐最高 |

**选 Grok 有优势的场景**：① 舆情 / 热点 bot；② 突发新闻 / 事件追踪；③ "带观点" 助手（人设辨识度高）；
④ 成本敏感 / 快速接入的自建 bot；⑤ X 平台内嵌账号级 bot。
反向：重编码 / 长程 agent → Claude；重生态编排 → OpenAI；超长上下文 + 低成本吞吐 → Gemini。

**一句话选型**：如果 bot 的价值来自**实时 + 社交/舆情数据**，选 Grok；否则按
生态编排 → OpenAI、代码与长上下文 agent → Claude、超长上下文与低成本高吞吐 → Gemini。

---

## 8. 待联网核实清单（TODO）

> **环境核实结论（多路一致，dmtest / test / pi-test / opencode）**：沙箱仅有 `lo`、`/proc/net/route` 为空、
> curl exit=7、DNS 解析失败、代理 7890 未监听；`src/tools/` 仅 7 个工具（bash / edit_file / glob / grep / read_file / write_file + registry），
> **无 web_search / web_fetch 实现**；`my-agent.json` 中相关 key 仅为 Permission 规则，非工具注册。故本次无法联网。
>
> **进展（2026-10-15）**：权限侧已修——`delegate` 空 pattern `""` → `"*"`（免批真正生效），
> `web_search` / `web_fetch` 已加 catch-all `"*"` 并补单测（规则 10 passed）。注意 `matchesPattern` 为
> 「首段 startsWith / 末段 endsWith」全锚定，URL 白名单须写 `"*jina.ai/*"` 而非 `"r.jina.ai/*"`。
> **待办**：host 侧实现 `web_fetch`(r.jina.ai) + `web_search`(SearXNG/DDG) 并接线（见 `host-side-web-tools-design.md`），
> 且需先确认 host 进程出口可达；出口一通即可把下列 ⚠️ 核验为 v1.1。

- [ ] 最新模型名 / 版本号 / 上下文长度（`docs.x.ai`、`x.ai/news`）
- [ ] 订阅档位与 API 价格、Live Search 计费（`x.ai/pricing`）
- [ ] MCP 的具体形态与支持范围、结构化输出 strict 语义
- [ ] 速率限制档位与免费额度
- [ ] Grok 4 Heavy 是否/何时开放 API

## 附一：官方来源（未核实）

`x.ai/news`、`docs.x.ai/docs/models`、`docs.x.ai/docs/pricing`、`docs.x.ai/docs/guides/live-search`、
`grok.com`、`console.x.ai`、`help.x.com/en/using-x/x-premium`、
`platform.openai.com/docs/pricing`、`docs.anthropic.com`、`ai.google.dev/gemini-api/docs/*`、`modelcontextprotocol.io`。

## 附二：相关文档

- `docs/research/grok-bot-report.md`（bot 形态盘点 + 页面交互逻辑）
- `docs/research/grok-official-capabilities.md`（官方产品线与能力总览）
- `docs/research/grok-dev-agent-capabilities.md`（开发者 / Agent 能力）
- `docs/research/grok-bot-competitor-selection.md`（竞品对比与选型）
- `docs/research/grok-x-twitter-bot-pi-test.md`（X/Twitter 场景用法与风控）
- `docs/research/grok-ui-design.md`、`docs/research/grok-vs-cli-agent-architecture.md`
