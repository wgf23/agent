# Bot 上下文选择与持续学习 —— 需求拆解与任务派发

> 来源设计稿：`docs-dist/design/bot-context-and-learning.md`（提案 v0.1）
> 本文用途：把该机制拆成 **提示词 / 需求(R) / 任务(T) / 派发矩阵 / 单任务模板 / Done 定义**，直接派发给执行 agent。
> 范围：仅 bot 机制（上下文组装、记忆巩固、检索、账本与后端接线）。**不含任何 UI / 前端内容。**

---

## 一、主提示词（可整段发给执行 agent）

```text
## 你是谁
你是同时具备「后端/系统设计 + TypeScript 工程 + QA」能力的编码 agent，负责在仓库 /home/heiwa/my-agent 里
实现 bot 的「上下文选择 + 持续学习」机制。你不改 UI，不做前端。结论与实现都必须由代码事实与测试支撑。

## 目标
按 docs-dist/design/bot-context-and-learning.md（提案 v0.1）落地：
1) 把 bot 的「历史」从存储问题改造成检索问题：每回合组装一个固定 token 预算的上下文包；
2) 给 bot 显式上下文「线程」，但记忆保持全局；
3) 学习 = 回合后的「巩固（consolidation）」旁路，写入既有 memory 通道（cap/幂等/可审 复用）；
4) 全程有界、可查、可逆、可回放。

## 必读（先读，别猜）
- 设计稿：docs-dist/design/bot-context-and-learning.md（§1 现状、§2 上下文、§3 学习、§4 接口、§5 验证、§6 阶段、§7 取舍）。
- 现有代码：
  - src/bot/schema.ts（BOT_RECORD_VERSION=1；MAX_RING_TURNS=24 / MAX_MEMORY_ENTRIES=128 / MAX_MEMORY_CHARS=24000 / MAX_MEMORY_TEXT=2000）
  - src/bot/record.ts（applyMemoryDelta / reconcileRing / renderMemory / replay / digestFor）
  - src/bot/store.ts（load / commit / saveMemory 的原子写与串行链）
  - src/bot/channel.ts（内存态 channel 标签，只 open/close/focus）
  - src/rob/rob.ts（runOnce：loadRecord → memoryBlock=renderMemory → backend.run({history}) → commit(record, turn, delta)）
  - src/rob/backend.ts（NativeBackendOptions 无 compaction；runAgent 收到 history: [...turn.history]）
  - src/agent/compact.ts（estimateTokens / shouldCompact / splitForCompaction / summarizeMessages，可复用）
- 既有测试：test/bot/**、test/rob/**（约 245 条，改动后必须回归）。

## 硬约束
- 不许改 shared/protocol.ts 的既有语义；不许改前端 web/**。
- 账本 schema 若要升版必须提供迁移（现 version:1 → 升 2），老文件必须仍能 load。
- 一切新增学习产物必须**有界**（entries/chars 硬上限）、**有来源 provenance**、**可逆**（可 forget/清空）。
- 巩固是旁路：失败绝不阻塞回合，有独立预算，可跳过。
- 幂等：同一 turn 巩固两次 == 一次；同一 store 必产出同一 assembleContext 输出（可回放）。
- 不得删改既有测试来"过测试"；有问题改实现。
- 回归门槛：pnpm test / pnpm typecheck / pnpm lint 全绿。

## 反模式
- 引入向量库/外部服务（v0 明确零依赖，embedding 仅作可选升级）。
- 让 bot 的 history 继续无限增长，或直接把整个 transcript 塞给模型。
- 把「线程」实现成彼此隔离的人格（记忆必须全局）。
- 巩固调用同步 await 进关键路径，或失败就让整个回合失败。
```

---

## 二、需求清单（R：验收视角）

| ID | 需求 | 验收证据 |
|---|---|---|
| R1 | **增长有界**：无论账本多少回合，单回合上下文 token ≤ 预算 | 属性测试：回合数 10→1000，`estimateTokens(assembleContext(...).messages)` 恒 ≤ 预算 |
| R2 | **久远可召**：100 回合前、已出近窗的事实仍能进上下文 | fixture：写 fact → 灌 100 回合 → 断言 L3 命中该 fact |
| R3 | **线程隔离、记忆全局**：换线程 L1/L2 清空但 L0/L3 保留 | 断言换线程后 memory 仍在、近窗为空 |
| R4 | **巩固幂等**：同一 turn 巩固两次 = 一次 | 应用两次 delta，store byte-equal |
| R5 | **cap 不破**：淘汰先 digest，pinned fact 最后 | 灌满+溢出，断言淘汰顺序与上限 |
| R6 | **可回放**：同一 store → 同一 assembleContext 输出 | 快照比对 |
| R7 | **无回归**：现有 test/bot + test/rob 全绿 | 全量跑输出 |
| R8 | **provenance 与可逆**：每条学习产物有来源、可 forget | API/函数可查可清，测试断言 |
| R9 | **提升 digest 保真**：被环挤掉的 turn 保留决策/产物/来源，而非首行截断 | digest 单测：含非首条 user 信息的断言 |
| R10 | **可观测**：分层的 included/dropped 作为只读事件/接口暴露 | 事件或只读路由输出 layers{} |

---

## 三、任务分解（T：派发单元）

> 通用约定：只改自己名下的文件；每步先写测试再改实现（仓库风格）；不 await 进关键路径的东西不放关键路径。

### Wave 0 — 前置（串行）

**T0 现状固化 + 契约测试（基线）**（S，阻塞）
- 目标：在不改行为的前提下，给现有 bot 路径补"现状快照"测试，作为后续重构的安全网。
- 覆盖：`replay` 的 workspace/session 过滤、`applyMemoryDelta` 的 cap/幂等、`reconcileRing` 的 digest 行为、`commit` 的原子性。
- 产出：`test/bot/*.test.ts` 新增用例（只增不改）；一份「现状事实清单」（对齐设计稿 §1 的表格并核对）。
- 验收：新增用例全绿，且能复现「native rob 无 compaction、history 单调增长」的现状。

**T1 接口冻结（纯类型 + 文档）**（S，依赖 T0）
- 目标：把设计稿 §4 的接口草图落成**不带实现**的类型/签名，全组按此对齐。
- 产出：`src/bot/context.ts` 内 `ContextBudget` / `AssembledContext` / `assembleContext` 签名；`src/bot/consolidate.ts` 内 `consolidate` 签名；schema 扩展字段的类型草案。
- 验收：`pnpm typecheck` 通过（允许 stub），全组 review 签名冻结。

### Wave 1 — 核心机制（可并行，文件不重叠）

**T2 `assembleContext` 纯函数 + 分层预算（P0）**（M，依赖 T1；独占 `src/bot/context.ts`）
- 目标：实现 L0 身份 / L1 近窗 / L2 线程摘要 / L3 检索 / L4 本回合输入 的固定配额组装与超限裁剪，输出 `{ messages, layers, dropped }`。
- 复用：`splitForCompaction`（保 tool_call↔result 成对、按 user 回合切界）、`estimateTokens`。
- 产出：`src/bot/context.ts` + `test/bot/context.test.ts`（R1/R6 的不变量）。
- 验收：属性测试证明增长有界；同输入同输出。

**T3 检索层 L3（v0 确定性打分）**（M，依赖 T1；独占 `src/bot/retrieve.ts`）
- 目标：按 (a) 关键词/路径交集、(b) 时间新近、(c) 类型权重（commitment > preference > fact > digest）打分取 top-k。
- 约束：纯函数、输入是 store（可回放、可测），零依赖。
- 产出：`src/bot/retrieve.ts` + `test/bot/retrieve.test.ts`（R2）。
- 验收：100 回合前的事实仍被召回；排序符合权重定义。

**T4 schema 扩展 + 迁移（version++）**（M，依赖 T1；独占 `src/bot/schema.ts`）
- 目标：memory entry += `{ uses, lastUsedAt, confidence }`；record += `{ threads: Record<threadId,{ summary, summaryAt }> }`；`BOT_RECORD_VERSION` 升 2 并提供 version:1 → 2 的迁移。
- 产出：schema 改动 + 迁移函数 + `test/bot/schema.test.ts` / store-load 迁移测试。
- 验收：老 version:1 文件可 load 并被迁移；新字段有默认值。

**T5 线程滚动摘要（替代一次性 compact）**（M，依赖 T2,T4；独占 `src/bot/thread-summary.ts`）
- 目标：每线程一份 summary（决策/未决问题/产物路径/学到的事实），超阈时把最旧一段折入，**增量更新**；随产出它的那次 commit 原子落盘；线程 id 复用 `channelId`。
- 复用：`summarizeMessages` / `splitForCompaction`。
- 产出：模块 + `test/bot/thread-summary.test.ts`。
- 验收：增量更新（非全量重算）、崩溃安全（随 commit 原子）、有字符上限（R5 相关）。

**T6 巩固旁路 `consolidate`（P2）**（M，依赖 T1,T4；独占 `src/bot/consolidate.ts`）
- 目标：一次便宜的"反思"调用 → `{ memoryUpserts[], threadSummary, skillCandidates[] }`；走**同一条** `applyMemoryDelta`；带 `provenance={sessionId,turnSeq}`；turn id 派生确定性 id 保幂等；失败不阻塞回合。
- 产出：模块 + `test/bot/consolidate.test.ts`（R4/R8）。
- 验收：同 turn 两次巩固 byte-equal；高风险覆盖 pinned commitment 走审批（可配）。

### Wave 2 — 接线（P1，串行于机制之后）

**T7 接 rob 后端（P1）**（M，依赖 T2,T3,T4,T5；独占 `src/rob/rob.ts`、`src/rob/backend.ts`）
- 目标：`runOnce` 用 `assembleContext` 取代裸 `this.history`；把 `compaction` 语义并入线程滚动摘要（bot 路径首次获得压缩）；commit 后 **enqueue** `consolidate`（旁路，不 await 进回合）。
- 约束：不动 room/team 语义；abort/max-steps 仍**恰好一次**记录 turn。
- 产出：接线 diff + `test/rob/` 回归 + 新增接线用例（R3/R7）。
- 验收：现有 test/rob 全绿；新增用例证明 build 路径拿到了组装后的 messages 与摘要。

**T8 digest 保真提升**（S，依赖 T4；独占 `src/bot/record.ts`）
- 目标：被环挤掉的 turn 保留决策/产物/来源，而非只取首条 user 截断；与 digest 幂等 id 派生规则保持一致。
- 产出：`digestFor` 改造 + `test/bot/record.test.ts` 增强（R9）。
- 验收：非首条信息（如产物路径/末条 assistant 决策）进入 digest 且不破 cap。

**T9 可观测（只读事件/接口）**（S，依赖 T2,T5,T7）
- 目标：把 `layers{ l0..l4, included, dropped }` 与线程摘要以**只读**方式暴露（事件 + 只读路由），复用既有 memory 路由风格。
- 约束：只读、不改协议语义、不引入 UI。
- 产出：`src/serve/composite.ts` / `server.ts` 只读路由 + 测试。
- 验收：同一 store 复现同一 layers（R10/R6）。

### Wave 3 — 收尾

**T10 全量回归**（S，依赖 T2–T9）：`pnpm test` / `pnpm typecheck` / `pnpm lint` 三绿，贴输出。
**T11 不变量总验 + 快照**（S，依赖 T10）：把 R1–R10 汇总成一份 verification 文档（`docs-dist/verification/`），含属性测试/快照/迁移证据。
**T12 阶段(P3/P4)规划留档**（S）：检索 v1（embedding，可选、可本地重建）与技能记忆（candidate→reusable/deprecated）的接口预留与开放问题回收（对齐设计稿 §8）。

---

## 四、派发矩阵（并行度 + 文件所有权）

```
T0 ─> T1 ─┬─> T2 (context.ts) ─┬──────────────┐
          ├─> T3 (retrieve.ts) ┤              │
          ├─> T4 (schema.ts) ──┼─> T5 (thread-summary.ts)
          └─> T6 (consolidate.ts)              │
                                              └─> T7 (rob.ts, backend.ts) ─> T9
                     T4 ─> T8 (record.ts)                     │
                    T2,T3,T4,T5,T6,T7 ─────────────> T10 ─> T11 ─> T12
```

**防冲突铁律：**
1. **一文件一 owner**：`context.ts`=T2、`retrieve.ts`=T3、`schema.ts`=T4、`thread-summary.ts`=T5、`consolidate.ts`=T6、`rob.ts`+`backend.ts`=T7、`record.ts`=T8。跨文件需求走 T1 冻结的接口，不直接改别人的文件。
2. **T1 冻结前不许实现**；T2–T6 只依赖 T1 的签名，互不依赖。
3. **T7 是唯一接线点**，在 T2–T6 都合入后再动 `rob.ts`。
4. **schema 只由 T4 动**；其他人需要字段先提 PR 给 T4，不许并行改 schema。
5. 每个任务**先补测试再改实现**，产出必须带证据（测试名/快照）。

---

## 五、单任务模板（复制给每个 agent）

```
任务：<T 编号与标题>
角色：后端/系统设计 + TypeScript 工程 + QA
背景：仓库 /home/heiwa/my-agent；bot 账本在 src/bot/**，rob 运行环在 src/rob/**；
      设计稿 docs-dist/design/bot-context-and-learning.md；agent 循环在 src/agent/agent.ts（复用 compact.ts）。
目标：<一句话>
输入：<依赖产出：T1 冻结签名 / 相关现有模块>
产出：
  - 代码：<列明独占文件>
  - 测试：<新增/增强的 test 文件与断言点>
验收：<对应 R 编号的不变量；回归不新增红>
禁止：改 shared/protocol.ts 语义、改 web/**、动别人名下文件、删改测试、引入外部服务/向量库（v0）。
依赖 / 可并行：<见矩阵>
```

---

## 六、Done 定义

- R1–R10 每条都有对应测试或快照证据，且归属 T11 的 verification 文档；
- `pnpm test` / `pnpm typecheck` / `pnpm lint` 全绿（test/rob 现有约 245 条不回归）；
- schema 升版有迁移且老文件可 load；
- 巩固为旁路、失败不阻塞、幂等、有界、可逆；
- `git status` 只剩有意改动，无临时产物。
