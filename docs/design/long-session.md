# 长会话三件套设计

目标：让 my-agent 能长期使用。三件事一起做，因为都围绕「会话」这一份状态。

## 完成定义（可验证）

1. **会话持久化与恢复**：在某个工作目录跑一次会话，退出后执行 `my-agent --continue` 能恢复完整对话；模型能回答依赖早期上下文的问题（例如之前让它记住的词）；再次 `--continue` 继续累积。跨进程、跨重启有效。
2. **上下文压缩**：会话超过预算时，触发压缩（`/compact` 强制或自动），旧消息被一段摘要替换，会话继续可用，压缩后下一回合的输入 token 明显下降；压缩事件在对话里可见。
3. **@文件引用**：输入框里输入 `@` 会列出工作区文件，选中后把 `@相对路径` 插入到当前光标所在的词，而不是替换整行；发送时引用的文件内容被并入消息，模型无需再单独读取就能引用其内容。

## 数据与接口

### 会话存储（新增 `src/session/store.ts`）

- 目录：`~/.local/share/my-agent/sessions/<project-slug>/<session-id>.json`
  - `project-slug` = `realpath(workspaceRoot)` 中非字母数字字符替换为 `-`。
  - `MY_AGENT_SESSIONS_DIR` 环境变量覆盖（测试用），读取处只此一处。
- 文件格式（zod 校验，`version: 1`）：

```json
{
  "version": 1,
  "id": "ses_<hex>",
  "workspaceRoot": "/abs/path",
  "createdAt": 1710000000000,
  "updatedAt": 1710000000000,
  "model": "deepseek-flash",
  "usage": { "input": 0, "output": 0 },
  "messages": []
}
```

- 存储的消息与 rob/TUI 一致，**不含 system 消息**（system 每回合重建）。
- 写入使用临时文件加 rename 的原子替换。损坏的会话文件返回可读错误，不崩溃。
- 接口：`newSession(workspaceRoot, model)`、`saveSession(session)`、`loadSession(workspaceRoot, id)`、`latestSession(workspaceRoot)`、`listSessions(workspaceRoot)`。

### 接线

- 无头 `run` 与根命令新增 `--continue` 与 `--session <id>`：加载对应会话的 history，回合结束后保存。
- TUI：启动时若无 `--continue` 则新建会话；每回合结束（agent done）保存；`/clear` 结束当前会话并开启新会话（文件保留）。
- `my-agent sessions list` 列出当前工作区的会话（id、更新时间、消息数、首条用户消息摘要）。
- 并发写：只有会话拥有者写自己的文件；不同会话不同文件，无共享。

### 上下文压缩（新增 `src/agent/compact.ts`）

- 配置（项目/全局均可）：
  ```json
  { "compaction": { "auto": true, "thresholdTokens": 100000, "keepRecentTokens": 20000 } }
  ```
  默认 `auto` 为 `true`，`thresholdTokens` 为 100000，`keepRecentTokens` 为 20000。
- 估算：优先用最近一次 provider `usage.inputTokens` 作为当前上下文大小；没有则用字符数除以 4 估算。
- 触发：每回合发送前，若估算超过 `thresholdTokens` 且 `auto` 为真，或用户执行 `/compact` 强制。
- 动作：保留最近 `keepRecentTokens` 估算对应的消息，其余交给一次**无工具的摘要调用**（复用当前 provider），得到一段摘要；用单条 user 消息 `[compacted summary]\n...` 替换被压缩部分。用 user 而不是 system，因为持久化会丢弃所有 system 消息（system 每回合重建）。压缩后提示 `· compacted N messages`。
- 摘要调用失败：本轮不压缩，照常发送，并提示失败原因。
- 摘要请求本身有成本，记录 token 但不计入会话最近一次上下文估算，避免自激。

### @文件引用（新增 `src/tui/file-mentions.ts`）

- **补全**：App 启动时用 fast-glob 载入工作区文件清单（尊重 `.gitignore`，忽略 `node_modules`、`.git`，上限 5000 条），常驻内存。输入中最后一个以 `@` 开头、且前面是行首或空白的词作为查询片段，同步过滤该清单（上限 20 条）。
- **锚点补全**：补全菜单需要支持「替换当前词」而不是「替换整行」。建议给建议项加锚点：菜单记录本次补全词在输入中的起始下标，接受补全时把 `[anchor, 末尾]` 换成 `value + " "`。命令补全的锚点为 0，行为不变。
- **展开**：纯函数 `expandFileMentions(text, workspaceRoot)` 返回 `{ text, references }`。对文本中每个可解析的 `@相对路径`（必须落在工作区内且存在），读取内容并追加到消息末尾的 `Referenced files` 区块：每文件上限 200 行或 20KB，总上限 100KB；无法解析的 `@...` 原样保留，不报错。
- 只作用于单机模式。团队模式输入是 rob 定向的，本次不改。

## 阶段（每阶段单独验证后再进入下一阶段）

1. **P0 验证脚手架**：PTY 驱动扩展三个场景；单元测试目录约定；设计文档提交。
2. **P1 @文件引用**：锚点补全改造（单机+团队共享的菜单）→ 文件清单加载 → 补全 → 展开 → 测试与 PTY。
3. **P2 会话持久化**：存储模块 → CLI/TUI 接线 → `--continue` / `--session` / `sessions list` → 测试与 PTY（跨进程记忆）。
4. **P3 上下文压缩**：配置与估算 → `/compact` → 自动触发 → 测试与 PTY（真实压缩后继续可用且 token 下降）。
5. **P4 文档与整体验证**：README、CHANGELOG、PLAN 更新；三条完成定义在真实 TUI 全部通过。

## 已定的取舍

- 会话存全局数据目录，不放项目内，避免污染仓库；与凭据、skill 目录的约定一致。
- 会话文件是 JSON 明文，不做加密；里面可能含对话内容，属于用户自己的数据。
- 压缩用模型摘要，不做纯截断；截断保留为兜底。
- @文件展开有上限，避免一条消息把上下文打满。
