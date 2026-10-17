# PRD：按 Bot 分配 Skill · 查看已装 Skill · 接入 MCP

- 状态：**设计已冻结，进入实现**（`docs/design/bot-skills-and-mcp.md` 定稿，U1–U6 全部收口见 §11；Q1–Q6 按 pm 推荐值 **全 A** 执行，若用户推翻按通知改设计）
  - 决策单 `docs/prd/bot-skills-and-mcp-decisions.md`（★ = 推荐默认，用户回「全按推荐」即等于当前口径）
  - 实现进度见设计 §11 四步；本 PRD 无其他未决项
- 提出人：用户（房间 `rnd`）｜承接：pm｜日期：2026-10-17
- 用户原话：「我还需要可以给每个bot安装指定的skill、可以查看已安装的skill，并且可以接mcp。」
- 关联代码：`src/skills/*`、`src/mcp/*`、`src/agent/system-prompt.ts`、`src/rob/types.ts`、`src/serve/server.ts`、`src/serve/team.ts`、`shared/protocol.ts`、`web/src/components/BotSettingsPanel.tsx`、`web/src/components/SettingsDialog.tsx`
- 关联文档：`docs/design/skills-arena.md`（既有 skill 概念）、`docs/design/web-tools.md`（工具/审批边界）

---

## 1. 现状读码（带证据）

| 能力 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| Skill 安装 | 全局单根，npm 安装到 `~/.config/my-agent/skills` | `src/skills/paths.ts:11-19`（`MY_AGENT_SKILLS_DIR` 可覆盖）、`src/skills/install.ts:31` `addSkill` | **没有 bot 维度**，装了就对所有 bot 生效 |
| Skill 查看 | 仅 CLI 表格输出 | `src/cli/skill.ts:20-24` `formatSkillList` | **Web UI 无任何入口**；无法看「某个 bot 装了哪些」 |
| Skill 注入 | 全局无条件列出 | `src/agent/system-prompt.ts:43-51`（`discoverSkills()` 无过滤） | 所有 bot 系统提示里是同一份 skill 列表 |
| Skill 加载 | 按名字全局查 | `src/skills/tool.ts:15-45`（`discoverSkills()` 全局匹配） | **无法按 bot 限制**，任何 bot 都能 `load_skill` 任意已装 skill |
| MCP 配置 | global + project 两层合并 | `src/config/resolve.ts:393-395` | 无 bot 维度；改配置需手写 JSON |
| MCP 连接 | serve 启动时连接一次，工具数组共享给**所有** bot | `src/serve/server.ts:208`（`extraTools: [...mcp.tools, ...]`）、`src/rob/team.ts:284`（`extraTools: this.options.extraTools`） | **不能按 bot 启用/禁用**某个 MCP server |
| Bot 配置 | `name/role/model/permissions/backend/wake` | `src/rob/types.ts:56-94` | 无 `skills`、无 `mcp` 字段 |
| Web Bot 面板 | role / model / backend / provider / 删除 | `web/src/components/BotSettingsPanel.tsx`、`shared/protocol.ts:53` `BotInfo` | 无 skill / MCP 区块；`BotInfo` 无相关字段 |

**结论**：三项能力（skill 安装、MCP 接入）**基础设施都在**，缺的是 **(a) bot 维度**与 **(b) Web UI 入口**。本需求不是从零造，是给现有能力加「按 bot 的作用域 + 可视化管理面板」。

---

## 2. 目标与非目标

### 目标
- **G1** 每个 bot 可**指派指定 skill**；未被指派的 skill 对该 bot **不可见、不可加载**。
- **G2** 可**查看已安装 skill**：全局已装清单（名称/包/版本/描述）+ 每个 bot 的指派状态。
- **G3** 可**接入 MCP**：在 UI 里增删改 MCP server，并**按 bot 启用**。
- **G4** 改动**即时生效**（下一次 turn 起），不需要重启 serve。
  - **限定（pm 2026-10-17 拍板 U1）**：此条仅适用**已存在的 MCP server 的「按 bot 启用/禁用」**与全部 skill 指派。**新增 / 编辑 / 删除 MCP server 定义**需重启 serve 才连接（连接是启动期一次），响应带 `restartRequired: true`，UI 明示「需重启生效」。理由与例外范围见 §11 U1。
- **G5** 向后兼容：老配置/老 bot 不因新字段缺失而失效。

### 非目标
- 不做 per-bot 物理隔离的 skill 目录（不复制磁盘文件；用白名单作用域，见 D-2）。
- 不做 MCP 市场/远程注册中心、不做 OAuth、不做 HTTP/SSE 传输（本期仅 stdio，见 Q4）。
- 不做 TUI 侧 UI（沿用「TUI 二期」惯例）。
- 不改 `src/tui/**`、`screenshots/**`、`src/rob/room-text.ts`。
- 不引入 jsdom / @testing-library。

---

## 3. 功能需求（FR）

- **FR-1 每 bot 的 skill 白名单**：bot 配置新增可选 `skills: string[]`（skill 名）。空/缺省语义见 D-3。持久化到 `my-agent.json` 的 `robs[]`，重启后保持。
- **FR-2 作用域生效（关键）**：bot 的 skill 作用域必须**同时**约束两处，缺一不可——
  1. `buildSystemPrompt` 的 `## Skills` 列表只列该 bot 已指派的 skill；
  2. `load_skill` 工具对该 bot 只允许其白名单内的名字，**越界必须拒绝且不读文件**。
  只有 (1) 没有 (2) 等于没做（bot 仍能猜名字加载）。
- **FR-3 查看已装 skill**：Web UI 提供「已安装 Skill」视图，列出全局已装 skill 的 `name / packageName / version / description / dir`，并标出**哪些 bot 已指派**（或反之：在 bot 面板列出候选 + 勾选）。
- **FR-4 安装 / 移除 skill**：UI 支持按 npm spec 安装、按名字移除；失败时给出可读原因且**不留下半装状态**（复用 `addSkill` 已有回滚）。
- **FR-5 MCP server 管理**：UI 可新增 / 编辑 / 删除 MCP server（`command`、`args`、`env`），保存前做**结构校验**；不允许把 `env` 的密钥回传到浏览器（只回「已设置/未设置」）。
- **FR-6 按 bot 启用 MCP**：bot 配置新增可选 `mcp: string[]`（server 名）。该 bot 的工具列表只包含**已启用 server** 的工具；未启用的 server 对该 bot 不可见。
- **FR-7 故障隔离**：单个 MCP server 启动失败只产生 `notice`（现有行为），**不得**阻塞 serve 启动或其他 server/bot（`src/mcp/manager.ts:38-44` 已具备，须保持）。
- **FR-8 生效时机**：保存 skill/MCP 配置后**下一次 turn**生效；不要求重启，也不打断正在跑的 turn。
- **FR-9 安全**：安装 skill（执行 npm）与新增 MCP server（执行任意命令）属**高风险写操作**，与现有 `src/serve/server.ts:1178-1185` 同口径——**仅 loopback 绑定可改**，非 loopback 返回 `403` + 可读原因。
- **FR-10 范围与可测性**：新增**判断逻辑**（skill 过滤、MCP 启用集合、配置迁移默认值、表单校验）必须抽成**纯函数**并落 `test/web/*` 或 `test/rob/*`；UI/CSS/进程行为按**人工或集成**标注，**不当绿报**。
- **FR-11 协议与范围**：本需求**必须**改 `shared/protocol.ts`（`BotInfo` 增 `skills`/`mcp`，新增 skill/MCP 视图类型与请求体）与 `src/serve/**`。**这是与前三条线不同的地方，红线需重划**（见 §6）。

---

## 4. 开放问题（请用户拍板）

> **已压缩为决策单 `docs/prd/bot-skills-and-mcp-decisions.md`（每项 A/B 二选一，★ = pm 推荐默认值，用户回一句「全按推荐」即可）**，由 leader 呈用户。拍板后代办：Q5 缺省语义（D-3）与 Q6 CLI backend 强制留空（`src/rob/types.ts` 的 `superRefine` 加一条：`backend.kind === "cli"` 时禁用 skills/mcp 或 UI 灰显）需同步进设计。
> 下表保留原始问题与 pm 建议，供 architect 回溯。

| # | 问题 | pm 建议 |
|---|---|---|
| **Q1** | 范围：只做 Web UI，还是 CLI/配置也要支持？ | **Web UI 为主 + 配置文件持久化**；CLI `skill add/remove/list` 保留，新增 `--bot` 过滤作为顺带（不阻塞） |
| **Q2** | 「给每个 bot 安装指定的 skill」= 全局装一次再给 bot 勾选，还是每个 bot 独立安装副本？ | **全局装一次 + 每 bot 白名单**（不复制文件、不做 per-bot 目录；省磁盘、升级只装一次） |
| **Q3** | MCP 是全局共用，还是按 bot 启用/分别配置？ | **server 在全局配置定义 + 每个 bot 勾选启用哪些**（同一 server 多 bot 复用，单进程只连一次） |
| **Q4** | MCP 传输：只 stdio 还是也支持 HTTP/SSE？ | **本期仅 stdio**（现有实现），HTTP/SSE 二期 |
| **Q5** | 默认语义：老 bot 没有 `skills` 字段时，是「可用全部已装」还是「全部不可用」？ | **skills 缺省 = 可用全部已装**（向后兼容，现有行为不变）；一旦显式保存白名单，就变成严格白名单 |
| **Q6** | CLI backend 的 bot（claude / opencode / pi）怎么办？它们自己管工具栈。 | **skill/MCP 只对 native backend 生效**；UI 对 CLI backend 显示「由该 CLI 自行管理」，不写配置、不误导 |

---

## 5. 暂定决策（pm 代决，可被 Q1–Q6 覆盖）

- **D-1 复用而非重写**：安装/移除复用 `addSkill`/`removeSkill`；连接复用 `connectMcpServers`；不新写 npm/MCP 客户端。
- **D-2 作用域 = 白名单**，不做磁盘隔离（见 Q2 建议）。理由：skill 是 npm 包，复制会产生升级/缓存分裂。
- **D-3 缺省语义不对称**（重要，避免歧义）：
  - `skills` **缺省/空数组 = 可用全部已装 skill**（保持现有行为）；
  - 一旦用户在 UI 里保存了勾选（哪怕全部取消），写 `skills: []` + 标记 `skillsConfigured: true`（或等价语义），此后为**严格白名单**。
  - `mcp` **缺省 = 不启用任何 server**（MCP 有启动成本与安全面，不能默认全开）。
- **D-4 工具过滤位置**：在 `Team.createRob` 组装 `extraTools` 时按 bot 的 `mcp` 过滤（`src/rob/team.ts:264-290`），不改 `Rob` 内部；skill 过滤在 system prompt 与 `load_skill` 两处，通过 `RobOptions` 传入**已解析的白名单**（不传全局 discover 结果）。
- **D-5 即时生效**：`RobOptions` 里的白名单在每次 turn 组装上下文时读取（或更新 bot 时重建 Rob 实例，二选一由 architect 定）；不得要求重启进程。
- **D-6 UI 落点**：`BotSettingsPanel` 增「Skills」「MCP」两个区块；全局「已安装 Skill」清单放 `SettingsDialog`（或独立入口），与现有主题/Provider 并列。
- **D-7 密码/密钥**：MCP `env` 值**不回传浏览器**；UI 只显示键名与「已设置」。这是安全底线，不得为便于编辑而放宽。

---

## 6. 范围与红线（**本线需重划**）

- **允许改**：`web/**`、`test/web/**`、`src/skills/**`、`src/mcp/**`、`src/rob/**`（types/team/rob）、`src/agent/system-prompt.ts`、`src/serve/**`、`shared/protocol.ts`、`src/cli/skill.ts`。
- **允许改（2026-10-17 补充，qa 指出的清单遗漏）**：`src/config/project-file.ts`（白名单持久化的**唯一落盘点**，不动它无法实现 AC-1）、`test/config/**`、`test/skills/**`、`test/mcp/**`、`test/rob/**`（对应各层用例）。**这是补 PRD 而非回退代码**：持久化必然经过该文件，原清单属遗漏。
- **允许改（2026-10-17 pm 裁决，红线例外，qa 上报）**：`src/tui/index.tsx`、`src/cli/team.ts`。**理由不是"顺便"**：`TeamOptions.extraTools` 的语义本是「所有 rob 共享」，本线把 MCP 工具改为按 bot 选择（新增可选 `mcpToolsByServer`）后，**任何仍传扁平 `extraTools: [...mcp.tools]` 的调用方都会让每个 bot 拿到全部 MCP 工具** —— 那是 U6 明确否决的「静默授予可能执行命令的工具」。两文件是 API 变更的**必然消费方**，不改即泄漏。
  **红线例外是窄口的，只允许下面这一处**：
  - `src/tui/index.tsx`：**仅** Team 构造处 `extraTools: [...mcp.tools, ...plugins.tools]` → `mcpToolsByServer: mcp.toolsByServer` + `extraTools: plugins.tools`；
  - **不得**改 `App`（工作区 solo 对话）那处 `extraTools: [...mcp.tools, ...lsp.tools, ...]` —— 它不是 bot，共享全部工具是正确语义；
  - **不得**改动任何渲染、布局、键位、主题。
  **review 判定**：`src/tui/index.tsx` 的 diff 若超出上述一处（±3 行），**按红线报**。
- **允许改（2026-10-17 pm 裁决，新增）**：`docs/**` —— **仅 .md 文档**。理由：本线的设计文档（`docs/design/bot-skills-and-mcp.md`）、PRD（`docs/prd/bot-skills-and-mcp.md`）**当前全部 untracked**（`git ls-files docs/` 只有 7 个历史 design 文档，PRD 目录零文件），而 AC/红线/§12.9 取证标准全都引用它们 ⇒ **「设计文档与实现一致」没有版本锚点**，§14.1 的规则在文档层面失效。仓库既有先例（`docs/design/rob.md` 等 7 个已 tracked）支持提交。
  **约束**：① 必须**单独一笔** `docs: …` 提交，**不得与源码混提交**（保 review 的代码 diff 干净）；② 只提交 `.md`，不得夹带截图/二进制；③ 提交后 `git ls-files docs/prd/` 必须非空。
- **红字禁止**（命中即红）：`screenshots/**`、`src/rob/room-text.ts`（后端 @ 语义不得因本线变动）；`src/tui/**` **仅允许** `src/tui/index.tsx` 的 `new Team` MCP 接线（≤2 行），**其余零命中**（2026-10-17 leader 裁决重划，见 §13）。
- **评审 diff 必须干净**：只含上列允许路径；`screenshots/**` 噪声、`stash` 残留、其他线的 permissions 增量**一律不得混入提交**（前车之鉴：`deploy-backup-20261016-120907`）。
- **测试纪律**：不得引入 jsdom / @testing-library；新增纯函数必须有对应 `test/web/*` 或 `test/rob/*` 用例；进程/UI 行为显式标注「人工/集成」，**不当绿报**。

---

## 7. 验收标准（AC）

| AC | 内容 | 取证方式 |
|---|---|---|
| **AC-1** | bot 的 skill 白名单可勾选并持久化，重启后仍在 | 集成（读回配置）+ 纯函数（序列化/解析） |
| **AC-2** | 未指派的 skill **不出现在**该 bot 的系统提示 `## Skills` | 纯函数（过滤结果断言） |
| **AC-3** | `load_skill` 对未指派 skill **返回失败且不读文件** | 纯函数 / 集成（拒绝路径） |
| **AC-4** | 「已安装 Skill」视图列出 name/包/版本/描述，并能看出每个 bot 的指派状态 | 纯函数（视图模型）+ 人工 |
| **AC-5** | UI 可安装/移除 skill；失败有可读原因；失败后无残留包目录 | 集成 + 纯函数（回滚目录集） |
| **AC-6** | 可增删改 MCP server；保存前结构校验；非法 `command` 被拒 | 纯函数（校验）+ 集成 |
| **AC-7** | 每个 bot 只看到自己启用的 MCP server 的工具；未启用即不可见 | 纯函数（工具过滤）+ 集成 |
| **AC-8** | 单个 MCP server 启动失败只产生 notice，不阻塞其他 server/bot/serve 启动 | 集成（失败注入） |
| **AC-9** | 保存后**新实例的下一 turn**生效，无需重启 serve。**已更正（U7/B2）**：保存**会**打断该 bot 正在进行的那一轮（`updateBot` = `stop()` + `denyRob(TURN_INTERRUPTED)` + `createRob()`），属**已知行为、非缺陷**，UI 须在保存处提示；**不得**断言「同一实例」或「不打断」。**范围限定（U1）**：仅 skill 指派与「已配置 server 的按 bot 启用/禁用」；MCP server **定义**的增删改须重启，接口返回 `restartRequired: true` | 集成（用 `updateBot` 返回的新实例跑下一 turn） |
| **AC-10** | 非 loopback 绑定时，安装 skill / 改 MCP 返回 403 + 可读原因；`env` 密钥不回传浏览器 | 集成 + 纯函数（视图脱敏） |
| **AC-11** | 向后兼容：无 `skills` 字段的老 bot 行为与今天一致（可用全部已装）；无 `mcp` 字段 = 不启用任何 server（**U6：属行为变更，须在 UI 可见 + 发布说明写明**） | 纯函数（缺省解析）+ 回归 |
| **AC-12** | 新增判断逻辑均为纯函数且有单测；测试不引入 jsdom | 审查 + 实跑 |
| **AC-13** | 前三条线不回归：`test/web/*`、`test/rob/room-text*`、全量测试全绿 | 实跑（干净 HOME） |
| **AC-14** | 红线：diff 仅含 §6 允许路径；`screenshots/**`、`src/rob/room-text.ts` **零命中**；`src/tui/**` **仅允许** `src/tui/index.tsx` 的 `new Team` MCP 接线（**≤2 行**），**其余零命中** | 审查（`git diff --name-only` + `git diff --numstat src/tui/index.tsx`） |

---

## 8. 风险与依赖

| 风险 | 说明 | 缓解 |
|---|---|---|
| 作用域只做一半 | 只过滤系统提示、不过滤 `load_skill` → bot 仍可猜名加载 | FR-2 明确「两处缺一不可」，AC-2/AC-3 分别取证 |
| MCP 工具名冲突 | 多 server 暴露同名工具 | 复用 `src/mcp/tools.ts` 的 `existingNames` 去重逻辑（已有） |
| 进程级 MCP 生命周期 | 现在 serve 启动连一次、进程退出才 dispose | 若要求「禁用后立即断开」会引入 PID/进程管理复杂度 → 本期**只做工具可见性过滤**，不断开进程（写进设计约束） |
| 安装 skill 执行 npm | 供应链风险（`--ignore-scripts` 已开） | 复用现有 flags（`install.ts:13-19`）；仅 loopback 可改（FR-9） |
| 与移动端线互相干扰 | 都要改 `BotSettingsPanel`/`styles.css` | 以 `ad3b41a` 为基线，小步提交，移动端契约（≤640 覆盖层/44px）不得回退 |

---

## 9. 交付路径（建议，非本 PRD 强制）

1. architect 出 `docs/design/bot-skills-and-mcp.md`：数据结构（`RobConfig.skills/mcp` + 缺省语义）、过滤点（system prompt / load_skill / extraTools）、协议字段、UI 落点、AC-1..AC-14 映射。
2. qa 出测试计划：纯函数面（过滤/缺省/校验/脱敏）+ 集成面（持久化/403/故障隔离）+ 人工面（UI 操作路径）。
3. dev 小步实现：① 配置与纯函数（可并行）② 服务端协议与路由 ③ UI 面板 → 每步一个 commit。
4. review 按 §6 红线审 diff；ci 五步（干净 HOME）；pm 按 AC-1..AC-14 终判。

---

## 10. 设计前置约束（dev / qa / review 对齐 `ad3b41a` 读码后钉死，architect 必须逐条落进设计）

> 以下不是建议，是**若不写死就会导致 AC 落不了地或形成假绿**的硬点。均为代码依据，非推测。

### 10.1 注入点（dev ①② / qa 1、3 / review 3）
| # | 约束 | 代码依据 |
|---|---|---|
| C1 | `load_skill` 必须**从全局 registry 下沉为 per-bot 构造的工具**（闭包持白名单），复用「extraTools 遮蔽同名内置」机制；否则要么扩 `ToolContext`、要么两处各查一遍必漂 | `src/tools/types.ts:4`（`ToolContext` 无 bot 身份）、`src/tools/registry.ts:21`（模块级单例） |
| C2 | `load_skill` 的**取证顺序是契约**：**先查白名单 → 未命中直接返回 `ok:false`，不得调用 `discoverSkills()` / `readFile`**。自然写法（先 discover 再 filter）会让 AC-3 永远红 | qa 第 1 条：只能靠 spy 断言「零调用」取证 |
| C3 | 工厂签名必须可注入：`createLoadSkillTool({ allowed, discover, read })`（或等价），否则「拒绝且不读文件」不可证 | 同上 |
| C4 | MCP 过滤点**只能在 `createRob`**（`extraTools` 是扁平共享数组） | `src/serve/server.ts:208` → `src/rob/team.ts:283` |
| C5 | **禁止靠工具名前缀反推 server**：`mcp__<server>__<tool>` 的 server 段经 `sanitize()`，**不可逆** | `src/mcp/tools.ts:31` |
| C6 | `ConnectMcpServersResult` 必须**按 server 分组返回工具名**（如 `McpServerSummary` 增 `tools: string[]`），过滤写成纯函数 `filterToolsByServers(perServer, enabled)` | qa 3 / review |

### 10.2 状态与语义（architect / review 2、4）
| # | 约束 | 理由 |
|---|---|---|
| C7 | 必须引入 `skillsConfigured?: boolean`：`skills` 缺省=全部 与「显式清空」两者数组都是 `[]`，无标记位则**区分不出来** | D-3 落地前提 |
| C8 | **只有用户实际改动 skills 区块才置 `skillsConfigured:true`**；只改 role/model 不得静默把 bot 从「全部已装」锁成当时勾选。若选择「保存=全量替换」，必须写进 UI 文案 + 加用例（二选一，**必须显式选**） | 否则 Q5 的向后兼容在第一次编辑 bot 后即被悄悄破坏；双开 tab 还会后写覆盖先写 |
| C9 | 白名单真值表必须落**纯函数**并**5 行全测** + config→JSON→config 往返：`缺省` / `[]` / `[]+configured:true` / `["a"]` / `["a"]+configured:false` | 本线最容易写错也最容易假绿处 |
| C10 | **AC-9 一个 turn 只解析一次**：系统提示的 skills 列表与 `load_skill` 白名单必须来自**同一份 turn 快照**，否则出现「提示列了 A、工具却拒绝 A」 | 用户视角即 bug |
| C11 | 生效机制取「**每 turn 重解析**」而非重建 Rob（重建丢进行中上下文）；须在设计中写明「本轮 turn 组装上下文时重新解析」的注入点 | architect 倾向，pm 认可 |
| C12 | Q6 抽纯谓词 `supportsBotScopedTools(backend)`，UI 灰显可测。**CLI backend 的 bot 若已存 `skillsConfigured:true`，日后切回 native 会静默生效——必须二选一并写死：保留（写文档+用例）或切换时提示** | review 4 |

### 10.3 密钥与安全（dev ③ / qa 5 / review 5）
| # | 约束 | 理由 |
|---|---|---|
| C13 | **白名单进 project file（`my-agent.json`），密钥只留 env**，两者不得混写一个文件 | `my-agent.json` 本机 untracked 但会随项目走 |
| C14 | `McpServerSummary` **类型层面就没有 env 字段**；`redactMcpServer()` 深扫，断言序列化后**任何层级**不出现密钥原值（不是只查某字段 undefined） | qa 5 |
| C15 | **MCP server 的 stderr 回显（连接失败 notice）不得带出 env 原值**，notice/error 两条路径各加一条用例 | review 5：泄漏面大于「别写进 project file」 |
| C16 | **启用某 MCP server 实质是能力提升**（其工具可能执行命令）：落点必须 loopback-only，且改动后首轮工具调用**仍走现有 ask 审批**，不得默认承袭 | review 5 |

### 10.4 可测性 / 回归 / 红线（qa 2、6 / ci / review 6）
| # | 约束 | 理由 |
|---|---|---|
| C17 | AC-2 走既有缝：`system-prompt.ts:42` 是 `options.skills ?? discoverSkills()` → 过滤抽 `visibleSkills(installed, cfg)` 纯函数即可直接断言 `## Skills` 内容 | qa 2 |
| C18 | AC-8/AC-9 用**假 connector**，单测**不得真起 MCP 进程** | qa 6 |
| C19 | 红线重划为「**协议只允许加性变更**」：只准加可选字段（`skills?`/`skillsConfigured?`/per-bot MCP 启用表）；改既有字段必选性、改名、改事件语义 = **红**。仍零命中 `src/tui/**`、`screenshots/**`、`src/rob/room-text.ts` | review 1 |
| C20 | `BotSettingsPanel` 与移动端线同文件，基线 `ad3b41a`：新增区块**不得回退** ≤640 抽屉/覆盖层与 44px 契约 | review 6 |
| C21 | 回归基线（`ad3b41a`）：聚焦 `test/web`+`room-text*` = **16 文件/166**；全量 clean HOME = **161 文件/1435**。本线测试基数**必然变**，不沿用，按 commit 范围实跑 | qa / ci |
| C22 | 已知 flake：`test/skills/install.test.ts > addSkill rollback` 偶发 5s 超时（隔离 12/12 绿）。本线正动 `src/skills/**`，命中须**隔离复跑 + 连跑 3 次**再定性，不直接报红 | qa / ci |

**pm 结论**：Q1–Q6 拍板即可转 architect；以上 C1–C22 已按 dev/qa/review 口径留存，architect 出稿时逐条映射，**不得遗漏 C1/C2/C8/C10/C15**（这五条是本线的返工源与假绿源）。

---

## 11. 设计未闭合边界的 pm 裁决（U1–U6，2026-10-17）

> 对应 `docs/design/bot-skills-and-mcp.md` §10。**U1 = 接受偏差；U2–U6 = 接受并加最小约束**。本节生效后 PRD 可视为 confirmed（待 Q1–Q6 用户回执确认后转 confirmed）。

| # | 架构提出的边界 | pm 裁决 | 附加要求（必须落进实现/文档） |
|---|---|---|---|
| **U1** | 新增/编辑/删除 MCP server 定义需重启 serve 才连接，与 G4「不需重启」冲突 | **接受偏差**。热连接需按需 connect/disconnect + PID/引用计数，与设计 §3.3「只做可见性过滤、不断开进程」直接矛盾，本期不做 | ① 写接口响应带 `restartRequired: true`；② UI 在保存后明示「已保存，重启后生效」；③ G4/AC-9 已按此限定；④ 热连接**另开一线**，不在本线承诺 |
| **U2** | 白名单残留已卸载的 skill 名 → 静默忽略 | **接受** | UI 灰显为「未安装」，**不得**自动改写用户配置（卸载不等于改配置） |
| **U3** | `env` 只写不读；缺席=保留，null=删除 | **接受** | 即使 loopback 也不回显明文（C14 是类型级约束，不给例外） |
| **U4** | `SkillInfo.dir` 回传本地绝对路径 | **改为不下发**：从 `SkillInfo`/wire 类型**删除 `dir`** | UI 用不到；CLI `skill list` 仍显示路径。理由：本线已确定 serve 可能绑 `0.0.0.0`（本轮刚向用户提示过同网段暴露风险），不下发绝对路径更省事且零功能损失 |
| **U5** | 双开 tab 后写覆盖先写（无乐观锁） | **接受** | 不以报错掩盖；C8「省略=不改」已把最坏影响限制在 skills/mcp 区块本身 |
| **U6** | `mcp` 缺省=全不启用 ⇒ 升级后既有 bot 失去当前共享的 MCP 工具可见性 | **维持缺省全不启用**（能力提升必须显式同意，不做隐式授权）；但**不得静默丢失** | ① bot 设置面板常显「MCP：未启用（可用 N 个）」而不只是一片空白；② 发布说明写明这是**行为变更**；③ AC-11 已标注。**否决**「缺省=全部启用」的兼容方案：那等于给所有 bot 静默授予可能执行命令的工具 |

**结论**：设计可进入实现，§10 U1–U6 全部收口，本 PRD 除 Q1–Q6 用户回执外**无其他未决项**。

---

## 12. 写侧语义终版（2026-10-17 二次裁决：推翻 pm 首版「裸 `[]` 保持兼容」）

> **背景**：pm 首版裁决为「裸 `{skills: []}` 保持真值表第 2 行『全部已装』、归一留到 HTTP 层」。**leader 推翻该裁决，pm 复核后接受**（代码依据：`c6c5fa9` 中 `{skillsConfigured:false}` 单独出现会 `delete merged.skills` → 真值表第 1 行 → **作用域被放宽**）。
> **已落地**：`a5982e8 fix(config): never widen a bot's skill scope on write`。

### 12.1 为什么推翻（三条，按重要性）
1. **方向错**：写侧**显式提交了数组**就是明确意图；静默把「一个都不要」放大成「全都要」是危险方向。**「全部」只该由省略表达**，不该由空数组表达。
2. **收口位置错**：`writeRobUpdate` 是**唯一写入口**（面板 / CLI / 脚本共用）；策略放 HTTP handler 会漏掉其他调用方。**守卫必须在 choke point**，不在某个路由里。
3. **「只加性」不构成理由**：`skillsConfigured` 是全新字段，没有既有客户端，加拒绝语义不破坏任何兼容性；「靠 UI 自觉」= 无守卫。

### 12.2 写侧契约（终版，**取代**任何「HTTP 层归一」的说法）
| 请求体形态 | 配置层行为 | 落盘结果 | 解析（真值表） |
|---|---|---|---|
| `skills` 与 `skillsConfigured` **均缺席** | 不动该 bot 的 skill 作用域 | 原样保留 | 不变 |
| `skills: [...]`，`skillsConfigured` **缺席** | **归一为 `true`** | `{skills, skillsConfigured:true}` | 严格白名单 |
| `skills: []`，`skillsConfigured` 缺席 | **归一为 `true`** ⇒ 空集 | `{skills:[], skillsConfigured:true}` | 第 3 行：**一个都不可用** |
| `skills: [...]`，`skillsConfigured: true/false` | 照传入写 | 同左 | true→严格；false→第 4 行（同结果） |
| **`skills` 缺席，`skillsConfigured` 给了（true 或 false）** | **拒绝**：`{ok:false, error:"skillsConfigured requires skills"}`（HTTP 400） | 不写 | — |
| `skills: []` + `skillsConfigured: false` | 照传入写 | `{skills:[], skillsConfigured:false}` | 第 2 行：**回到默认（全部已装）** |

- **守卫位置**：`src/config/project-file.ts` → `writeRobUpdate`（**唯一的写入口**），不是 `src/serve/server.ts` 的 PATCH handler。
- **「恢复默认（全部已装）」的唯一姿势**：`{skills: [], skillsConfigured: false}`（显式、可审计）。**没有**「只发 flag」的捷径。
- **真值表第 1/2 行保留在读取侧**：手写/历史文件里 `skills` 缺席、或 `[]` 且未确认，仍按向后兼容解析为「全部已装」（AC-11）。**写侧不再产生第 1 行**。
- **UI 责任**：面板 dirty 标记在用户**实际改动过** skills 区块时成对发送 `skills` + `skillsConfigured`；只改 role/model 时两者**都省略**（C8）。

### 12.3 撤回记录（避免后人翻旧账）
- ~~「裸 `{skills: []}` 保持第 2 行『全部已装』」~~ → **作废**，改为归一为 `skillsConfigured: true`（空集）。
- ~~「归一放在 PATCH handler」~~ → **作废**，归一下沉到 `writeRobUpdate`。
- ~~「只发 `skillsConfigured: true` ⇒ `skills=[]`」~~ → **作废**，改为 **400**。`c6c5fa9` 中的对应用例已在 `a5982e8` 被同语义新用例替换（**属裁决驱动的行为变更，不是测试削弱**，review 勿按「改测试凑绿」处理）。

### 12.4 写侧不变量覆盖**全部落盘入口**（create + update），不是只钉 update

> **背景（leader 实测指出，pm 复现确认）**：`a5982e8` 只钉住了 `writeRobUpdate`，而 **`writeRob`（`addRob` 创建路径）是第二个写入口**，绕过了守卫。
> pm 在 `a5982e8` 上实测（探针，随后删除）：
> - `addRob({name, role, skills: []})` → 落盘 `{"skills":[]}`（无 flag）→ `visibleSkills` = **全部已装**（放大）
> - `addRob({name, role, skillsConfigured: true})` → `ok:true`（**该 400 却没报**）
> **今天 HTTP 打不到**（创建路由不转发 skills 字段），属未来调用方风险；但既然要立不变量，就必须立全。

**终版契约（已落地于 `367f355`）**：
- 两条写路径共用**同一个** `normalizeSkillScope(incoming)`（单一实现，非两处各写一遍）：
  | 写 | 结果 |
  |---|---|
  | `skills` 与 flag 均缺席 | 不动（create = 不设作用域）|
  | `skills: [...]` / `skills: []`，flag 缺席 | 归一 `skillsConfigured: true` |
  | `skills` 缺席，flag 给了（true/false） | `{ok:false, "skillsConfigured requires skills"}`，**不落盘** |
  | `skills: []` + flag `false` | 照写（唯一回退默认通道） |
- **不变量**：**落盘后的形态永远不含「有列表无确认」这一歧义态**。无论哪个入口先进来。
- pm 探针复核（HEAD `367f355`）：create 路径四态全部正确 —— 裸 `[]` ⇒ `{skills:[], skillsConfigured:true}` ⇒ 可视图为空集；flag-only ⇒ 拒绝且**文件未创建**；`['alpha']` 无 flag ⇒ 归一 true 且可视图只 `alpha`；`[]`+false ⇒ 可视图回到全部。

**评审口径**：以后再出现"只钉住某一个写入口"的修复，**按未完成报**（C22 同类：只钉一半 = 没钉）。

### 12.5 range 与数字口径备注（防止陈述失真）
- `ad3b41a..a5982e8` 是 **2 笔 / 11 文件**（`c6c5fa9` 11 文件 + `a5982e8` 2 文件，后者只改了其中 2 个**已存在**的文件，不是新增 11 之外的 2 个）。对外表述统一写「2 笔 / 11 文件」。
- 之后新增 `367f355`（create 路径守卫，2 文件），终版 range 应为 **`ad3b41a..367f355`（3 笔 / 11 文件）**。
- 用例数口径三者不矛盾、范围不同：dev 窄口径 52（5 文件）/ pm 目录口径 96 / qa+ci 全量 1471–1474（clean HOME）。**报数必须带范围**。

### 12.6 评审口径三条（2026-10-17，dev 步骤 2 WIP 期间追加）

**① 「归一前后对象不一致」是与「只钉一个写入口」并列的第二类 bug**
`367f355` 除加守卫外，还把 create 路径的**重复名检查改为基于归一化后的 `created`**，否则会「校验用原对象、落盘用归一化对象」。评审时凡见「先算 A、再落 B」的写路径，必须核 A/B 是否同一对象。

**② 跨层谓词不得靠注释声明"无漂移面"，必须靠测试锁**
`web/tsconfig.json` 的 `include` 只含 `["src", "../shared", "vite.config.ts"]`，**不含 `../src`** ⇒ web 无法 import `src/rob/types.ts`。因此 `supportsBotScopedTools` 必然存在**两份实现**（服务端 `src/rob/types.ts` + 浏览器 `web/src/botScope.ts`）。
**要求**：`test/rob/` 加跨层一致性用例，遍历 `BotKind` 全取值断言两侧返回逐项相等。设计里凡出现「单一实现/无漂移面」的措辞，**必须有对应锁定用例**，否则按未完成报。

**③ 已提交文件被二次修改时，按全量 range 审，不只看最后一笔**
`src/rob/types.ts` 在步骤 1（`c6c5fa9`）已提交，步骤 2 又改。规则：**只允许追加**（既有 schema 字段、既有导出签名不得改）。review/ci 按 `ad3b41a..HEAD` 全量判定，不按单笔。

### 12.7 红线例外裁决：`src/tui/index.tsx` + `src/cli/team.ts`（2026-10-17）

**上报**：qa 发现步骤 3 的 WIP 改了 `src/tui/index.tsx`，与 §6「`src/tui/**` 零命中」冲突。

**事实（pm 在 committed HEAD `790d688` 上核过）**：这三个消费方**全部**仍在传扁平 `mcp.tools`：
| 文件 | 位置 | 语义 |
|---|---|---|
| `src/serve/server.ts` | :208 `extraTools: [...mcp.tools, ...plugins.tools]` | TeamHub（bot）——**必须改** |
| `src/cli/team.ts` | :121 `extraTools: mcp.tools` | Team（bot）——**必须改** |
| `src/tui/index.tsx` | :153 `extraTools: [...mcp.tools, ...plugins.tools]` | Team（bot）——**必须改** |
| `src/tui/index.tsx` | :289 `...mcp.tools` | **App（工作区 solo 对话，不是 bot）——不得改** |
| `src/serve/server.ts` | :183（`hubOptions.extraTools` 块内，块头 :173）| **SoloHub（工作区对话）——不得改** |

> **行号更正（ci 实测指出，pm 采纳）**：上一版把 SoloHub 写成 `:182` 是错的 —— `:182` 是 `extraTools: [` 的数组开括号，实际 `...mcp.tools` 在 **:183**，所在 `hubOptions` 块从 **:173** 开始，由 **:203** `new SoloHub(hubOptions, …)` 消费。**被改的是 :208（`robHub` = TeamHub）**。review 按此表核，别按旧行号。

**裁决：选 (a) 补白名单，不回退 TUI。** 三条理由：
1. **方向与 U6 冲突**：选项 (b)「TUI 侧 MCP 不按 bot 隔离」正是 U6 否决的「静默授予可能执行命令的工具」。同一份 PRD 不能一边禁止隐式授权、一边在 TUI 保留隐式授权。
2. **不改 = 真缺陷，不是未实现**：`mcpToolsByServer` 缺省时 `createRob` 走 `mcpTools === undefined` 分支，`extraTools` 原样下发 ⇒ TUI 里每个 bot 拿到**全部** MCP 工具。serve 已隔离而 TUI 不隔离，是最典型的"半条链修复"（同 §12.4 的口径）。
3. **例外是窄口的**：只允许 Team 构造那 2 行，solo 的 App/SoloHub 保持共享（正确语义）。已写死「超出 ±3 行按红线报」。

**评审口径**：`src/tui/index.tsx` 的 diff 只可能是「+2 / −1」左右；超过即报红线。`src/cli/team.ts` 同理只允许 `mcpToolsByServer` 注入 + `extraTools` 收敛。

### 12.8 报数纪律（qa 快照过期的教训）
本节线内已发生 **3 次**「按过期快照报缺陷」：`botScope.ts` 缺 `.js`、`file 未创建` 用例缺失、`schema 腿 1/4`。三次都是**探测时点早于修复提交**。
**规则**：qa / ci 的每份报告必须**首行写明 `HEAD=<hash>`**；报缺陷前**必须在该 hash 上重新确认一次**（`git log -S` 或直接读文件），并在报告里带 `git log -S<关键字>` 结果作为时点证据。**未标 HEAD 的数字一律视为暂定，不进验收台账。**

### 12.9 AC-7 取证标准（pm 定，防止「纯函数绿 = AC 绿」）
`test/mcp/scope.test.ts` 的 6 例**只证明 `filterToolsByServers` 这个纯函数自身**，用手写 fixture，**不构成 AC-7 的取证**。ci 已定性「用例空转」，pm 认同。

**AC-7 记绿的最低门槛（缺一不可）**：
1. **生产数据源**：`connectMcpServers` 真实分组产出 `toolsByServer`（不是测试里手搓的 record）。**判定细则（review 指出，pm 采纳）**：`test/rob/team.test.ts` 用 `mcpToolNamed("mcp__docs__search")` **手写假工具**，**不算**满足本条 —— 生产端工具名生成逻辑变了，测试照样绿。必须改由 `connectMcpServers`（fake connector）或至少 `mapServerTools` 的输出来驱动，使 `mcp__*` 名字是**生产端生成**的；
2. **Team→Rob 真链路**：至少一组用例走 `new Team({ mcpToolsByServer: {…} })` → bot A 只拿到 server X 的工具、bot B 只拿到 Y 的工具、未勾选的看不到；
3. **缺省语义**：`mcp` 字段缺省的 bot 拿到**零个** MCP 工具（U6）。**断言形状有严格要求**（ci 指出，pm 采纳）：该 bot 的工具列表**不是空数组**（还有 `load_skill` 等内置工具），因此必须写成
   `expect(advertised("scout").filter((n) => n.startsWith("mcp__"))).toEqual([])`
   —— 既保证「零 MCP 工具」，又保持 `toEqual` 的严格性。**禁止**写成 `not.toContain(...)` 两条枚举（漏一个 server 就假绿），也**禁止**字面 `toEqual([])`（必红）。
4. **兼容口不泄漏**：`mcpToolsByServer` 省略时 `extraTools` 原样下发（老调用方行为不变）。**取证已存在**：`test/rob/team.test.ts:134-158`（`51dc311`，`extraTools: [mcpTool()]` 且**不传** `mcpToolsByServer`，断言 planner/worker **都**拿到 `mcp__memory__create_entity`）。**不需要新写用例，报告引用即可**（`git log -S mcp__memory__create_entity` 证时点）。
5. **`toolCount === tools.length`**：`McpServerSummary` 的两个字段必须同源，否则日后分叉。
6. **summary 不含 env 值**：`tools` 只来自 `mapServerTools` 的映射名，env 仅在 `StdioMcpClient` spawn 处使用 ⇒ **结构上不可达**。仍补一条廉价锁定（fake server 带 `FAKE_MCP_PID_FILE`，断言 `JSON.stringify(result.servers)` 不含该值）。**报告措辞必须是「结构上不可达 + 额外锁定」，不得写成「存在泄漏」。**

**判定口径**：步骤 3 落定前，**AC-7 一律记「未实现 / 未取证」，不得因测试全绿而标绿**。

**当前状态（HEAD `047dc7f`，pm + leader + review 三方独立核过，结论一致）**：
| 门槛 | 状态 | 证据 |
|---|---|---|
| ① 生产数据源 | ❌ | `team.test.ts:185-186` 仍是 `mcpToolNamed()` 手写假工具 |
| ② Team→Rob 真链路 | ✅ | 真 `Team` + 真 turn + mock provider（planner/worker/scout 三向）|
| ③ 缺省零 MCP | ❌ | `:222-223` 仍是两条 `not.toContain`（假绿形态）|
| ④ 兼容口 | ✅ | `team.test.ts:110`（`51dc311`），**以 `:110` 为准**；leader 提的 `:226` 只断言一个 native bot，属**弱证据不采用** |
| ⑤ `toolCount === tools.length` | ❌ | 仅硬编码 `toolCount: 2` |
| ⑥ summary 不含 env | ❌ | 无锁定断言（结构上不可达，补锁定）|

**⇒ AC-7 维持「未取证」。047dc7f 不是终版；dev 补完 ①③⑤⑥ 后才是终版，ci 一次性跑五步，不跑两遍。**

### 12.10 行为变更必须进发布说明（AC-11 的落地要求）
四个调用点（`serve/server.ts` robHub、`cli/team.ts`、`tui/index.tsx`、`serve/team.ts`）全部改传 `mcpToolsByServer` 之后，`mcp` 字段缺省的旧 bot（含 TUI / serve / cli 三条入口）从「拥有全部 MCP 工具」变为「零 MCP 工具」。
- **性质**：design §10 **U6 的刻意非对称**，**不是 bug、不是向后兼容**。
- **必做**：release notes 单列一条并写明「这是行为变更」；UI 常显「MCP：未启用（可用 N 个）」（已有 AC-11 约束）。
- **验收**：ci 在终版报告里必须出现该条，缺失按未完成报。

---

## 13. 红线重划与终判披露要求（2026-10-17 · leader 裁决 A，pm 落文）

### 13.1 AC-14 措辞的最终版（**取代**此前「`src/tui/**` 零命中」的任何表述）
> `screenshots/**`、`src/rob/room-text.ts` **零命中**；`src/tui/**` **仅允许** `src/tui/index.tsx` 的 `new Team` MCP 接线（**≤2 行**），**其余零命中**。

### 13.2 为什么重划（功能性事实，不是放水）
`src/tui/index.tsx` 有**两处** MCP 接线，性质完全不同（HEAD `790d688` 行号）：

| 位置 | 消费者 | 是否 bot | 处理 |
|---|---|---|---|
| `new Team({…})`（:145 起，接线在 **:153**） | TUI 的 bot 团队 | **是** | **必须接 `mcpToolsByServer`** |
| `<App …/>`（:273 起，`extraTools` 在 **:288**，`...mcp.tools` 在 **:289**） | 单 agent 工作区对话 | **否** | **不得动** |

- **不接的后果**：`new Team` 若不传 `mcpToolsByServer`，`createRob` 走 `mcpTools === undefined` 分支 ⇒ **TUI 里每个 bot 拿到全部 MCP 工具**，AC-7 在 TUI 面失效。
- **坚持零命中的后果**：TUI 与 serve/cli 对**同一份 bot 配置**行为不同 = **语义分叉**，比一行接线严重得多。
- 因此：**接**（2 行）比**不接**安全。重划是缩小一处已知泄漏面，不是放宽标准。

### 13.3 终判必须**显式披露**这一处重划（硬要求）
终判报告里必须单列一句，形如：
> 「AC-14 红线在本轮**经 leader 裁决重划**：`src/tui/**` 从『零命中』改为『仅 `src/tui/index.tsx` 的 `new Team` MCP 接线 ≤2 行』，实测 `git diff --numstat src/tui/index.tsx` = **2/1**；`<App>`（单 agent）与 SoloHub 未动。」

**禁止**让它读起来像「原本就在允许面内」。**重划必须可追溯**：PRD §13 + 设计 §0/§12 双处留痕，review 定向审这一行。

### 13.4 行号口径（**必须带 HEAD 引用**，否则一律作废）

> **本轮行号争议的根因**：`src/tui/index.tsx` 的改动是 **+2/−1（净 +1 行）**，因此**该行之后的所有行号整体下移 1**。pm 报的 `:288/:289` 是在 `790d688`（改前）量的，ci 报的 `:289/:290` 是在 `047dc7f`（改后）量的 —— **两人都对，只是 HEAD 不同**。**规则：报行号必须同时报 HEAD，否则无法对账。**

| 对象 | @ `790d688`（改前） | @ `047dc7f` 及之后（改后，整体 +1） |
|---|---|---|
| `src/tui/index.tsx` bot 接线 | `new Team` :145 起，**接线行 :153** | `new Team` :145 起，接线行改为 `mcpToolsByServer`（净 +1） |
| `src/tui/index.tsx` 单 agent（**禁区**） | `<App` :273，`extraTools={` :288，`...mcp.tools` **:289** | `<App` **:274**，`extraTools={` **:289**，`...mcp.tools` **:290** |
| `src/serve/server.ts` SoloHub（**禁区**） | `hubOptions` :173，`...mcp.tools` **:183**，消费 :203 | **不变**（server.ts 改动在 :208 之后，未前移） |
| `src/serve/server.ts` robHub=TeamHub（**必改**） | **:208** | hunk `@@ -208 +208,4 @@`，`mcpToolsByServer` 落在 :210 |
| `src/cli/team.ts`（**必改**） | :121 | :121 |

> 修正记录：`:182`→`:183`（ci 指出）；`:289`/`:290` 的 1 行差是 **HEAD 差异不是错误**（pm@790d688 = 289，ci@047dc7f = 290）。**核心结论：禁区判定不看行号，看 `git diff -U0` 的 hunk 是否落在 `<App>` 块内。**
>
> **更稳的判据（2026-10-17 review 补，pm 采纳）**：连 hunk 行号也不作为唯一依据，**最终以 `git diff --name-only` + 按目录/扩展名白名单判定路径集**为准，hunk 只用于确认 `<App>` 零命中。

### 13.4a 红线取证**不得用前缀法**（review 指出，pm 采纳）
`grep -v '^docs/'` 这类前缀匹配会**误判**：`docs-dist/**.md` 是纯文档、**不在任何红线内**，却会被前缀法判成「非 docs 文件」；反过来，未来若出现 `docs-dist/x.ts`，前缀法会**静默漏检**。
**规则**：红线取证一律按**「目录白名单 + 扩展名」**判定，禁止用 `^docs/` 这类前缀一刀切。示范：
```sh
# 代码面（红线判定只看这里）
git diff --name-only A..B | grep -E '\.(ts|tsx|js|mjs|css|json)$'   | grep -v -E '^(docs/|docs-dist/|screenshots/)' || true
# 文档面（单独报，不参与红线）
git diff --name-only A..B | grep -E '^(docs|docs-dist)/.*\.md$'
```
**本轮实例**：`021cef6`（`docs-dist/` 5 文件）用前缀法会被误报为「5 个非 docs 文件」；按新规则应判为**纯文档面、红线零命中**。

### 13.5 AC-11 行为变更必须写进终判（与 §12.10 同为硬要求）
`mcp` 缺省 = **不启用任何 server**（U6 刻意非对称）。升级后老 bot 会**失去现有 MCP 工具可见性** —— **这是行为变更，不是回归、不是向后兼容**。
终判与 release notes 必须同时出现：
1. 「`mcp` 缺省的既有 bot 升级后不再看到任何 MCP 工具（U6 裁决）」；
2. 「UI 常显『MCP：未启用（可用 N 个）』」；
3. 「能力提升必须显式同意，不做隐式授权」。
**缺失按未完成报。**

---

## 14. 流程教训与当前验收状态（2026-10-17，pm 维护）

### 14.1 复发模式：「纯函数绿 ≠ 生产已接」——本线已出现 **3 次**
| # | 产物 | 当时状态 | 接线现状（2026-10-17 复核） | 发现者 |
|---|---|---|---|---|
| 1 | `filterToolsByServers` | 6 例单测绿、**零调用** | ✅ 已接线 `src/rob/team.ts:292` | ci |
| 2 | `redactMcpServer` | 6 例单测绿、**零调用** | ✅ 已接线 `manager.ts:84`(connect) / `:114`(dispose) | pm |
| 3 | `connectMcpServers().dispose` | 未过 redact | ✅ 已补 try/catch + redact，**但生产分支不可达**（见 §14.5） | leader / ci |

> **更正记录（pm 自纠）**：本表初版把 1、2 两行写成「零调用」，那是 `523ded5` 之前的快照。**leader 指出后我复核，两处均已接线。** 这正是本表要防的错误，发生在写表人身上，一并留痕。

> **§12.8a 补充（2026-10-17，leader 提议、pm 采纳并收紧）**：**引用 PRD 内任何表格作为「现状」前，必须先核该表的表头 HEAD 是否等于当前 HEAD**；不等于则只能按「历史留档」引用，并写明其 HEAD。
> 本轮已发生 4 起同类错误（按过期快照报缺陷）：`botScope.ts` 缺 `.js`、`file 未创建`、`schema 腿 1/4`、**AC-7「差 4 项」**（后者由 leader 向用户误报，引用的是标着 `HEAD 047dc7f` 的 §12.9 状态表，而实际 HEAD 已是 `ca70bc2` 之后）。
> **配套硬规则**：状态表标题必须写成「当前状态（**HEAD `<hash>`**）」形式；终判前对每张状态表做一次 HEAD 比对，不一致的表**整表作废重测**，不得逐行挑着用。

**判定规则（进入终判流程）**：任何 AC 的取证，必须同时核 **①生产路径是否调用该函数/分支；②是否有跨层集成用例经过该路径**。仅「有纯函数 + 有单测」**不得记绿**，一律按「用例空转 / 未实现」报。
**根因**：设计先冻结了接口，实现方按签名写了函数与单测，但接线是第二步 —— 两个步骤之间没有任何自动检查。**缓解**：AC 表格里区分「单测」与「集成/接线」两列，接线列没有证据即视为未完成（本文 §12.9 已按此写法）。

### 14.2 读路径缺口（AC-3/AC-4 曾不可实现）
- **缺口**：`BotInfo`（`shared/protocol.ts:53`）只加 `BotDraft` 未加读侧三字段 ⇒ `GET /api/bots` 回不来 scope ⇒ 编辑面板无法 prefill。
- **修复**：`BotInfo` 加 `skills?`/`skillsConfigured?`/`mcp?`（纯追加）；`src/serve/team.ts bots()` 仅在 `!== undefined` 时回填，且用 `[...rob.skills]` **拷贝而非别名**（防止面板侧改写污染配置对象）。
- **`solo.ts` 不补（leader 否证 ci 的疑问，pm 采纳）**：solo 全程无 skills/mcp 逻辑，MCP 走全局 `config.mcpServers`（`server.ts:152`），`PATCH /api/bots` 在 SoloHub **无 `updateBot` ⇒ 501**，编辑面板在 solo 不可用 ⇒ absent 语义正确（= config never set）。
- **规则**：**「缺省不回字段」是语义，不是遗漏** —— 面板必须能区分「未设置（默认）」与「显式空列表」。任何在服务端补默认值的行为都会塌掉这条区分。

### 14.3 C15 脱敏的最后一处
- notice 路径：已接 `redactMcpServer(..., config.env ?? {})`，并有 **spawn/stderr 失败** 与 **tool-mapping 失败** 两条用例（`test/mcp/manager.test.ts:74-111`）。
- **`dispose` 路径仍裸**（`manager.ts:89-91` `Promise.all(clients.map(c => c.dispose()))`）。**修法**：`clients` 元素改存 `{ name, env, client }`，`dispose` 的错误文本同样过 `redactMcpServer`。
- **pm 补充口径（诚实标注风险等级）**：`StdioMcpClient.dispose()` 自身不拼接 env 文本（只 `kill` + await exit），所以**当前实际泄漏概率低**；但 C15 是「统一过」的**一致性要求**，且未来若在 dispose 里加日志就会立刻变成泄漏面。**按设计执行，不按风险评估打折。**

### 14.4 当前验收状态（HEAD `523ded5` + WIP）
| 面 | 状态 |
|---|---|
| 子线 A 运行时按 bot 过滤（skills/MCP） | 实现完成；AC-7 **校验通过、待终版 HEAD 重核**，不挂账 |
| 子线 B-1 透传（`BotDraft` 三字段 + server/composite 原样透传） | 已提交（`523ded5`），6 例 HTTP 用例绿 |
| 子线 B-2 读路径（`BotInfo` 三字段 + `bots()` 回填） | WIP，已正确实现，待提交 |
| 子线 B-3 C15 脱敏 | notice ✅ / **dispose 待补** |
| 子线 B-4 只读接口（`GET /api/skills`、`GET /api/mcp`） | **未开工** |
| 子线 B-5 写接口（`POST/DELETE /api/skills`、`PUT/DELETE /api/mcp`，成功必须带 `restartRequired: true`） | **未开工** |
| 子线 B-6 Web UI | **未开工**（`web/src/botScope.ts` 是备好的 helper，零调用方） |

**终判规则**：子线 A 与子线 B **分开报**，B 未完成时**不得出「已交付」结论**。

### 14.5 dispose 脱敏：为什么加测试缝（裁决 A）而不是「标注 defensive」
**事实（pm / leader / ci 三方独立复核一致）——⚠️ 以下 1 是「改动前」状态，已过期，仅作裁决依据留档**：
1. ~~`manager.ts:54` 硬编 `new StdioMcpClient({...})`，`ConnectMcpServersInput`（`:28-32`）无注入点 ⇒ 测试塞不进会抛错的假 client。~~
   **→ 改动后**：`ConnectMcpServersInput` 已有 `createClient?`（`src/mcp/manager.ts:38`），内部 `input.createClient ?? ((options) => new StdioMcpClient(options))`（`:49-50`），构造处 `:63`。**当前状态以此为准。**
2. `StdioMcpClient.dispose()`（`client.ts:96-112`）**现实中不抛**：已退出子进程 `kill()` 返回 `false` 不抛，其余只可能 `await exited` 挂起。**（此条改动前后均成立）**
⇒ 改动前 `manager.ts` 的 dispose catch 是**不可达分支**，用真 fixture 造不出异常 —— 这正是加缝的原因。**加缝后该分支可由注入 client 触发，已被用例覆盖。**

**裁决：选 (A) 加测试缝。** 否决 (B)「标注 defensive-untested」。理由：
1. §14.1 的规则就是防这个 —— (B) 等于让 C15 在 dispose 这条上「只有代码没有证据」，并把「不可达所以不测」变成下次偷懒的模板。
2. 加缝**不改生产行为**：`createClient?` 可选、缺省仍是 `new StdioMcpClient`，线上路径逐字节不变。
3. 附带收益：非协议逻辑可快测，不必每条都 spawn 真子进程（当前 185 例约 10.5s）。

**约束（最小化，写死）**：
- 只在 `ConnectMcpServersInput` 增加 **一个** 可选字段 `createClient?: (options: …) => McpClient`，缺省 `new StdioMcpClient(...)`；
- **不得**重构现有 fixture 集成测试，**不得**改动其它输入字段；
- **不得**让该缝出现在协议 / HTTP / 配置文件里 —— 它只是 TS 层的可选参数，`shared/protocol.ts` 不感知；
- 缝的注释必须写明「test seam, defaults to StdioMcpClient」，避免被当生产扩展点。

**用例要求（三条，缺一不算取证）**：
1. 注入 `dispose()` 抛错的假 client（抛出的 error 文本含 env 值）⇒ `notices` 里出现 `mcp <name>: … «redacted»` 且 **不含原值**；
2. `await expect(result.dispose()).resolves` —— **dispose 失败不得 reject**（调用方本就按 non-fatal 处理）；
3. 断言是**读 dispose 之后**的 `notices`（该数组在返回后仍被追加，这是本函数唯一的隐式契约，须有用例钉住）。

**文档归属**：`docs/design/bot-skills-and-mcp.md` 由 **architect 记一行** `ConnectMcpServersInput.createClient?`（测试缝、缺省行为不变），**同时** dev 在 commit message 写明。二者都要，**设计文档为准**（规则：设计文档与实现必须一致，不允许只在 commit message 留痕）。

---

## 15. 文档纳管（docs commit）与两处实测更正（2026-10-17）

### 15.1 为什么 docs 必须入库
`git ls-files docs/` = **7 个旧文件**；本线的 `docs/design/bot-skills-and-mcp.md`、`docs/prd/**`、`docs/deliverables/**`、`docs/research/**` **全部 UNTRACKED**。
⇒ 我们一直在对 **git 从未见过的文档** 做治理：§14.1「有代码无证据不能判绿」在**文档层自我失效**（PRD 改了但没提交，谁都能说"我改了"）。
**规则**：`docs/**.md` 列入允许路径、**不进红线**；必须**独立 `docs: …` commit**，不得与源码混提；落地后 `git ls-files docs/prd/` 必须非空。

### 15.2 更正：`docs-dist/` **不是** `docs/` 的镜像（pm 与 leader 均判断有误）
实测（`cmp` 逐文件比对 + `find`）：
| 事实 | 数值 |
|---|---|
| `docs-dist/**` 文件数 | **14**（全部 `.md`，124K，无二进制、无密钥模式命中）|
| 与 `docs/` 同路径同名且内容相同 | **1**（`research/grok-feature-design-vs-evolution.md`）|
| **`docs/` 中根本没有对应文件** | **13** |
| 其中 `docs-dist/verification/**` | **8 个**，而 `docs/` **完全没有 verification/ 目录** |

⇒ `docs-dist/` 装的是**别条线的独有归档**（bot-context 设计 5 篇、verification 8 篇、research 1 篇），**删了就是永久丢失**；它不是冗余镜像。

**再更正一处（pm 第二次自纠）**：`docs-dist/` **不是全部 untracked** —— 实测 `git ls-tree -r ad3b41a -- docs-dist/` = **9 个已跟踪**（自本线之前就在库里），**仅 5 个 untracked**：
```
?? docs-dist/design/bot-context-and-learning.tasks.md
?? docs-dist/design/web-ui-visual-optimization.prompt.md
?? docs-dist/research/grok-feature-design-vs-evolution.md   ← 与 docs/research/ 同名同内容（唯一真重复）
?? docs-dist/verification/dm-flow-contract.md
?? docs-dist/verification/max-cost-boundary.md
```
所以「docs-dist 只让它留在 untracked」这个说法本身就不完整，**它一直是半跟踪状态**。

**裁决**：
1. **不删**（会丢独有验证记录）；
2. **不并入 `docs/`**（迁移会丢原始路径与出处，且旧引用会断）；
3. **原样补齐 5 个**，作为**第二笔独立 `docs:` commit**（`docs: track the remaining docs-dist archive as-is`），使主 commit 保持「41 个在役文档」的干净边界；
4. **不得**把 `docs-dist/` 写进 `.gitignore`（那是"假装解决"）；
5. **唯一重复项**（`research/grok-feature-design-vs-evolution.md`）**照样跟踪**：它已在库外被引用，删/合并属另案，**本线不动**。

### 15.3 扫描到的**代码侧**噪声（必须与 docs commit 隔离）
| 路径 | 内容 | 处置 |
|---|---|---|
| `package.json` **(M)** | devDependencies 新增 `@playwright/mcp: 0.0.83` | **不得进 docs commit**；**不在本线范围**（`ad3b41a..HEAD` 零改动、无历史），属本地残留改动 |
| `pnpm-lock.yaml` **(M)** | +29/−0（同上依赖） | 同上 |
| `my-agent.json` (??) | ci 本地配置 | 不入库 |
| `.pnpm-store/` (??) | 缓存噪声 | 不入库 |
| `scripts/**` (??) | 非文档（`browser-setup.mjs`、`self-dev/`） | 不入库；另案 |

**红线追加（pm 裁定）**：`package.json` / `pnpm-lock.yaml` 的**未提交改动**属依赖面变更，**在终版统计中必须显式声明"工作区存在与本线无关的依赖改动，未混入任何 commit"**。若它出现在任何一笔 commit 里，**按红线报**。
**归属已查清**：`@playwright/mcp` 来自 `scripts/browser-setup.mjs` 那条线（`git log -S "@playwright/mcp" -- package.json` **无历史**，`ad3b41a..HEAD` 对这两个文件**零改动**）⇒ 属**共享工作区的本地残留**，**不是本线遗留、也不是任何 rob 提交**。dev 明确不动它，ci/review 见到脏树不得据此判本线不合格。

### 15.4 落地状态（2026-10-17 实测）
| 项 | 实测 |
|---|---|
| docs commit | `9b10160 docs: record the R&D design, PRD and delivery artifacts` |
| 范围 | **41 文件 / +6631 / −0**，`grep -v '^docs/.*\.md$'` → **0**（全部 `docs/**/*.md`）|
| 排除项 | `package.json`、`pnpm-lock.yaml`、`my-agent.json`、`docs-dist/`、`scripts/**`、`screenshots/**`、`.pnpm-store/` **均 0 命中** |
| `git ls-files docs/prd/` | **6**（非空，规则达标）|
| 密钥扫描 | `sk-` / `ghp_` / `BEGIN … PRIVATE KEY` / `api_key=` **0 命中** |
| 遗留 | `M docs/prd/bot-skills-and-mcp.md`（**本文 §15 的自纠内容**，未提交，需一笔 `docs:` 补） |

---

## 16. 子线 B 的交付切分与排期（2026-10-17，pm 裁定）

### 16.1 关键结论：B-6 不必等 B-5
原计划顺序是「B-4 只读接口 → B-5 写接口 → B-6 Web UI」。**实测后修正**：
- `PATCH /api/bots` 与 `POST /api/bots` **已能透传三个字段**（`523ded5`，`server.ts:905-915`），`GET /api/bots` **已回显 scope**（`56b8faa`，`team.ts:588-592`）
- ⇒ **「给 bot 勾选 skill / 启用某个已配置 MCP server」这条主链，写路径已经完整**，只缺「全局候选清单」的读接口（`GET /api/skills`、`GET /api/mcp`）
- B-5 的四个写接口（从 UI 里装/删 skill、增删 MCP server **定义**）是**便利性增强**，不是主链前置

**因此排期改为**：`B-4（2 个只读接口）→ B-6a（面板勾选 + 已装清单）→ B-5（写接口）→ B-6b（面板内装/删、MCP server 定义编辑）`
⇒ 用户**最早能看到效果的时点**从「B-5 之后」提前到 **B-4 + B-6a 之后**。

### 16.2 规模估算（供 leader 排期；pm 估算，非承诺）
| 子线 | 内容 | 规模 |
|---|---|---|
| **B-4** | `GET /api/skills`（`discoverSkills()`→`SkillInfo[]`，**不下发 `dir`**，U4）、`GET /api/mcp`（`envKeys` 只回键名） | 小：约 100 行 + 6 用例 |
| **B-6a** | `BotSettingsPanel` 两个区块（skills 勾选 / mcp 勾选 + dirty 标记）、`SettingsDialog` 已装 skill 清单、`useHub` 2 个方法、`botScope.ts` 接线（CLI backend 灰显 + 「由该 CLI 自管」文案）、**移动端契约不破** | 中：约 350–450 行 + 8–10 用例 |
| **B-5** | 4 个写接口 + loopback-only 403 + `PUT/DELETE /api/mcp` 必须带 `restartRequired: true` + 无半装回滚复用 `addSkill/removeSkill` | 中：约 200 行 + 10 用例 |
| **B-6b** | 面板内安装/删除 skill、MCP server 定义增删改 + 「已保存，重启后生效」提示 | 中：约 200 行 + 6 用例 |
**合计约 3–4 个 dev 日**（不含 review/qa/ci 往来）。**B-4 + B-6a 约 1–1.5 日**，即可交付「手机上看得到效果」的最小闭环。

### 16.3 「本线已交付什么 / 手机能感知什么」——对外口径（终判沿用）
**已交付（运行时 + API）**：
1. 配置层：`robs[]` 三个可选字段 + 四态真值表 + `normalizeSkillScope` 单守卫（create/update 共用）
2. 运行时：每 bot 独立 skill 白名单（系统提示与 `load_skill` **同一 turn 快照**一致）、每 bot MCP 工具过滤（`createRob` 一处）
3. 协议：`BotDraft` / `BotInfo` 纯追加（`shared/protocol.ts` +14/−0，零删除）
4. 服务端：`POST/PATCH /api/bots` 原样透传、`GET /api/bots` 回显、写侧归一仅在落盘函数（HTTP 层不做策略）
5. MCP 安全：notice / connect / dispose 三条路径统一 `redactMcpServer`；`createClient` 测试缝（缺省 `StdioMcpClient`）

**手机 UI 上能感知的：零。** 硬证据：`web/src/botScope.ts` 无任何组件引用（唯一引用是 `test/rob/bot-scope-consistency.test.ts`），web 产物与 `ad3b41a` **逐字节相同**（`index-X8xuyzSI.js` 570,444 B / `index-BzkrIWNV.css` 50,230 B）。
⇒ **须向用户明说**：本线交付的是**运行时与 API 能力**，面板 UI（灰显、勾选、已装清单）属 B-6，**不是本轮可见成果**；**已发布移动端无需重新分发**。
**一处运行期行为变更（须进发布说明，§12.10）**：`mcp` 缺省的 bot 从「拿到全部 MCP 工具」变为「零个」（U6 刻意非对称），**非回归**。

**可演示路径（无需等 B-6）**：
1. `my-agent skill add ./test/fixtures/skill-valid` → `my-agent skill list`（表格含 name/package/version/description/path）—— **当前机器 `~/.config/my-agent/skills` 为空，`skill list` 只会打印 `No skills installed.`**，需先装一个
2. `my-agent.json` 的 `robs[].skills` / `mcp` 手写后重启 serve，用 `curl /api/bots` 看回显（**当前 12 个 rob 三字段全缺省，`mcpServers` 为空**，故无内容可看）
3. **不建议**把 1/2 当「效果演示」给用户看 —— 那是配置演示，不是 UI

### 16.4 B-6a 的两条硬约束（leader 2026-10-17 拍板，作为 B-6a 的验收标准）

> 依据：`ad3b41a` 那版移动端适配是用户刚验收过的，**不能回退**；B-4 的脱敏是 C14/C15 的正面要求，**不能只靠"结构上不会"**。

**B-6a-1 移动端契约零改动（硬）**
- `BotSettingsPanel` 新增 UI **只准复用既有类**：`.panel-*` / `.btn` / `.modal-*` / `.field*` / `.dialog-*`。**禁止**引入新类名而不加媒体查询覆盖。
- **禁止**修改 `web/src/styles.css` 中 `@media (max-width: 640px)` 内的**任何既有规则**（当前三处：`:3360`、`:3837`、`:3920`）。
- **禁止**移除或改写以下三处（行号为 `ad3b41a`/`a006169` 实测，报时必须带 HEAD）：
  - `.sidebar.drawer-open` —— **`:3385`**
  - **`.file-panel:not(.mobile-open)` —— `:3397`**（⚠️ **否定选择器**；同区段 `:3394` 还有 `.file-panel.closed`。**不要按 `.file-panel.mobile-open` 正向 grep**，那样查不到任何东西，禁令会空转）
  - `@media (pointer: coarse)` 的 44px 触控段 —— **`:3893`**
  - 附：`@media (max-width: 640px)` 共三处 **`:3360` / `:3837` / `:3920`**；另有 `:3350` 的 880px、`:1091`/`:3914` 的 `hover:none`，同属移动端契约，一并禁改。
- **取证方式（命令写死，勿靠口述）**：
  ```sh
  git diff ad3b41a..<b6a-HEAD> -- web/src/styles.css | grep -E '^@@'
  # 凡 hunk 头落在 3350-3940 区间 → 按红线报
  ```
  新增规则必须落在媒体查询之外，或写成**新增的独立媒体查询块**（不得夹进既有块内）。
- **回归验证**：移动端三态（drawer 开合 / 文件面板开合 / 触控目标 ≥44px）人工或截图复核，**不得只跑单测就判过**。

**B-6a-2 B-4 脱敏必须有用例钉死（硬）**
- `GET /api/skills` → `SkillInfo[]`，**不下发 `dir`**（U4：本地绝对路径不出 wire）。用例：`expect(JSON.stringify(body)).not.toContain(<临时 skills 根目录绝对路径>)`，且逐条 `expect(item).not.toHaveProperty("dir")`。
- `GET /api/mcp` → `McpServerInfo[]`，`envKeys` = `Object.keys(config.env ?? {})`，**只回键名、零值回传**。用例：配置 `env: { DB_PASSWORD: "<sentinel>" }` ⇒ 响应含 `"DB_PASSWORD"`、**不含** `<sentinel>`；断言 `JSON.stringify(body)` 不含 sentinel。
- 两条用例都必须在 **HTTP 层**（`test/serve/*`）跑，**不能只在 `src/mcp/*` 的纯函数单测里测**（依据 §14.1：纯函数绿 ≠ 生产已接）。

**B-6a-3 三字段「省略」而非 `[]`（leader 定为 AC，2026-10-17；pm 补充取证）**
- **规则**：cli backend bot（`backend.kind === "cli"`）与 workspace bot（`kind === "workspace"`）提交 draft 时，三个 scope 字段**必须整体省略**。**发 `[]` 会真的把用户白名单清空**；「省略」才是"默认（全部）"。
- **为什么必须分开处理**：`skills: []` + `skillsConfigured: true` 是**合法的第三态**（用户显式确认"一个都不要"），与"未设置"**语义相反**。面板若把 `undefined` 序列化成 `[]`，等于**替用户做了一次清空决定**，直接翻掉 C9 真值表第 1 行。
- **workspace bot 额外要求**：`kind === "workspace"` 时**不渲染 scope 控件**（不是灰显，是不渲染）—— 否则会把"默认/全部"错误显示成"未启用"，用户会以为自己的 skill 被关掉了。
- **取证（三条，缺一不算）**：
  1. 单测：`backendDraft()` / 面板 submit 构造的 draft，对 cli 与 workspace 两态均断言 `expect(draft).not.toHaveProperty("skills")`（三字段各一条）；
  2. 单测：切到 cli 再切回 native，draft 仍不含三字段（**不得**因切换而写入 `[]`）；
  3. 集成：cli/workspace bot 走一遍 `PATCH /api/bots/:bot`，读回 `my-agent.json` 后 `skills` 仍为 `undefined`（**不是 `[]`**）。
- **依据**：`BotInfo.kind` 已是 `"workspace" | "rob"`（`shared/protocol.ts:39`），`botScope.ts` 覆盖 backend 维度；本条约定的 `kind` 维度**需在 B-6a 一并加进 `web/src/botScope.ts`**（或在面板内单独判定），并补 `test/rob/bot-scope-consistency.test.ts` 的一致性用例。

### 16.5 两条 non-blocking 记档（review 提出，pm 判定：本线不修，留待后续）
| # | 现象 | 判定 | 理由 |
|---|---|---|---|
| 1 | **脱敏过度替换**：`DEBUG:"true"` 这类普通值也被换成 `«redacted»` | **接受，不修** | 方向是安全侧；代价是可诊断性下降。收敛成「像密钥的值」需要一套启发式规则，本身就会引入漏判风险，**不属本线范围** |
| 2 | **截断片段泄漏**：若错误文本只回显 env 值的**片段**（如前 8 字符），替换方案不命中 | **接受，不修** | 值替换方案的固有限制；彻底解决要改 `StdioMcpClient` 的错误整形，属连接层改动，与 §3.3「只做可见性过滤」冲突 |
**两条都不得作为终判阻塞项**；但**必须写进交付说明**，否则等于隐瞒已知限制。

### 16.6 终判前最后一项（pm 自查）
当前工作区 `M docs/prd/bot-skills-and-mcp.md` = 本节 §13.4a + §16.4 + §16.5 + §16.6 原文（29+ 行）。**这笔 docs 未提交前，HEAD 不是真终版**；提交后再由 ci 跑五步。
