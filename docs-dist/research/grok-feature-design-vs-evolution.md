# Grok 功能设计对比 + 演进方向（合并稿）

> 状态：**v1.4** ｜ 作者：rob "aaa"（数据调研bot）｜ 分工：正文 aaa；测试用例 pi-test（pi 侧）+ test（DM/验收/边界）
> ｜ 决策：leader 已拍板架构线走 **① 团队工具 MCP server 化** ｜ 日期：2026-10-16
>
> **来源**：本稿**不新增联网结论**，合并本仓库既有文档：
> - `docs/research/grok-ui-design.md`（UI 设计 + §6 对本项目映射）
> - `docs/research/grok-vs-cli-agent-architecture.md`（架构归因 + §5 演进方向）
>
> 并对照 `docs/design/web-client.md`（M0–M5）与**已落地的 `src/rob/gateway/`**。
> Grok 侧未联网核实的细节仍标 **⚠️**；本仓库侧结论均为**代码级事实**（附 `文件:行`）。

> **v0.1 → v0.2 变更（重要，v1.0 沿用）**：架构线前提已更新。
> 旧稿称「CLI 仅桥接 read/write/edit/bash、团队工具全部不可用、CLI bot 回不了 DM」——这是 **gateway 落地前（2026-10-15 之前）的旧事实，已 stale**。
> 现状：`src/rob/gateway/`（wire + socket server + pi bridge extension + opencode/claude 的 team MCP shim）已把 `turn.bridge.tools`
> 送进 **pi / opencode / claude** 三个 CLI 子进程，CLI bot **能回 DM**。工具集亦变更：`list_robs`/`read_messages` **已不是工具**
> （roster 走 preamble、消息走 inbox）；当前团队工具 = **`send_message` + `delegate`**（房间内另有 `room_reply`）。

---

## 0. 一句话结论

Grok 对本项目最有价值的启发收敛为三条**可在现有事件与组件上落地**的 UI 动作：
**① 深色优先的令牌化主题**、**② Composer 内联 backend/model 芯片**、**③ `reasoning_delta` 折叠思考块**。
架构线方向已定：**走「团队工具 MCP server 化」**（leader 拍板），且该方向在本仓库**已落地大半**，P0 工作从「接线」转为**核验后端桥接覆盖面**。

---

## 1. 功能设计对比表（Grok vs my-agent 现状）

| 维度 | Grok 的做法 ⚠️ | my-agent 现状（代码级） | 差距 | 优先级 |
|---|---|---|---|---|
| 主题/色彩 | 黑白极简、**深色默认**、彩色极克制 | 已有浅/深主题令牌（`web/src/styles.css`），默认偏浅 | 把**高对比深色提为一等默认** | **P0** |
| 思考过程 | "Thought for Ns" **可折叠** | 已有 `reasoning_delta` 事件源，未做折叠块 | 渲染为默认折叠的 Think 块（流式中展开、完成后收起） | **P0** |
| 工具调用可视化 | 内联步骤卡 + 实时状态 | 已有 `tool_started`/`tool_finished`，渲染 **ok/error/blocked** 三态 | 基本对齐 | ✅ 已具备 |
| Composer 模式选择 | 输入框旁**模式 chip**（Fast/Think/DeepSearch/Imagine） | `model`/`backend`（native/pi/opencode）藏设置页 | 做成**就地切换芯片** | **P1** |
| 检索来源 | 编号上标引用 + 来源脚注列表 | 暂无 web 检索来源渲染 | 接检索后仿其做可点击脚注 | **P1** |
| 记忆可见可控 | 设置里可查看/清除/开关跨会话记忆 | 已有 `BotMemoryPanel` | 方向正确，可补「它记得什么」摘要入口 | **P1** |
| 空状态 | 大标题 + 居中提问框 + 建议 chip | 已有 | 保持，可选建议 chip | P1（低） |
| 流式/中断/重试 | 逐 token + Stop + 手动上滑暂停 | 已实现流式+停止+插话（`web-client.md` 偏差节） | 对齐，无缺 | ✅ 已具备 |
| 语音 | 全屏语音 orb / 波形 | 无 | 远期参考全屏 orb，非嵌入式播放器 | **P2** |
| 长文 Canvas | 右侧分栏迭代编辑 | 无 | 远期 | **P2** |
| 深度搜索可视化 | 步骤面板 + **知识图谱** | 无 | 依赖检索能力，远期 | **P2** |
| X 内嵌 Grok | 帖子卡片 + 上下文内联调用 | 无 X 场景；理念可映射到 DM/Bot 广场 | 理念对齐（低唤起成本入口） | P2（理念） |
| **多 agent 互调/互聊** | loop 与注册表**同归服务端权威** → agent ≡ tool 同构 ⚠️ | **native** 与 **CLI（pi/opencode/claude）** 均已通过 `turn.bridge.tools` 拿到团队工具；CLI bot **能收 DM 也能回 DM** | 桥接覆盖面**待核验**（opencode/claude MCP 加载是否真通）；claude 交互审批未桥接 | **P0**（核验） |
| 有界编排 | Heavy 一次性广播+仲裁 ⚠️ | `MAX_DELEGATE_DEPTH=1`、`DM_LIMIT_PER_RUN=20`、`runDiscussion` 收敛 | 容量边界待压测 | **P2** |

> 架构线现状（代码级事实）：`src/rob/gateway/` 提供 wire + socket server + shim，
> `turn.bridge.tools` 被四个后端消费——`backend.ts:72,87`（native）、`cli-backend.ts:99,126`（pi）、
> `opencode-backend.ts:367`、`claude-backend.ts:118`。roster 经 preamble 注入（`backend.ts:68-73`），
> 不再是 `list_robs` 工具。**「谁拥有 loop」与「谁能被调用」已在 gateway 层重新对齐**，与 Grok 的同构一致。

---

## 2. 演进方向（P0 / P1 / P2）

### P0 · 低风险、复用现有事件/组件（建议先做）

| # | 动作 | 依据 | 成本 |
|---|---|---|---|
| P0-1 | **深色优先令牌**：把高对比深色提为一等默认主题 | `grok-ui-design.md` §6 | 低 |
| P0-2 | **折叠思考块**：`reasoning_delta` → 默认折叠的 Think 块 | `grok-ui-design.md` §6 | 低 |
| P0-3 | **核验后端桥接覆盖面**（架构线，方向①已落地，本项为**验收**）：实测 **opencode / claude 的 MCP 加载是否真通**（pi 走 `pi.registerTool` 已通，`shims.ts:156`）；确认三后端都能 `send_message`/`delegate`。**已知边界**：claude 交互审批未桥接（`claude-backend.ts:80-83`，ask 视同 deny）。 | gateway 落地（`shims.ts`、`cli-backend.ts:99`、`opencode-backend.ts:367`、`claude-backend.ts:118`） | 中（实测为主） |
| P0-4 | **DM 往返回归用例（正向）**：CLI bot **收 DM → 能 `send_message` 回复**；守护 native/CLI 两条后端不回归。 | gateway 现状 | 低（测试侧） |

### P1 · 中等成本、需新增接线

| # | 动作 | 依据 | 成本 |
|---|---|---|---|
| P1-1 | **Composer 内联 backend/model 芯片**，替代「藏进设置页」 | `grok-ui-design.md` §6 | 中 |
| P1-2 | ~~团队工具 MCP server 化（方向①）~~ → **已落地，并入 P0-3**，不再作为待选项 | gateway | — |
| P1-3 | **检索来源脚注列表**（接 web 检索后） | `grok-ui-design.md` §6 | 中 |
| P1-4 | **记忆摘要入口**：「它记得什么」一览 | `grok-ui-design.md` §6 | 低 |

### P2 · 大成本 / 边界与远期

| # | 动作 | 依据 | 成本 |
|---|---|---|---|
| P2-1 | **有界编排压测**：`delegate` 深度、`--max-cost` 边界、`DM_LIMIT_PER_RUN` 触发行为 | `src/rob/tools.ts:18-20` | 中（测试侧） |
| P2-2 | **③ 收回 loop（把外部 CLI bot 当一个工具调用）**：**降为 P2 研究项，不做**。理由：丢失外部 CLI 的**自主多轮**能力，代价不可接受；方向①已达成目的。 | 架构稿 §5 方向3；leader 决策 | 高（不排期） |
| P2-3 | **语音 orb / Canvas 分栏 / DeepSearch 图谱** 等纯 UI 远期项 | `grok-ui-design.md` §3.6–3.7 | 高 |

---

## 3. 决策记录（leader 拍板 2026-10-16）

- **走 ①「团队工具 MCP server 化」**。理由：既保住 CLI 外部 loop 的自主多轮，又让注册表重新对齐——正是 Grok「loop 与注册表同归权威」的同构；而 ③ 要丢弃自主多轮，不可接受。
- **② 不单列**：其 ⚠️「pi extension 能否注册新工具」已被证伪为**能**（`gateway/shims.ts:156` `pi.registerTool({...})`），故 ② 只是 ① 在 pi 无 MCP 加载路径时的**等价实现**，不构成独立方向。
- **③ 降为 P2 研究项，不做。**
- 过期用例：`test/rob/cli-backend-team-tools-gap.test.ts`（未跟踪）在 gateway 落地后**已过期且失败**（3 挂 2，断言旧 gap），**不可当守护用例**，已改由 pi-test 重写该 pi 侧用例（`cli-backend` 用例归 pi-test）。
> 分工澄清：**pi-test** 负责 pi 侧（`cli-backend`）用例重写；**test** 专注 DM 往返 + claude 验收 + `--max-cost`。

---

## 4. 分工与交付

- **正文（本稿 v1.4）**：aaa。
- **测试用例**：
  - **P0-4**（test）：CLI 后端 **`send_message` 回复 DM** 的**正向**回归（改写自过期用例）。
  - **P0-3**（test）：opencode / claude MCP 加载实测的验收记录。
  - **P2-1**（test）：`--max-cost` 边界用例；`delegate` 深度由 pi-test / opencode 分头覆盖。
  - **pi 侧**（pi-test）：`test/rob/cli-backend-team-tools-gap.test.ts` 重写为对当前 bridge 契约的 golden test。

## 5. 待核实（沿用既有 ⚠️ 清单，不重复展开）

- Grok 模式选择器命名、快捷键、Voice/Imagine/Canvas 文案 → `grok-ui-design.md` §8。
- opencode / claude 的 MCP 加载能力（P0-3 实测项）→ 架构稿 §7。
- 联网恢复后统一核实，见 `docs/research/verification-url-checklist.md`。

## 6. 证据（引用，不并入）

> 分层约定：**总稿只引用，细节留切片**。总稿不复制证据正文；复现命令与代码级细节以各切片文件为准。

| 切片（docs-dist/verification/） | 对应 | 复现用例 | 结论（绿） |
|---|---|---|---|
| `opencode-backend-team-bridge.md`（opencode） | P0-3 正向参照 | `test/rob/opencode-backend.test.ts` | opencode 经 MCP shim 注入 `send_message`/`delegate` + 团队 socket 回连；**33/33（含 3 条 once/边界）** |
| `claude-team-mcp.md`（test） | P0-3 claude 侧 MCP 验收 | `test/rob/claude-backend.test.ts` | `--mcp-config`→`node team-mcp.mjs` 加载团队工具并回连真网关；边界=内置 ask 视同 deny、团队工具由网关代答；26/26 |
| `dm-roundtrip-cross-backend.md`（test） | P0-4 跨后端 DM 往返 | `test/rob/team-dm-roundtrip.test.ts` | CLI bot 收 DM 能 `send_message` 回信，native/CLI 往返一致；**DM-only turn 无 `room_reply` 是契约**；3/3 |
| `dm-flow-contract.md`（dmtest） | P0-4 DM 侧契约层 | `test/rob/team-rooms.test.ts` | `room_reply` 逐回合可见（DM-only 无、room 回合有，`team.ts:775-782`）+ `send_message`/`postDm` 双向落日志；team-rooms 11/11、team 16/16、inbox 3/3 |
| `max-cost-boundary.md`（test） | P2-1 `--max-cost` 边界 | `test/agent/cost.test.ts` | 非严格（>）、步界生效、未定价模型恒 0、未设则无界；8/8 |
| `cli-backend-team-bridge.md`（pi-test） | P0-3 pi 侧 golden | `test/rob/cli-backend-team-tools-gap.test.ts` | pi 经 `--tools`+`pi-extension.mjs` 暴露 `send_message`/`delegate`、childEnv 透传 socket；3/3（`test/rob` 全目录 22 文件/245 用例绿） |

- 说明：本总稿**只引用**上述证据文件，**不并入**其正文；证据的复现命令与代码级细节以各切片为准。
- **口径修正**：`docs/research/cli-backend-team-tools-gap.md`（旧稿「CLI 子进程拿不到任何团队工具」）**已过期**，替代切片见 `docs-dist/verification/cli-backend-team-bridge.md`。

## 7. 相关设计（交叉引用，不并入）

- `docs-dist/design/bot-context-and-learning.md`（test owner；上下文分层组装 + 巩固旁路学习）——**主题独立，本总稿只引用不并入**。

---
*v1.0（2026-10-16）：按 leader 复核意见定稿（分工澄清 + 证据引用）。v0.2 更新架构线前提（gateway 已落地、CLI bot 能回 DM、工具集=`send_message`+`delegate`+`room_reply`），重排 P0-3/P0-4/P1-2/P2-2；v0.1 合并 `grok-ui-design.md` §6 与 `grok-vs-cli-agent-architecture.md` §5。*
*v1.1（2026-10-16）：§6 回填 test 交付的 3 份证据（claude 侧 P0-3、DM 往返 P0-4、`--max-cost` P2-1），采「总稿只引用、细节留切片」分层；§4 P2-1 分工已与 leader 锁定一致。*
*v1.2（2026-10-16）：§6 表头加「复现用例」列；opencode 行数字修正为 **33/33（含 3 条 once/边界）**；回填 pi-test 的 pi 侧切片 `cli-backend-team-bridge.md`（第 5 行）；标注旧稿 `docs/research/cli-backend-team-tools-gap.md` 已过期。*
*v1.3（2026-10-16）：回填 dmtest 的 DM 契约层切片 `dm-flow-contract.md`（第 6 行，P0-4；team-rooms 11/11：`room_reply` 仅 room 回合绑定、DM 双向 ack）。§6 增至 6 行，全链闭环。*
*v1.4（2026-10-16）：新增 §7「相关设计（交叉引用，不并入）」→ `docs-dist/design/bot-context-and-learning.md`（test owner）。正文与 §6 未动，主题不同，不并入。*
