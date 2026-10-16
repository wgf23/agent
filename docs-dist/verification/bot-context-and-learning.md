# Bot 上下文与持续学习：不变量验收（T11）

对应设计 `docs-dist/design/bot-context-and-learning.md` §5 与任务清单 R1–R10。每条不变量给出代码位置与对应测试。

## R1–R10

| ID | 不变量 | 实现 | 验收 |
|---|---|---|---|
| R1 | 增长有界：任何回合数下单次上下文 token ≤ 预算 | `src/bot/context.ts` `assembleContext`；`ContextBudget` 固定配额，超限按 L3→L2→L1 裁，L4 不裁 | `test/bot/context.test.ts`：回合数 10/100/1000 属性断言 `estimateTokens(messages) <= budget.totalTokens` 且 `<= totalTokens - layers.l0` |
| R2 | 久远可召：100 回合前、已出近窗的事实仍进上下文 | `src/bot/retrieve.ts` 确定性打分（relevance / kind / recency），`assembleContext` L3 经 `Retrieve` seam 注入 | `test/bot/retrieve.test.ts`：写 fact → 灌 100 回合（环长 24，turn 1 已出环）→ `result[0].id === fact.id` |
| R3 | 线程隔离、记忆全局：换线程 L1/L2 清空但 L0/L3 保留 | `ThreadView` 只承载线程摘要与 id；`replay(record.turns, workspaceRoot, thread.id)` 供 L1；memory 与检索全局 | `test/bot/context.test.ts`（L1 按线程过滤、L2 摘要独立）+ `test/bot/retrieve.test.ts`（检索不按线程过滤） |
| R4 | 巩固幂等：同一 turn 巩固两次 = 一次 | `src/bot/consolidate.ts`：id `mem_${turnId}${index}`，`at = turn.at`，同输入同输出 | `test/bot/consolidate.test.ts`：两次结果 `toEqual` 且 JSON byte-equal |
| R5 | cap 不破：淘汰先 digest，pinned fact 最后 | `src/bot/record.ts` `applyMemoryDelta`/`enforceCaps`（只淘汰 digest）；`test/bot/schema.ts` 无显式 pinned，语义由 kind 决定 | `test/bot/record.test.ts`：入口满 + 溢出时淘汰 digest；无可淘汰返回 `ok:false` |
| R6 | 可回放：同一 store → 同一 assembleContext 输出 | `assembleContext` 纯函数、`retrieve` 纯函数、无时钟 | `test/bot/context.test.ts`（同输入 `toEqual` + inline snapshot）；`test/serve/bot-context-http.test.ts`（同一 store 两次 GET 相等） |
| R7 | 无回归 | — | 全量 `pnpm test`：146 files / 1305 tests；`pnpm typecheck`、`pnpm lint` 三绿（见 §回归） |
| R8 | provenance 与可逆：每条学习产物有来源、可 forget | `consolidate` 写入 `source = { sessionId, turnSeq }`；memory 既有 `drop` 可清 | `test/bot/consolidate.test.ts`：三个 upsert 的 `source` 断言；`applyMemoryDelta` 的 drop 见 `test/bot/record.test.ts` |
| R9 | 提升 digest 保真：被环挤掉的 turn 保留决策/产物/来源 | `src/bot/record.ts` `digestFor`：首条 user + 末条 assistant + `artifacts: <paths>`，一次截断到 `MAX_MEMORY_TEXT` | `test/bot/record.test.ts`（新增 `digest fidelity` 6 例，含 `artifacts: docs/x.md`）；`test/bot/baseline.test.ts` 相应更新 |
| R10 | 可观测：分层的 included/dropped 作为只读接口暴露 | `GET /api/bots/:bot/context`（`src/serve/server.ts` + `src/serve/team.ts`），纯重算、无写、无 provider 调用 | `test/serve/bot-context-http.test.ts`：字面 `layers{ l0..l4, included }`、`dropped`、`summary`；`provider.requests` 为空；未知 bot 404；SoloHub 501 |

## schema 升版与迁移（T4）

- `BOT_RECORD_VERSION` 1 → 2（`src/bot/schema.ts`）。memory entry += `{ uses, lastUsedAt, confidence }`；record += `threads`。
- `migrateRecord` 只在 `version === 1` 时升版并补默认（`confidence 0.5`、`uses/lastUsedAt 0`、`threads {}`）；其他版本原样交给 strict schema 拒绝。
- `store.load`/`readRecord`/`memory` 读取前迁移，写入前规范化；**v1 老文件仍可 load**。证据：`test/bot/schema.test.ts`、`test/bot/store.test.ts` 迁移块。

## 旁路、有界、可逆（P2）

- 巩固在 `runOnce` 的 `store.commit` 之后 **enqueue**（`src/rob/rob.ts`），不 await 进回合；失败发 notice，不失败回合。证据：`test/rob/context-wiring.test.ts`（旁路未阻塞、反射失败仍 ok）。
- 线程滚动摘要随产出它的那次 `commit` 原子落盘（`record.threads[id]` 在 commit 前设置，commit 保留 `threads`）。证据：`test/rob/context-wiring.test.ts`（`record.threads[SESSION]` 字面断言）。
- 生产开启：`Team` 的 `consolidate` 为 opt-in；`my-agent serve` 与 `my-agent team` 入口置 true（库默认关，避免脚本化 provider 的测试被额外调用打乱）。证据：`eec8c65`、`test/serve`。

## 回归（T10）

```
pnpm test       # 146 files, 1305 tests passed
pnpm typecheck  # clean
pnpm lint       # clean
```

## 已知边界与开放项

- 巩固成本未计入 bot `usage`（§8 开放问题），建议后续计入但排除在“最近一次上下文估算”之外。
- 巩固的线程摘要上限（600）小于线程滚动摘要上限（4000），sidecar 的摘要可能缩短已有滚动摘要，待对齐。
- `readContext` 调 `team.currentChannel(bot)`，首次读会惰性开一个 channel（既有 hub 状态，非新增可变状态）。
- L4 单独超预算时 `messages <= totalTokens - l0` 不成立（L4 不裁是规格），属文档化边界。
