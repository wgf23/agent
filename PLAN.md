# my-agent 开发计划

> 目标：用 TypeScript 从零实现一个类似 OpenCode / Claude Code 的终端编程 Agent
> 默认模型后端：DeepSeek（OpenAI 兼容格式）
> 版本目标：v0.1 最小可用核心（MVP）

---

## 0. 先搞懂：实现一个 Agent 到底要做什么

### 0.1 Agent 的本质

**Agent = LLM + 循环 + 工具 + 上下文 + 权限**

一句话解释：让模型在一个循环里不断「思考 → 调用工具 → 看结果 → 继续」，直到完成任务。

- 普通聊天机器人：一次问答就结束。
- Agent：模型可以「动手」——读文件、写代码、跑命令、搜代码——并根据结果自主决定下一步。

### 0.2 八个必备模块

| # | 模块 | 要解决的问题 | 关键难点 |
|---|------|-------------|---------|
| 1 | Provider 接入 | 怎么和模型说话 | 流式解析、工具调用协议、重试、用量统计 |
| 2 | 工具系统 | 模型怎么动手 | JSON Schema、参数校验、结果截断、错误处理 |
| 3 | Agent 循环 | 谁驱动「思考-行动」 | 停止条件、并行/串行、取消、最大步数 |
| 4 | 上下文管理 | 模型记住什么 | 系统提示词、历史消息、AGENTS.md、超长裁剪 |
| 5 | 权限与安全 | 怎么不闯祸 | 审批流程、规则、危险命令检测、路径限制 |
| 6 | 界面 TUI | 人怎么参与 | 流式渲染、工具卡片、diff 展示、键盘交互 |
| 7 | 配置系统 | 怎么配置 | 模型/Key/配置文件、优先级 |
| 8 | 测试与打包 | 怎么保证质量 | Mock 测试、E2E、构建发布 |

### 0.3 架构图（分层）

```text
┌───────────────────────────────────────────────────────────────────┐
│                            用 户 终 端                             │
└───────────────────────────────┬───────────────────────────────────┘
                                │ 键盘输入 / 屏幕输出
┌───────────────────────────────▼───────────────────────────────────┐
│                          界面层 (UI)                               │
│   ┌──────────────────────┐          ┌────────────────────────┐    │
│   │  TUI 模式 (Ink/React) │          │ 无头模式 my-agent run   │    │
│   │  聊天流 / 工具卡片     │          │ stdout 流式输出         │    │
│   │  权限弹窗 / 输入框     │          │ (脚本、CI、测试)        │    │
│   └──────────┬───────────┘          └───────────┬────────────┘    │
│              └───────────────┬──────────────────┘                 │
│                      订阅事件 / 提交输入                            │
└──────────────────────────────┬────────────────────────────────────┘
                               │ Event Bus（事件总线）
┌──────────────────────────────▼────────────────────────────────────┐
│                         Agent 核心层                               │
│   ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│   │ 会话状态     │  │ 系统提示词    │  │ 主循环 (Agent Loop)      │  │
│   │ messages[]  │  │ System Prompt │  │ stream→tool→result→请求  │  │
│   └─────────────┘  └──────────────┘  └─────────────────────────┘  │
│   ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│   │ 上下文裁剪   │  │ 取消 / 重试   │  │ 用量统计 (tokens/cost)   │  │
│   └─────────────┘  └──────────────┘  └─────────────────────────┘  │
└───────┬───────────────────┬──────────────────────┬────────────────┘
        │                   │                      │
┌───────▼────────┐  ┌───────▼─────────┐  ┌─────────▼─────────────┐
│  Provider 层    │  │    Tools 层      │  │   Permissions 层       │
│  OpenAI 兼容     │  │  read/write/edit │  │  规则: allow/ask/deny  │
│  流式 + 工具调用 │  │  bash/glob/grep  │  │  交互式批准            │
│  DeepSeek 适配   │  │  路径安全 / 截断  │  │  危险命令检测          │
└───────┬────────┘  └───────┬─────────┘  └───────────────────────┘
        │                   │
┌───────▼────────┐  ┌───────▼─────────┐
│  DeepSeek API   │  │  本地文件系统     │
│  api.deepseek   │  │  Shell 进程       │
└────────────────┘  └─────────────────┘
```

### 0.4 Agent 主循环图

```text
                     ┌──────────────────────┐
                     │  用户输入 → messages  │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
              ┌──────► 调用 LLM（流式）      │
              │      │  messages + tools    │
              │      └──────────┬───────────┘
              │                 │
              │      ┌──────────▼───────────┐
              │      │  解析流式事件          │
              │      │  text / reasoning /  │
              │      │  tool_call / usage   │
              │      └──────────┬───────────┘
              │                 │
              │        ┌────────▼────────┐
              │        │ 有工具调用吗？    │
              │        └───┬─────────┬───┘
              │          是│         │否
              │            │         ▼
              │            │   ┌──────────────┐
              │            │   │ 输出最终回答   │  ← 循环结束
              │            │   └──────────────┘
              │            ▼
              │   ┌──────────────────────┐
              │   │ 权限检查（逐个工具）    │
              │   │ allow / ask / deny   │
              │   └──────────┬───────────┘
              │              ▼
              │   ┌──────────────────────┐
              │   │ 执行工具（只读可并行） │
              │   │ 文件 IO / Shell       │
              │   └──────────┬───────────┘
              │              ▼
              │   ┌──────────────────────┐
              │   │ 结果追加到 messages    │
              │   └──────────┬───────────┘
              │              │
              └──────────────┘
                （最多循环 N 次，防止失控）
```

### 0.5 一次工具调用的示例

```text
用户: "把 package.json 里的 name 改成 my-agent"

turn 1  ┌─ LLM ──────────────────────────────────────────┐
        │ 思考: 需要先读文件 → tool_call: read_file       │
        └────────────────────────────────────────────────┘
        ↓ 权限: read 默认允许
        read_file("package.json") → 文件内容
        ↓ 结果回传给 LLM
turn 2  ┌─ LLM ──────────────────────────────────────────┐
        │ tool_call: edit_file(替换 "name" 字段)          │
        └────────────────────────────────────────────────┘
        ↓ 权限: 修改文件 → 弹窗询问用户 → 批准
        edit_file(...) → 成功
        ↓ 结果回传
turn 3  ┌─ LLM ──────────────────────────────────────────┐
        │ "已修改完成"（无工具调用 → 结束）                │
        └────────────────────────────────────────────────┘
```

### 0.6 核心循环伪代码

```ts
// Agent 核心循环（简化版）
async function run(userInput: string) {
  messages.push({ role: "user", content: userInput });

  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, toolCalls, usage } = await provider.stream(messages, tools);
    reportUsage(usage);

    if (toolCalls.length === 0) break;        // 没有工具调用 → 完成

    messages.push(assistantMessage(text, toolCalls));

    for (const call of toolCalls) {            // 只读工具可并行
      const ok = await permissions.check(call);
      if (!ok) {
        messages.push(toolResult(call.id, "用户拒绝执行"));
        continue;
      }
      const result = await executeTool(call);
      messages.push(toolResult(call.id, result));  // 出错也作为结果回传
    }
  }
}
```

---

## 1. 已确认的技术决策

| 项 | 决定 | 原因 |
|---|---|---|
| 语言/运行时 | TypeScript + Node 20+ | 生态成熟、类型安全 |
| 包管理 | pnpm | 快、TS 项目标准 |
| 开发/构建 | tsx + tsup | 零配置开发，产出可发布的 bin |
| 测试 | Vitest | 快、TS 原生 |
| TUI | Ink + React | 流式 UI 的成熟方案 |
| Provider | 官方 `openai` SDK + 可配置 `baseURL` | 只做 OpenAI 兼容适配器，DeepSeek / OpenAI / Ollama / OpenRouter 通吃 |
| 默认模型 | `deepseek-flash` | 便宜、1M 上下文、支持工具调用、支持思考模式 |
| CLI 解析 | commander | 简单够用 |
| 工具 Schema | zod | 唯一来源，自动转 JSON Schema |
| 辅助库 | execa / fast-glob / diff | bash 执行 / 文件匹配 / diff 展示 |

---

## 2. 目录结构

```text
my-agent/
├── src/
│   ├── index.ts              # bin 入口
│   ├── cli/                  # 参数解析、无头模式
│   │   └── run.ts
│   ├── agent/                # 核心
│   │   ├── agent.ts          # 主循环
│   │   ├── session.ts        # 消息历史 / 状态
│   │   ├── system-prompt.ts  # 系统提示词 + AGENTS.md
│   │   └── context.ts        # 上下文裁剪 / 用量统计
│   ├── providers/
│   │   ├── types.ts          # canonical 消息 / 事件类型
│   │   ├── openai-compatible.ts
│   │   └── presets.ts        # deepseek / openai / custom
│   ├── tools/
│   │   ├── types.ts          # Tool 接口
│   │   ├── registry.ts
│   │   ├── read.ts           # read_file
│   │   ├── write.ts          # write_file
│   │   ├── edit.ts           # edit_file
│   │   ├── bash.ts
│   │   ├── glob.ts
│   │   └── grep.ts
│   ├── permissions/
│   │   └── manager.ts        # 规则匹配 + 审批流程
│   ├── config/
│   │   └── config.ts         # 配置加载与优先级
│   ├── tui/
│   │   ├── App.tsx
│   │   ├── components/       # MessageList / ToolCard / Diff / PromptInput / PermissionDialog / StatusBar
│   │   └── hooks/
│   └── util/                 # 截断 / 路径 / token 估算
├── test/
├── package.json
├── AGENTS.md                 # 给 agent 看的项目说明（可选）
├── my-agent.json             # 项目配置（可选）
└── README.md
```

---

## 3. Provider 设计：OpenAI 兼容 + DeepSeek

### 3.1 为什么只做 OpenAI 兼容

- 手头只有 DeepSeek，而 DeepSeek 官方就提供 OpenAI 兼容端点；
- 只维护一条适配路径，代码量最小；
- 以后接 OpenAI / Ollama / LM Studio / OpenRouter，只需改 `baseURL` 和 key，无需改代码。

### 3.2 DeepSeek 最新 API 要点（2026-10 查证官方文档）

| 项目 | 内容 |
|---|---|
| Base URL (OpenAI 格式) | `https://api.deepseek.com` |
| 模型 | `deepseek-flash`（默认，1M 上下文）、`deepseek-v4-pro` |
| API Key 环境变量 | `DEEPSEEK_API_KEY` |
| 思考模式 | **默认开启**；`thinking: {type: "enabled"\|"disabled"}`，`reasoning_effort: none/low/high/max`（默认 high） |
| 推理内容 | 响应含非标准字段 `reasoning_content`，**发送历史时必须剥离** |
| 工具调用 | 支持；思考模式下 `tool_choice` 只能用 `auto`（`required`/指定工具会 400） |
| 输出上限 | `max_tokens` ≤ 384K；默认非思考 8K、思考 64K（max effort 128K） |
| 用量统计 | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `reasoning_tokens` |
| 特殊 finish_reason | `insufficient_system_resource`（资源不足，应重试）、`aborted` |
| 流式 | 标准 SSE，`data: [DONE]` 结束；`stream_options.include_usage` 可选 |
| 价格 | 极便宜（flash 缓存命中 $0.003–0.006/M，输出 $0.6–1.2/M），E2E 测试可放心跑真实 API |

### 3.3 需要处理的 DeepSeek Quirks

1. `reasoning_content` 流式 delta → 映射为 `reasoning_delta` 事件，TUI 暗色显示；**出站历史剥离**；
2. `thinking` / `reasoningEffort` 暴露为配置项；思考模式下 `temperature` 无效（不用管）；
3. `insufficient_system_resource` 视为可重试错误；
4. usage 解析出缓存命中率，显示在状态栏；
5. 工具参数为流式分片 JSON，需要拼接后再解析。

### 3.4 配置示例

`my-agent.json`（项目配置，可设置 provider 与 permissions）：

```json
{
  "provider": {
    "preset": "deepseek",
    "model": "deepseek-flash",
    "thinking": "enabled",
    "reasoningEffort": "high",
    "maxSteps": 25
  },
  "permissions": {
    "bash": [
      { "pattern": "git status*", "action": "allow" },
      { "pattern": "rm *", "action": "deny" }
    ],
    "write_file": "ask",
    "edit_file": "ask"
  }
}
```

权限规则按顺序匹配，首条命中的 `pattern` 生效；`pattern` 支持 `*` 通配，可直接写成标量动作（如 `"write_file": "ask"`）。

全局配置 `~/.config/my-agent/config.json`（只能设置 provider，不能设置 permissions）：

```json
{
  "provider": {
    "thinking": "disabled",
    "reasoningEffort": "low"
  }
}
```

任意 OpenAI 兼容端点：

```json
{
  "provider": {
    "baseURL": "http://localhost:11434/v1",
    "apiKeyEnv": "OLLAMA_API_KEY",
    "model": "qwen3"
  }
}
```

API Key 优先来自环境变量（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`，或 `apiKeyEnv` 指向的变量），其次来自 `~/.config/my-agent/credentials.json` 中按该变量名存储的 key（`my-agent setup` 写入，目录 0700、文件 0600）。配置文件中不允许出现 `apiKey` 字段；`MY_AGENT_MODEL` 可覆盖模型名。

配置优先级：CLI 参数 > 环境变量 > 项目 `my-agent.json` > 全局 `~/.config/my-agent/config.json` > 内置默认值。

---

## 4. 分阶段任务

### Phase 0 — 项目脚手架（约 0.5 天）

- [ ] `git init`、`pnpm init`、严格模式 `tsconfig`
- [ ] 安装 tsx / tsup / vitest / linter（eslint 或 biome）
- [ ] commander CLI 骨架：`my-agent [prompt]`、`--version`、`--help`、`-m/--model`
- [ ] 配置模块：读环境变量 + 默认配置；没有 key 时给出友好提示
- [ ] 把本计划复制到项目根目录（`PLAN.md`）

**完成标准**：`pnpm dev --help` 正常输出，`pnpm test` 通过。

### Phase 1 — Provider 层（约 1 天）

- [ ] 定义 canonical 类型：`Message`、`ContentBlock`（text / reasoning / tool-call / tool-result）、`StreamEvent`（text_delta / reasoning_delta / tool_call / usage / finish / error）
- [ ] `providers/openai-compatible.ts`：官方 `openai` SDK + `baseURL`，流式 chat completions
- [ ] 流式工具调用参数拼接（合并分片 JSON）
- [ ] DeepSeek quirks：reasoning 映射与出站剥离、thinking/effort 配置、可重试错误、usage 解析
- [ ] presets：`deepseek`（默认）、`openai`、`custom`
- [ ] 模型解析：`-m deepseek-flash` / `deepseek/deepseek-flash`
- [ ] 冒烟脚本：真实 API 跑通纯文本流式 + 工具调用各一次

**完成标准**：Node 脚本能从 DeepSeek 流式收到文本、reasoning 和工具调用。

### Phase 2 — 工具系统（1–2 天）

- [ ] `Tool` 接口：name、description、zod schema、`readOnly`、`execute(args, ctx)`
- [ ] 注册表 + zod → JSON Schema
- [ ] `read_file`（offset/limit、带行号）、`write_file`、`edit_file`（精确替换、歧义报错、`replaceAll` 开关）
- [ ] `bash`（超时、cwd、输出截断、退出码）
- [ ] `glob`、`grep`（尊重 .gitignore）
- [ ] 路径安全：一切限制在工作目录内，阻止越界与符号链接花招
- [ ] 输出截断策略（如单次结果 ≤ 2000 行 / 50KB）
- [ ] 每个工具的单元测试（临时目录）

**完成标准**：所有工具单测通过，可独立调用。

### Phase 3 — Agent 循环（1–2 天）

- [ ] 系统提示词构建：身份、工具说明、环境信息（cwd/平台/日期）、`AGENTS.md` 自动发现
- [ ] 主循环：stream → 收集工具调用 → 执行 → 追加结果 → 重发，直到无工具调用或达到 `maxSteps`
- [ ] 只读工具并行执行；写操作与 bash 串行
- [ ] 工具错误作为结果回传，永不打断循环
- [ ] `AbortController` 取消
- [ ] 429/5xx/资源不足 指数退避重试
- [ ] 简单上下文裁剪（优先丢最旧的工具输出）
- [ ] **无头模式** `my-agent run "..."`（TUI 之前的 E2E 测试手段）
- [ ] MockProvider 集成测试：纯文本 / 单工具 / 多工具 / 工具报错 / 取消 / 步数上限

**完成标准**：`my-agent run "列出 ts 文件并总结 package.json"` 端到端跑通。

### Phase 4 — 权限（约 1 天）

- [ ] 规则模型：按工具 + 可选模式匹配（如 `bash: { "git *": allow, "*": ask }`）
- [ ] 默认策略：read/glob/grep 允许；write/edit/bash 询问
- [ ] `ask` 两种实现：TUI 弹窗；无头模式用 `--yes` 自动批准或默认拒绝
- [ ] 「始终允许此模式」写入项目配置
- [ ] 危险命令额外警告（`rm -rf`、`curl | sh`、sudo 等）

**完成标准**：无头模式遵守 `--yes`，规则匹配有单测覆盖。

### Phase 5 — TUI（2–4 天）

- [ ] Ink 应用骨架 + 状态机：`idle → streaming → tool-running → permission → idle`
- [ ] Agent 事件 → UI 状态（reducer 或轻量 store）
- [ ] 流式文本 + 基础 Markdown 渲染
- [ ] reasoning 折叠块（DeepSeek 思考模式）
- [ ] 工具卡片：名称、参数摘要、状态（pending/running/done/error）、可折叠输出
- [ ] `write_file`/`edit_file` 的 diff 彩色渲染
- [ ] 输入框：多行、历史、斜杠命令（`/help` `/model` `/clear` `/quit`）
- [ ] 权限弹窗（允许一次 / 始终允许 / 拒绝）
- [ ] 状态栏：模型、cwd、token 用量、缓存命中率、耗时；思考时 spinner
- [ ] 按键：ESC 取消当前任务、Ctrl+C 退出
- [ ] 性能：消息 memo、限制渲染窗口

**完成标准**：能在 TUI 里完成一次完整编码会话并审批工具调用。

### Phase 6 — 配置、打包与打磨（1–2 天）

- [ ] 配置优先级完整实现；`--model` 参数
- [ ] 友好错误：缺 key、模型名错误、网络失败、限流
- [ ] `pnpm build` → `dist/index.js`；配置 `bin`；`npm link` 安装测试
- [ ] README：安装、使用、配置参考
- [ ] `AGENTS.md` 支持文档化

**完成标准**：`npm link && my-agent` 在任意目录可用。

### Phase 7 — 硬化与 v0.1 发布（1–2 天）

- [ ] E2E 冒烟脚本（真实 DeepSeek API，环境变量开关控制）
- [ ] 跨平台路径检查（Windows/macOS/Linux）
- [ ] 打 tag `v0.1.0`，写 CHANGELOG
- [ ] 可选：GitHub Actions（typecheck + test + release）

---

## 5. 里程碑与时间

| 里程碑 | 含义 | 累计工作量 |
|---|---|---|
| **M1** | CLI 从 DeepSeek 流式输出文本 | ~1.5 天 |
| **M2** | 无头模式跑通工具 + 权限 | ~5 天 |
| **M3** | 完整 TUI 可用 | ~9 天 |
| **M4** | 打包、文档完成 v0.1 | ~12 天 |

（约两周业余时间；全职约 5–7 天。）

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 流式工具调用分片解析出 bug | 拼接后统一解析；单测覆盖分片场景 |
| 长会话 TUI 卡顿 | 消息 memo、渲染窗口、输出截断 |
| 权限询问太烦 | 合理默认 + 「始终允许」持久化 + `--yes` |
| 上下文超长 | 1M 窗口基本够用；仍保留裁剪兜底 |
| 工具循环失控烧钱 | `maxSteps` 上限 + 用量实时显示 |
| 不同兼容端点行为差异 | quirks 只写在 provider 文件内，不影响核心 |

---

## 7. v1 明确不做（Backlog）

子 Agent（subagent / task 工具）• LSP 诊断集成 • hooks • 自定义命令 • 图片输入 • Web UI • 插件系统 • 原生 Anthropic 适配

---

## 8. 参考资料

- DeepSeek API 文档：https://api-docs.deepseek.com
- DeepSeek 工具调用指南：https://api-docs.deepseek.com/guides/tool_calls
- OpenCode（参考实现）：https://github.com/sst/opencode
- Ink（TUI 框架）：https://github.com/vadimdemedes/ink
- OpenAI Node SDK：https://github.com/openai/openai-node
- Anthropic 的 Agent 设计文章（构建 agent 的通用原则）
