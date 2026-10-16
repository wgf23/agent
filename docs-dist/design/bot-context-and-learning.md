# Bot 的上下文选择与持续学习设计

> 状态：**提案 v0.1** ｜ 日期：2026-10-16 ｜ 归属目录：`docs-dist/`
> 范围：bot 机制（上下文组装、记忆巩固、检索、账本与后端接线），不含 UI。
> 面向两个问题：① bot 不分 session、上下文只增不减，该选哪部分发给模型？② 持续工作中如何持续学习？

## 0. 结论（TL;DR）

1. **把「历史」从存储问题改造成检索问题**：每回合组装一个固定预算的上下文包（system+记忆 → 本线程近窗 → 线程滚动摘要 → 按相关性检索的久远条目）。
2. **给 bot 显式线程（thread）而不是靠隐式续写**：线程是上下文的组织单位，**记忆（memory）仍全局**。
3. **学习 = 回合后的「巩固（consolidation）」旁路**：从刚落地的回合抽取 fact/preference/commitment（含 skill 候选），过既有 cap/幂等/可审 的 memory 通道。
4. **一切有界、可查、可逆**：学习产物有条目/字符上限、有来源(provenance)、能 decay、能在既有 memory 面板/接口查看与清除。

## 1. 现状（代码级事实）

| 事实 | 位置 | 后果 |
|---|---|---|
| bot 账本按 bot 名存 `turns`（环形，`MAX_RING_TURNS=24`）+ `memory`（`MAX_MEMORY_ENTRIES=128` / `MAX_MEMORY_CHARS=24_000`） | `src/bot/schema.ts`、`src/bot/store.ts` | 账本有界，但被环挤掉的 turn 只留一行机械 digest（取首条 user 文本截断），信息损失大 |
| 每回合发给模型的 `history` = `replay(账本 turns，按 workspace + 当前 channel/sessionId 过滤)` | `src/rob/rob.ts` | 单个 session 内 `history` 随回合单调增长 |
| 会话（channel）是纯内存标签，`openChannel()` 只清 `history` | `src/bot/channel.ts`、`src/rob/rob.ts` | 「不分 session」的观感来源 |
| run 内仅 `trimForBudget` 只裁剪旧 tool 输出 | `src/agent/context.ts` | 对话本体永不收缩 |
| `compact.ts` 只接到 CLI/TUI（`runHeadless`），native rob 后端没传 `compaction` | `src/cli/run.ts`、`src/rob/backend.ts` | bot 路径没有自动压缩 ← 直接根因 |
| 记忆每回合渲染成 systemNote 注入 | `src/rob/rob.ts`、`src/bot/record.ts` | 记忆已是一等注入，是「学习」的落点 |

## 2. 问题一：上下文该「选」哪部分

### 2.1 分层预算组装

新增纯函数 `assembleContext(...)`（`src/bot/context.ts`），每回合产出有界消息序列与本回合选了什么。总预算 = 模型窗口 − 输出预留；各层固定配额，超了从低优先层裁：

| 层 | 内容 | 生命周期 | 裁剪优先级 | 预算（示例） |
|---|---|---|---|---|
| L0 身份 | system + role + roster + 渲染后的 memory | 永久 | 不裁 | ≤ 8k |
| L1 近窗 | 本线程最近若干回合完整消息（保 tool_call↔result 成对、按 user 回合切界，复用 `splitForCompaction`） | 线程内 | 最后裁 | ≤ 40% |
| L2 线程摘要 | 本线程滚动摘要 | 线程内 | 较少裁 | ≤ 20% |
| L3 检索 | 从账本/记忆中按相关性取回的久远片段 | 全局 | 先裁 | ≤ 20% |
| L4 本回合输入 | 本轮 inbound | 单回合 | 不裁 | — |

输出 `{ messages, layers, dropped }`，可直接喂 `runAgent` 并作为事件暴露。

### 2.2 线程滚动摘要（替代一次性 compact）

- 每线程一份 `summary`（决策 / 未决问题 / 产物路径 / 学到的事实），有字符上限。
- 触发：超阈时把最旧一段折进 summary，增量更新；一次无工具摘要调用。
- 落盘：summary 随产出它的那次 commit 原子写入账本；线程 id 复用 `channelId`。
- 复用 `summarizeMessages` / `splitForCompaction`，但接到 rob 后端。

### 2.3 检索层（L3）如何选

- **v0 确定性零依赖**：按 (a) 关键词/路径交集、(b) 时间新近、(c) 类型权重（commitment > preference > fact > digest）打分取 top-k。
- **v1 语义检索**：embedding，可由账本重建，索引可丢可重算。
- 检索是纯函数、输入是 store → 同一 store 必产出同一上下文，可回放可测。

### 2.4 「线程」语义

- 一个唤醒源 = 一个线程：DM / room / interval / user。
- 换线程只切 L1/L2，L0/L3（记忆+检索）仍全局。

## 3. 问题二：持续学习

### 3.1 三类要学的东西

| 类型 | 载体 | 现状 | 目标 |
|---|---|---|---|
| 语义记忆 | `memory`：fact/preference/commitment | 靠模型回合中显式 `remember` | 回合后自动抽取 + 检索注入 + 衰减 |
| 情节记忆 | 账本 `turns` + digest | 有界，digest 太粗 | 提高 digest 保真 |
| 程序/技能 | 尚无 | — | 从重复流程提炼 skill 候选，命中时注入 |

### 3.2 巩固旁路

新增 `src/bot/consolidate.ts`：一次便宜反思调用，输入 = 刚落地的 turn + 线程 summary 指针，输出 `{ memoryUpserts[], threadSummary, skillCandidates[] }`，然后：

1. 走同一条 `applyMemoryDelta`（cap/幂等/supersede 复用），带 `provenance = { sessionId, turnSeq }`。
2. 幂等：同一 turn 反复巩固 → 同一结果（用 turn id 派生确定性 id，与 `digestFor` 同法）。
3. 可审：默认自动写入 + 审计痕迹 + 面板可清除；高风险可走审批。
4. 失败绝不阻塞回合（旁路、有预算、可跳过）。

### 3.3 学习闭环

```text
Observe(turns) → Consolidate(抽取 memory/skill) → Retrieve(注入相关) → Act → Evaluate →（回到 Consolidate）
```

- Evaluate 抓手：每条 memory 增加 `uses` / `lastUsedAt` / `confidence`；再次确认则升，长期未用或被 supersede 则降/淘汰。
- 技能晋升：`candidate → reusable`（N 次成功）；失败则 `deprecated`。
- 有界自愈：淘汰顺序 = digest → 低置信/久未用 → 才轮到 pinned fact。

### 3.4 治理

有界、可溯源、可逆、可观察；学习写入与用户数据同目录、明文；不引入外部服务（embedding 可选）。

## 4. 接口草图

```ts
// src/bot/context.ts（新）
interface ContextBudget { totalTokens: number; quotas: { l1: number; l2: number; l3: number }; }
interface AssembledContext {
  messages: Message[];
  layers: { l0: number; l1: number; l2: number; l3: number; l4: number };
  dropped: { layer: string; reason: string }[];
}
function assembleContext(input: {
  record: BotRecord; thread: ThreadView; inbound: readonly Inbound[];
  workspaceRoot: string; budget: ContextBudget;
}): AssembledContext;

// src/bot/schema.ts（扩展，version++）
// memory entry += { uses: number; lastUsedAt: number; confidence: number }
// record += { threads: Record<threadId, { summary: string; summaryAt: number }> }

// src/bot/consolidate.ts（新）
function consolidate(deps: { provider; model; clock }): (turn: Turn, thread: ThreadView) => Promise<MemoryDelta>;
```

接线：`src/rob/rob.ts` 的 `runOnce` 用 `assembleContext` 取代裸 `this.history`；commit 后 enqueue `consolidate`（旁路，不 await 进回合）。`src/serve/*` 暴露线程摘要与检索命中（只读）。

## 5. 验证（可验证定义）

| 不变量 | 测法 |
|---|---|
| 增长有界：任何回合数下单次上下文 token ≤ 预算 | 属性测试：回合数 10→1000，断言 `estimateTokens(assembleContext(...).messages)` 恒 ≤ 预算 |
| 久远可召：100 回合前、已出近窗的事实仍能进上下文 | fixture：写 fact → 灌 100 回合 → 断言 L3 命中该 fact |
| 线程隔离、记忆全局：换线程 L1/L2 清空但 L0/L3 保留 | 断言换线程后 memory 仍在、近窗为空 |
| 巩固幂等：同一 turn 巩固两次 = 一次 | 应用两次 delta，store byte-equal |
| cap 不破：淘汰先 digest，pinned 事实最后 | 灌满 + 溢出，断言顺序与上限 |
| 可回放：同一 store → 同一 assembleContext 输出 | 快照比对 |
| 无回归：现有 test/bot + test/rob 全绿 | 全量跑 |

## 6. 分阶段

- **P0 定义与纯函数**：`assembleContext` + 预算/分层单测（先证明有界）。
- **P1 接 rob 后端**：runOnce 用组装结果替换裸 history；`compaction` 语义并入线程滚动摘要。
- **P2 巩固旁路**：`consolidate` + memory 扩展字段 + 面板/接口可查；幂等与 cap 测试。
- **P3 检索层**：v0 关键词/类型打分 →（可选）v1 embedding。
- **P4 技能/程序记忆**：skill 候选与晋升/弃用。

## 7. 已定取舍

- 给上下文分线程、给记忆不分线程。
- 滚动摘要而非一次性 compact、检索而非全量重放。
- 巩固默认自动 + 可审可逆，不默认弹审批。
- v0 检索不引入向量库。

## 8. 开放问题

- 线程切分键：仅唤醒源，还是「唤醒源 + 话题漂移检测」？
- 记忆 schema 扩展是否升版与迁移（现 `version:1`）？
- 巩固调用的成本是否计入 bot `usage`（建议计，但不进「最近一次上下文估算」）。
