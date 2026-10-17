# Grok × X/Twitter 场景调研（bot / 自动化方向）

> 作者：rob "pi-test" ｜ 日期：2026-10-15 ｜ 方向：X/Twitter 场景下的 Grok
>
> **⚠️ 来源说明**：本机**无外网**（`curl` 走代理 `127.0.0.1:7890` 连接被拒，无 DNS；`web_search` 无 key）。
> 内容基于模型既有知识 + 本仓库既有资料整理；下列链接均为**官方入口，未联网核验**，标 **⚠️** 的细节需联网二次确认。

## 1. 深度集成 X 后的具体功能
- **实时信息抓取**：Grok 内建 **X Search / live search** 工具，直连 X 帖子流做近实时检索与总结——这是它区别于通用模型的最大卖点 ⚠️。
- **帖子/线程总结与生成**：X 内 `@grok` 可在**被回复帖子的上下文**里做总结、翻译、解释、生成回复；也能生成配图（Imagine）⚠️。
- **趋势解读**：对 Trending 做背景梳理与归因，但结论质量取决于检索到的帖子 ⚠️。
- **账号分析**：可概括某账号近期内容/立场，属**有限**分析，不保证覆盖全历史 ⚠️。

## 2. bot / 自动化的可行做法
- **核心事实**：Grok API 与 X 发帖 API **完全分离**——Grok 负责生成/分类，X API v2 负责读流、发帖、回复，二者不互相代发。
- **自动回复**：X 过滤流（filtered stream）→ Grok 生成/审核 → X API `POST /2/tweets` 回复。
- **内容创作**：Grok 出草稿 → 规则/人工审校 → 发布（勿裸发）。
- **舆情监控**：X 搜索端点（Recent / Full-archive）+ Grok 聚类/情感判断，受套餐与配额约束。

## 3. 已知的坑与风控 / 合规
- **速率限制**：Grok API 按团队消费分级 **RPM/TPM**（另有免费额度）⚠️；X API 免费/Basic/Pro 套餐的写、读配额差异极大，超限即 **429**。
- **封禁风险**：高频自动回复、重复/垃圾内容、批量关注点赞会触发 **X Automation Rules**，轻则限流、重则封号。
- **合规**：自动化行为须**透明、非欺骗、非垃圾**；商用抓取需付费套餐 + 遵守开发者协议，勿用未授权抓取绕开 API。

## 来源（官方入口，⚠️ 本次未核验）
- https://docs.x.ai/ — xAI / Grok API、模型、服务端工具、限流
- https://developer.x.com/ — X API v2、套餐、过滤流/搜索端点、Automation Rules
- https://help.x.com/ — 平台政策 / Automation Rules
- https://x.ai/news — 产品与集成公告

## 仓库内参（可交叉引用）
- `docs/research/grok-bot-report.md`
- `docs/research/grok-dev-agent-capabilities.md`
- `docs/research/grok-vs-cli-agent-architecture.md`
