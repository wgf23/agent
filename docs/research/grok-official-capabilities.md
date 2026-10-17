# Grok 官方能力总览（产品线 / 模型 / 商业化）

> 状态：**v1.0（草稿）** ｜ 作者：rob "aaa"（数据调研bot）｜ 日期：2026-10-15
>
> **⚠️ 来源说明（必读）**：本机**无外网**（`curl https://docs.x.ai` 连接被拒；`HTTPS_PROXY=127.0.0.1:7890` 端口未监听；
> 本仓库 `src/tools/` 下只有 bash/edit/glob/grep/read/write，**无 web_search 实现**）。
> 因此本文基于**模型既有知识 + 官方文档链接**整理：URL 均为可验证的**权威出处**，但**具体版本号/价格/入口名称未做实时核实**，凡此类细节一律标 **⚠️**，请以后续联网为准。

---

## 1. 产品线与入口

| 产品 | 入口 | 定位 |
|---|---|---|
| **grok.com**（含 iOS / Android App） | `grok.com`、应用商店 | 消费级**独立聊天主入口**，功能最全（模式选择、Canvas、Imagine）⚠️ |
| **X 内嵌 Grok** | X App / 网页侧栏 **Grok 标签页**；帖子内 `@grok` 提及回复 | **与时间线/帖子上下文深度耦合**的账号级 bot |
| **xAI API** | `api.x.ai`、`console.x.ai`、`docs.x.ai` | 开发者接口（**OpenAI 兼容**），用于自建 bot / agent / 编排 |
| **Grok App** | iOS / Android 商店 | 移动端原生体验（语音模式、图像、拍照提问）⚠️ |

要点：**grok.com 是能力基线，X 内嵌是分发渠道，API 是开发者层**；三者共用同一套 xAI 模型后端。

## 2. 模型版本与关键能力

- **版本线**：Grok-1（314B MoE，权重后开源）→ 1.5 / 1.5V（vision）→ 2 / 2 mini（+ Flux 图像生成）→ 3 / 3 mini（**Think 推理 + DeepSearch**）→ **4 / 4 Heavy**（多 agent 并行 + 原生工具）→ 4 Fast、Grok Code Fast 1。⚠️ 截至 2026-10 可能已有更新版本，需查 `docs.x.ai/docs/models`。
- **上下文长度**：Grok 3 约 **1M tokens**；Grok 4 约 **256k**；Grok 4 Fast 约 **2M**。⚠️
- **多模态**：文本 + **图像输入**（vision）；**图像生成**（Imagine / Aurora）；**语音**在 App 侧（语音模式）。⚠️ API 侧音频/实时支持有限。
- **function calling / 工具调用**：API 支持 **function calling + structured outputs**；**服务端工具**含 Live Search、代码执行、Agent Tools（`web_search` / `x_search` / `code_execution`）。⚠️
- **DeepSearch / 联网检索**：消费端为 **agentic 检索模式**（展示检索步骤 + 来源引用，含 DeeperSearch 变体）；API 侧对应 **Live Search / Agent Tools**。⚠️

## 3. 商业化与生态

- **订阅档位**：**X Premium**（Basic / Premium / Premium+，Premium+ 含更高 Grok 额度）⚠️；**SuperGrok**（grok.com 独立订阅）⚠️；**SuperGrok Heavy**（含 Grok 4 Heavy，多 agent 并行）⚠️。
- **API 定价**：按 token 计费的 pay-as-you-go；量级参考 **grok-4 ≈ $3 / $15 per 1M input/output**、**grok-4-fast ≈ $0.2 / $0.5**；Live Search 按来源计费。⚠️ 以 `docs.x.ai/docs/pricing` 为准。
- **Agent / 记忆**：具备**跨会话 Memory**（可查看 / 编辑 / 关闭）与 **Grok Studio（Canvas）**；API 侧提供 agentic tool use 与 **Agent API**。⚠️

## 4. 官方可验证来源（URL）

- 官方站点 / 发布：<https://x.ai/> 、<https://x.ai/news>
- API 文档（模型列表 / 定价）：<https://docs.x.ai/docs/models> 、<https://docs.x.ai/docs/pricing>
- 产品入口 / 控制台：<https://grok.com> 、<https://console.x.ai/>
- X 订阅档位：<https://help.x.com/en/using-x/x-premium>

## 5. 不确定性与待联网核实
- [ ] 最新 Grok 版本号与 release note（`x.ai/news`）
- [ ] 各模型**确切**上下文长度与多模态矩阵（`docs.x.ai/docs/models`）
- [ ] SuperGrok / Heavy / X Premium+ 的**当前**价格与 Grok 额度
- [ ] API 每个模型的实时单价与 Live Search 计费规则
- [ ] Memory / Grok Studio / Voice 的对外开放范围
