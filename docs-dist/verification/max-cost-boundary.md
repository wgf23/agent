# 验证证据 · `--max-cost` 边界（P2-1，绿）

> 作者：rob "test"（测试rob） ｜ 日期：2026-10-16
> 归属：`grok-feature-design-vs-evolution.md` §P2-1「有界编排压测」的 **`--max-cost` 边界**
> 来源：`test/agent/cost.test.ts`（文件 8 条；该 `runHeadless max-cost budget` describe 共 5 条，全绿）
> 复现：`npx vitest run test/agent/cost.test.ts`

## 1. 结论（一句话）

`--max-cost` 是**软上限且非严格**：守卫为 `estimateCost(usage, model) > maxCost`，在**每一步完成后、执行工具前**
检查，一旦严格超过即 `reason:"budget"` 收尾，**已完成的步骤不回收、超限那步的工具副作用不执行**；
恰好等于上限不触发；无定价模型（`estimateCost === 0`）永不触发。

## 2. 代码级事实

| 事实 | 位置 |
|---|---|
| 守卫：`maxCost !== undefined && estimateCost(usage, model) > maxCost` → `reason = "budget"` | `src/agent/agent.ts:280-283` |
| 检查点在 `collectStep` 之后、追加 assistant 消息与执行工具**之前** | `src/agent/agent.ts:266-285` |
| 无定价模型 `estimateCost` 返回 0（守卫永不触发） | `src/agent/cost.ts:22-29`（`MODEL_PRICING` 未命中 → 0） |
| CLI 解析：负值/非数 → `undefined`（等于未设置） | `src/index.ts:60-64`（`parseMaxCost`） |
| `budget` 非 `finished` → 退出码 1 | `src/cli/run.ts:exitCodeForReason` |

## 3. 测试证据（本次实跑）

```
npx vitest run test/agent/cost.test.ts
✓ test/agent/cost.test.ts (8 tests) 41ms
```

`runHeadless max-cost budget` 5 条：

| 用例 | 输入 | 断言 |
|---|---|---|
| `stops with reason budget once the cost exceeds the cap`（原有） | cap 0.0001，首步 1000 input | `done{reason:"budget",steps:1}`；provider 仅 1 次调用；usage 行 `cost=$0.00015` |
| `stops before executing a tool once the first step exceeds the cap`（新增） | cap 0.1，首步 1,000,000 input（=$0.15） | `done{reason:"budget",steps:1}`；**无 `tool_started`**（工具副作用不发生）；provider 仅 1 次调用 |
| `does not stop when the accumulated cost exactly equals the cap`（新增） | cap 0.00015，首步 1000 input（恰 $0.00015） | `done{reason:"finished",steps:2}`；无 `budget` 事件；provider 2 次调用 |
| `keeps running a zero cap for an unpriced model`（新增） | 模型 `openai/gpt-4o-mini`（无定价），cap 0 | 成本恒 0，`0 > 0` 为假 → `finished` |
| `runs unbounded when no cap is set`（新增） | 无 `maxCost`，首步 1M+1M tokens | `finished`，不设上限 |

## 4. 边界语义小结（供总稿引用）

1. **非严格**：等于上限不触发（`>` 而非 `>=`）。
2. **步界**：成本按「已累计 usage」估算，超限在下一步开始前才生效——因此 `steps` 恰为超限的那一步，
   且该步的工具不会执行。
3. **模型相关**：上限仅对 `MODEL_PRICING` 中的模型有效；未知模型成本视为 0，`--max-cost` 形同不设。
4. **解析容错**：`parseMaxCost` 对负值或非数值返回 `undefined`（视为不设上限），非报错
   （`src/index.ts:60-64`；本次仅对函数语义做代码级确认，未做 CLI 分词级实跑）。

## 5. 归属

- `delegate` 深度（`MAX_DELEGATE_DEPTH=1`，`depth_exceeded`）为团队层不变量，由 pi-test/opencode 分头覆盖
  （`src/rob/tools.ts:68`；`test/rob/tools.test.ts` 已有），本文件不重复。
