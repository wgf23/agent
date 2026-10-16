# Bot 上下文与学习：现状事实清单（T0 基线）

对应设计 `docs-dist/design/bot-context-and-learning.md` 的 §1。全部为代码级事实，附 `文件:行`。
基线测试：`test/bot/baseline.test.ts`（4 条，锁住下列事实）。

## 事实

| 事实 | 位置 | 影响 |
|---|---|---|
| 账本 `version:1`，`turns` 环形 `MAX_RING_TURNS=24`，`memory` 上限 `MAX_MEMORY_ENTRIES=128` / `MAX_MEMORY_CHARS=24_000` | `src/bot/schema.ts:5,7-10` | 账本有界 |
| 被环挤掉的 turn 只留一行 digest = **首条 user 文本**截断（`MAX_MEMORY_TEXT=2000`） | `src/bot/record.ts` `digestFor` | 决策/产物/来源丢失 |
| memory 条目 `kind ∈ {fact,preference,commitment,digest}`，无 `pinned`/`uses`/`confidence` 字段，schema `.strict()` | `src/bot/schema.ts` | 只能按 kind 隐式固定；无法表达衰减 |
| cap 淘汰只允许淘汰 `kind:"digest"`；无可淘汰时返回 `ok:false` | `src/bot/record.ts` `applyMemoryDelta`/`enforceCaps` | 事实/偏好/承诺隐式 pinned |
| 每回合发给模型的是**活的 `this.history`**（非 `replay`）；`replay` 只在 `loadChannelHistory` 用 | `src/rob/rob.ts` `runOnce` / `loadChannelHistory` | 单 session 内 history 单调增长（设计 §1 措辞需修正） |
| native rob 后端 `NativeBackendOptions` **无 `compaction`**，`runAgent` 未传 | `src/rob/backend.ts` | bot 路径**没有自动压缩** |
| 记忆渲染成 `systemNote` 注入 system prompt | `src/rob/rob.ts`、`renderMemory` | 记忆已是一等注入 |
| 一回合**恰好一次** `store.commit`；abort/max-steps/抛错都记这一条 | `src/rob/rob.ts` `runOnce` | 与 `test/rob/rob.test.ts` 对拍 |
| channel（session）id 形如 `chs_<hex>`，持久化在 `Turn.sessionId`；registry 仅内存 | `src/bot/channel.ts` | 线程 id 可复用 channelId |
| store 写路径唯一：`commit`/`saveMemory` 经原子 rename，按 bot 串行 | `src/bot/store.ts` | 崩溃安全、可重放 |
| 可复用：`estimateTokens` / `shouldCompact` / `splitForCompaction` / `summarizeMessages`（`src/agent/compact.ts`）、`trimForBudget`（`src/agent/context.ts`） | | 上下文层的构件 |

## 基线测试（T0）

`test/bot/baseline.test.ts`：

1. 被环挤掉的 turn 的 digest 只保留首条 user 文本（rich 的 assistant 决策/产物丢失）。
2. 同一 delta 应用两次 byte-equal。
3. `replay` 只按 workspace + session 过滤、按 seq 排序。
4. rob 连跑两回合时，第二回合的 provider 请求包含第一回合的 user 文本（history 单调增长、无压缩）。

## 与设计的偏差（需在实现时修正）

- 设计 §1 写「每回合 history = `replay(...)`」，实际是活数组；`assembleContext` 将**整体替换** `this.history` 的供给。
- 设计 §4 `consolidate` 返回 `MemoryDelta`，而 §3.2 输出含 `threadSummary` 与 `skillCandidates`；T1 冻结为 `ConsolidationResult { delta, threadSummary, skillCandidates }`。
- 无 `pinned` 字段；T4 若要「低置信/久未用先淘汰、pinned 最后」需新增字段与迁移。
