# Grok 开发者/Agent 能力调研（xAI API 视角）

> 作者：rob "opencode" ｜ 日期：2026-10-15 ｜ 方向：开发者 / Agent 能力
>
> **⚠️ 来源说明**：本机**无外网**（`curl docs.x.ai` 超时，`web_search` 无 key），
> 内容基于模型已有知识 + 仓库现有资料整理，凡未核实细节标 **⚠️**，联网后需二次确认。

官方文档入口：
- xAI 文档：https://docs.x.ai/ （API key / Models / Guides / Function calling）
- API base：https://api.x.ai/v1 （OpenAI 兼容）
- xAI 新闻 / 发布：https://x.ai/news

---

## 1. Grok 的 Agent 能力

- **Grok 4 / Grok 4 Heavy**：原生**工具调用**与**并行多智能体**（Heavy 为多 worker + 仲裁拓扑）⚠️。
  支持 `reasoning_effort` 推理强度参数。
- **grok-code-fast-1**（编码 agent 专用，256k 上下文）：为 agentic coding 设计——快速工具循环、
  兼容 OpenCode / Cursor / Cline 等 CLI，对应 `grok-code` 类工具 ⚠️。
- **DeepSearch / deeper-search**：agentic 检索模式，自动拆解问题、浏览网页、给来源引用 ⚠️。
- **Grok Studio**：分栏画布式编辑（代码/文档/预览），对标 Canvas / Artifacts ⚠️。
- **服务端 Agent 工具**：Web Search、X Search、代码执行等由 xAI 侧执行并回流 ⚠️。
- **MCP / 自定义工具**：xAI 已提供 **Remote MCP 工具**支持（服务端连接 MCP server）⚠️；
  客户端自定义工具走标准 OpenAI 风格 `tools` 定义。

## 2. xAI API 接入细节

- **Endpoint**：`https://api.x.ai/v1`，`/chat/completions`、`/models`、`/images/generations` 等，
  **OpenAI 协议兼容**（可直接用 openai SDK 改 `base_url`）。
- **工具调用**：OpenAI 风格 `tools` / `tool_choice`，支持并行函数调用；另有内建 `search_parameters`（live search）⚠️。
- **结构化输出**：支持 `response_format` / JSON schema（strict 程度需核实）⚠️。
- **多模态输入**：文本 + 图像（vision）；**无原生音频输入**；图片生成走 `/images/generations` ⚠️。
- **速率限制**：按团队消费分级的 RPM/TPM，另有免费额度（$150/月等）⚠️。

## 3. 与 OpenAI / Claude 的差异与迁移成本

| 维度 | xAI | OpenAI | Claude(Anthropic) |
|---|---|---|---|
| 协议 | **OpenAI 兼容** | 原生 | Messages API（格式不同） |
| 工具调用 | OpenAI 风格 | OpenAI 风格 | `tool_use`/`tool_result` 块 |
| SDK 迁移 | **极低**（改 base_url+key+model） | — | 中高（需适配层） |
| 结构化输出 | 支持 ⚠️ | 支持（strict） | 支持（tool 模拟） |
| 多模态 | 文本+图像 | 文本/图像/音频 | 文本/图像/PDF |
| Agent 生态 | 新兴，较轻 | Responses API/MCP 成熟 | MCP 成熟 |

**结论**：从 OpenAI 迁到 xAI **成本极低**（几乎零改动，OpenAI SDK 换 base_url 即可），
但 xAI 生态更薄（Responses API、音频、batching、缓存策略等覆盖较弱）⚠️；
从 Claude 迁移**成本中等**（需处理 Messages ↔ Chat Completions 差异）。

**待核实**：具体模型名/上下文长度、MCP 支持形态、结构化输出 strict 语义、限额档位。
