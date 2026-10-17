# 简报核实用 URL 清单（路线 B：零代码）

> 用途：环境无外网时，由**有网的一侧**（用户或 host）抓取以下页面正文回贴，团队据此把
> `grok-bot-brief-final.md` 的 22 处 ⚠️ 核验成 v1.1。
>
> 用法二选一（在**有网**的机器上执行）：
> - 直接浏览器打开复制正文；
> - 或用 r.jina.ai 取可读 markdown：`curl -s https://r.jina.ai/<目标URL>`

## P0 · 直接对应简报 ⚠️ 项

| # | 目标 URL | 用于核实 |
|---|---|---|
| 1 | `https://docs.x.ai/docs/models` | 最新模型名 / 版本 / 上下文长度 / 多模态 |
| 2 | `https://docs.x.ai/docs/pricing` | API 单价、Live Search 计费、费率档位 |
| 3 | `https://docs.x.ai/docs/guides/live-search` | Live Search 能力与计费 |
| 4 | `https://x.ai/news` | 最新版本/能力发布（Grok 4 / Heavy / Fast） |
| 5 | `https://docs.x.ai/docs/overview` | 产品线/入口、API 概览、MCP 支持 |
| 6 | `https://help.x.com/en/using-x/x-premium` | X Premium / Premium+ 与 Grok 的关系 |

## P1 · 补充核实

| # | 目标 URL | 用于核实 |
|---|---|---|
| 7 | `https://x.ai/pricing`（或订阅页） | SuperGrok / SuperGrok Heavy 价格 |
| 8 | `https://console.x.ai` | 限额/免费额度（需登录，可选） |
| 9 | `https://docs.x.ai/docs/guides/function-calling` | tools / tool_choice / 结构化输出 strict |
| 10 | `https://docs.x.ai/docs/guides/mcp`（路径待定） | Remote MCP 形态与范围 |

## P2 · 竞品对比核实（test 方向）

| # | 目标 URL | 用于核实 |
|---|---|---|
| 11 | `https://platform.openai.com/docs/pricing` | GPT-5 系列定价 |
| 12 | `https://docs.anthropic.com/en/docs/about-claude/models` | Claude 模型与定价 |
| 13 | `https://ai.google.dev/gemini-api/docs/pricing` | Gemini 定价与上下文 |
| 14 | `https://modelcontextprotocol.io` | MCP 生态现状 |

## 一键抓取（在有网的机器上）

```bash
for u in \
  https://docs.x.ai/docs/models \
  https://docs.x.ai/docs/pricing \
  https://docs.x.ai/docs/guides/live-search \
  https://x.ai/news \
  https://docs.x.ai/docs/overview \
  https://help.x.com/en/using-x/x-premium \
  https://x.ai/pricing \
  https://docs.x.ai/docs/guides/function-calling \
  https://platform.openai.com/docs/pricing \
  https://docs.anthropic.com/en/docs/about-claude/models \
  https://ai.google.dev/gemini-api/docs/pricing ; do
  echo "===== $u ====="
  curl -s --max-time 30 "https://r.jina.ai/$u"
  echo
done > grok-sources.txt 2>&1
```

把 `grok-sources.txt`（或逐条正文）贴回给团队即可。
