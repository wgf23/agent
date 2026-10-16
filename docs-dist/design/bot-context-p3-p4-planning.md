# Bot 上下文与学习：P3/P4 规划留档（T12）

对应设计 `docs-dist/design/bot-context-and-learning.md` §6/§8。P0–P2 与 P3 的 v0 检索已落地；本文留 P3 v1（语义检索）与 P4（技能/程序记忆）的接口预留与开放问题。

## P3 检索 v1（语义检索，可选）

现状（已落地）：`src/bot/retrieve.ts` 是 v0 确定性打分 `1.0*relevance + 0.3*kindWeight + 0.05*recency`，纯函数、输入是账本、`limit` 取 top-k，`assembleContext` 通过 `Retrieve` seam 注入（`src/bot/context.ts`）。

v1 预留：

- 保持 `Retrieve` 签名不变（`(input: RetrieveInput) => MemoryEntry[]`）。语义检索换的是这个 seam 的实现，不改调用方。
- 索引可从账本重建：embedding 源 = memory 条目文本 + turn digest 文本；索引是可丢、可重算的缓存，不进入账本 schema。
- 需要 embedding 的注入点（provider 或本地模型）；零依赖原则下 v1 默认关闭，开启需要显式配置。
- 混合打分：v0 分数与余弦相似度加权；权重与阈值需要实测调，不写死。

开放问题：embedding 的批次与预算；索引重建触发（写入时增量 vs 后台全量）；跨 workspace 是否共享索引。

## P4 技能/程序记忆

现状：`consolidate` 已产出 `skillCandidates: string[]`（`src/bot/consolidate.ts`），但**没有**晋升/弃用/注入。

预留接口：

- 存储：`BotRecord` 增 `skills: Record<skillId, { text: string; status: "candidate" | "reusable" | "deprecated"; uses: number; lastUsedAt: number; source: TurnSource }>`。与 memory 同目录、明文、有界。
- 生命周期：`candidate → reusable`（成功使用 N 次后）；失败或长期未用 → `deprecated`；有界淘汰顺序与 memory 一致（digest → 低置信/久未用 → pinned）。
- 注入：`assembleContext` 增一层（暂记 L3.5）或在 L2 里并列，命中时注入 reusable 技能文本；预算从现有配额里出。
- 与既有 `skills` 机制对齐：仓库已有 npm 包技能（`load_skill`）；bot 技能是**自动学习**的候选，二者在注入层汇合，但来源与生命周期不同，需要区分命名与权限。

开放问题：晋升的“成功”如何判定（下回合未回滚？人工确认？）；技能文本的复用边界（是否跨 bot）；与既有 skills 的命名冲突。

## 回收到设计的 §8 开放问题

- 线程切分键：现取 `channelId`（唤醒源）。话题漂移检测留待 P4 之后。
- schema 升版与迁移：已定，v1 → v2 迁移落地（`src/bot/schema.ts`）。
- 巩固成本是否计入 bot usage：未计。建议计入（一次便宜调用），但不进“最近一次上下文估算”以防自激，沿用 compact 的做法。
