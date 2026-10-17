# 测试计划：按 Bot 分配 Skill · 查看已装 Skill · 接入 MCP（QA）

- 作者：rob `qa` ｜ 日期：2026-10-17
- 依据：PRD `docs/prd/bot-skills-and-mcp.md`（AC-1..AC-14）、设计 `docs/design/bot-skills-and-mcp.md`（定稿，§7 纯函数边界 / §8 AC 映射 / §10 U1–U6）
- 基线锚点：**`ad3b41a`**（= origin/main = HEAD，0/0）
- 分层：**纯函数面**（自动）｜**集成面**（自动，假 connector / 注入 discover，**不起真 MCP 进程**）｜**人工面**（显式标注，**不计自动绿**）
- 计数口径：**vitest 实跑 Tests 数**，按 **commit 范围**跑；本线基数必变，不沿用 161/1435
- 红线：允许 `web/**`、`test/web/**`、`src/skills/**`、`src/mcp/**`、`src/rob/**`、`src/agent/system-prompt.ts`、`src/serve/**`、`shared/protocol.ts`、`src/cli/skill.ts`；**零命中** `src/tui/**`、`screenshots/**`、`src/rob/room-text.ts`；**无 jsdom/@testing-library**

> 本计划与设计 §7/§8 一一对应。pm 裁决的 U1/U4/U6 已并入（见 §2.7、§2.8、§4）。

---

## 1. 纯函数面（自动绿，无进程、无目录）

| 文件 | 被测 | 用例要点 |
| --- | --- | --- |
| `test/skills/scope.test.ts` | `visibleSkills(installed, cfg)` | **5 行真值表全测**（见下）；未知名静默忽略；保序（installed 顺序）；`installed=[]` → `[]` |
| 同上 | `resolveBotSkills(cfg, discover)` | **注入 discover**（不碰真目录）；确认与 `visibleSkills` 同源 |
| 同上 | `skillScopeOf(source)` | 结构收窄不透传多余字段 |
| `test/skills/tool.test.ts` | `createLoadSkillTool({allowed, discover, read})` | **执行顺序契约 + spy 零调用**（见 §1.2） |
| `test/mcp/scope.test.ts` | `filterToolsByServers(byServer, enabled)` | 按 enabled 顺序展开（非 server 定义顺序）；未知 server 名忽略；不存在的工具不可能混入；空 enabled → `[]`；**不从工具名反推归属**（同名 sanitize 仍不串） |
| `test/mcp/redact.test.ts` | `redactMcpServer(text, env)` | 深扫（子串/多值/重复）、**最长值优先**（短值是长值子串时不残留片段）、≤1 字符不参与、无密钥时原样返回、空 env |
| `test/web/botScope.test.ts` | `supportsBotScopedTools(backend)` + 表单归一 | native→true；`cli`→false；`skillSelection`/`mcpSelection` 归一（去重/保序/空态语义） |

### 1.1 `visibleSkills` 5 行真值表（C9，**五行都要有独立断言**）

| # | `skills` | `skillsConfigured` | 期望 |
| --- | --- | --- | --- |
| 1 | `undefined` | 任意（`undefined`/`true`） | **全部已装**（向后兼容） |
| 2 | `[]` | `undefined` / `false` | **全部已装**（空数组未确认 ⇒ 未配置） |
| 3 | `[]` | `true` | **空集**（显式取消全部） |
| 4 | `["a"]` | `undefined` / `false` | 只 `a` |
| 5 | `["a"]` | `true` | 只 `a`（严格） |

另加：**JSON 往返**（序列化 → 解析 → 结果不变，钉 C13 持久化语义）。
另加：**残留白名单静默忽略**（`["a","ghost"]` 且 ghost 已卸载 → 只 `a`，不抛错，**不改写配置**，U2）。

### 1.2 `createLoadSkillTool` 执行顺序契约（AC-3 唯一取证）

按设计 §2.2 四步，用 spy 断言：

1. **名字格式非法**（`"Bad Name"` / `"UPPER"` / `""`）→ `ok:false`，且 `discover`/`read` **零调用**（连 IO 都不做）；
2. **白名单未命中**（`allowed:["a"]`，请求 `b`）→ 立即 `ok:false`，错误文案含 `Unknown skill`，且 **`discover` 与 `read` 各零调用** ← **本线最关键断言**；
3. **命中**（`allowed:["a"]`，请求 `a`）→ 调 `discover` 一次、`read` 一次，返回 SKILL.md 正文；
4. **`allowed:null`**（单 agent 无作用域）→ 不做白名单判断，命中即读；
5. 不存在于 discover 的合法名 → `ok:false`，`read` **零调用**。

> 反例保护：若 dev 写成「先 discover 再过滤」，第 2 项会失败——这是设计点名「写反则 AC-3 永远红」的护栏，必须存在。

### 1.3 估数

`scope` ≈ 12｜`tool` ≈ 8｜`mcp/scope` ≈ 6｜`redact` ≈ 8｜`botScope` ≈ 8 → **纯函数面 ≈ 42**（以实跑为准）。

---

## 2. 集成面（自动绿，但**不得起真 MCP 进程**，C18）

| AC | 取证 | 做法 |
| --- | --- | --- |
| AC-1 持久化 | 写 → 读 `my-agent.json` 往返 | 临时 `MY_AGENT_DIR`；断言 `robs[].skills/skillsConfigured/mcp` 落地；**省略字段 = 不改**（C8） |
| AC-2 不进系统提示 | `buildSystemPrompt({skills})` → `## Skills` 段落 | 注入 skills，断言未指派名**不出现**；`skills` 未注入时回落 `discoverSkills()` 行为不变（C17） |
| AC-5 安装/移除 + 无残留 | `addSkill`/`removeSkill` | 失败路径断言**无残留目录**；**C22：`addSkill rollback` 5s 超时是已知 flake，命中先隔离复跑 12/12 再判**，不直接报回归 |
| AC-6 MCP CRUD + 校验 | 结构校验 + 配置层写入 | 非法 `command`（空/非字符串）被拒；`args` 缺省；`env` 三种语义（string 覆盖 / `null` 删除 / 缺席保留） |
| AC-7 每 bot 只见启用工具 | `createRob` 的 `extraTools` | **假 connector** 造 `toolsByServer`；断言 bot 只拿到 enabled 的工具；未启用 = 不可见；两个 bot 勾不同 server 互不影响 |
| AC-8 单 server 失败只 notice | manager 组装 | 注入失败 server：产生 notice，其余 server/bot 正常；**不抛、不阻塞** |
| **AC-9①** 配置改动下一 turn 生效 | 同一 Rob 连续两 turn | 改配置（skill 指派 / 已配置 server 的启用禁用）→ 下一 turn 得新结果；**进行中的 turn 不受影响**；Rob 不重建 |
| **AC-9②** server 定义变更需重启 | `PUT/DELETE /api/mcp*` 响应 | 成功响应**必须带 `restartRequired: true`**（纯接口断言）——**这是 U1 的②，不得当① 的失败报** |
| AC-10 403 + 脱敏 | 非 loopback 请求 | 安装 skill / 改 MCP → **403 + 可读原因**；`GET /api/mcp` **无 env 值**、`McpServerInfo` 只有 `envKeys` |
| AC-11 向后兼容 | 缺省解析 | 无 `skills` 字段 → 全部已装（同今天）；**无 `mcp` 字段 ⇒ 该 bot 工具集不含任何 MCP 工具**（**U6 行为变更，单独一条钉死**，发布说明须写明） |
| AC-12 纯函数化 | 审查 + 实跑 | §1 全部文件无 DOM/React/hook；**全仓无 jsdom/@testing-library import** |
| C12 CLI 切换 | 切 CLI 再切回 native | `visibleSkills` 结果**不变**（配置保留不清空，不静默丢数据） |
| AC-10 泄漏面 | notice **与** error 两条路径 | 各一条用例：server 报错文本含 env 值 → 输出已 `«redacted»`（review 追加：MCP stderr 回显也是泄漏面） |

### 2.1 U4（`SkillInfo` 不下发 `dir`）

- 类型/序列化断言：`GET /api/skills` 返回项**不含 `dir`**（`"dir" in item === false`）。
- 若视图用例原本断言 `dir` → 改为**断言不含**。

### 2.2 U6（`mcp` 缺省全不启用）——单列一条

`{ name, kind:"rob", ... }`（无 `mcp` 字段）→ `filterToolsByServers(toolsByServer, config.mcp ?? [])` = `[]`。
**这是行为变更**（升级后老 bot 失去 MCP 工具可见性），须在发布说明写明，**不得当 bug 报**。

### 2.3 估数

集成面 ≈ 22–28（以实跑为准）。

---

## 3. 回归面（AC-13）

- 聚焦：`test/web/*` + `test/rob/room-text*`（基线 **16 files / 166**）
- 全量：`HOME=$(mktemp -d) npx vitest run`（基线 **161 files / 1435**）
- 前三条线不回归：@选择器 13/13、分区 8/8、移动端自动化面。
- **本线基数必变**（新增 5 个测试文件 + 既有文件扩展），**按 commit 范围实跑，不预设**。

---

## 4. 人工 / 集成矩阵（**显式标注，不计自动绿**）

| # | 项 | 步骤 | 为何人工 |
| --- | --- | --- | --- |
| M1 | **AC-4 已装 Skill 视图** | 设置 → 已安装 Skill：列出 name / packageName / version / description；**看不到本地路径**（U4）；能看出每个 bot 的指派状态 | 渲染层，无 jsdom |
| M2 | **AC-6 UI 保存提示（U1）** | 新增/编辑 MCP server 保存后 → 明示「已保存，重启后生效」；**不得暗示保存即可用** | 文案/交互 |
| M3 | **U6 UI 常显状态行** | bot 设置里常显「MCP：未启用（可用 N 个）」或「已启用 M×/N」，**不是一片空白** | 防止误以为不可用 |
| M4 | **C8 dirty 标记** | 只改 role/model 不动 Skills/MCP → 保存后 bot 的 `skills/mcp` 配置**原样保留**（不被清空） | 需真实保存链路 |
| M5 | **C12 CLI 灰显** | CLI backend 的 bot → Skills/MCP 区块显示只读说明「由该 CLI 自行管理」；切回 native 后原勾选**仍在** | 交互 + 状态 |
| M6 | **C20 移动端不回退** | ≤640：新控件命中区 ≥44px、弹窗内可滚；**既有 `.file-panel.mobile-open`/`.sidebar.drawer-open`/`pointer:coarse` 未被动过** | 真机/CSS 审查 |
| M7 | **AC-10 403 文案** | 非 loopback 访问安装/改 MCP → 403 且原因可读（不用 curl 也行：同网段另一台机器打开） | 需非 loopback 环境 |

> 无 jsdom（FR-10），以上一律**不当绿报**。

---

## 5. 红线（AC-14）

```bash
git diff --name-only <base>..<HEAD>
git diff --name-only <base>..<HEAD> | grep -E '^(src/tui/|screenshots/)|src/rob/room-text\.ts' && echo "RED" || echo "clean"
grep -rn "jsdom\|@testing-library" test/ web/ | grep -v node_modules || echo "no jsdom"
```
- 允许：`web/**`、`test/web/**`、`src/skills/**`、`src/mcp/**`、`src/rob/**`、`src/agent/system-prompt.ts`、`src/serve/**`、`shared/protocol.ts`、`src/cli/skill.ts`
- **协议只加性**（C19）：新增字段全为可选；不得改既有必选性/改名/改事件语义/改 `BotKind`·`BackendKind` 取值。

---

## 6. 执行步骤（dev commit 后）

1. dev 小步 commit（步骤按设计 §11）+ 报 **base..HEAD 完整 short SHA**。
2. qa 核对：树 clean、红线零命中、无 jsdom、协议只加性。
3. qa 在该 range 实跑：纯函数面（§1）→ 集成面（§2）→ 回归（§3）→ 全量 clean HOME。
4. 报**真数** + 逐条 AC-1..AC-14（绿/人工/红）+ 计数对账（新基数）。
5. 人工项（§4）由 user/review 过，**不当绿报**。

---

## 7. 风险与已知非缺陷

- **C22 flake**：`test/skills/install.test.ts > addSkill rollback` 偶发 5s 超时；**先隔离复跑**（12/12 绿）再判，不报回归。
- **U1 偏差**：MCP server 定义增删改**需重启**，是 pm 已接受的设计取舍，**不是缺陷**；AC-9 拆两条分别取证。
- **U6 行为变更**：`mcp` 缺省 = 全不启用，**不是 bug**，但必须在 UI（M3）与发布说明可见。
- **U2**：残留白名单静默忽略，UI 灰显「未安装」，**不自动改写配置**。
- **U5**：无乐观锁，双开 tab 后写覆盖先写——已接受，不做断言。
- **C12**：切 CLI 不清空配置——**刻意行为**，有用例钉住。
