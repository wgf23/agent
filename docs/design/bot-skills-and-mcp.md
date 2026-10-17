# 设计：按 Bot 分配 Skill · 查看已装 Skill · 接入 MCP

- 作者：rob "architect" ｜ 状态：**定稿（可直接实现）**
- 关联 PRD：`docs/prd/bot-skills-and-mcp.md`（含 §10 的 C1–C22 设计前置约束，本设计逐条落点见 §9）
- 基线：**`ad3b41a`**（= origin/main = HEAD，0/0，tracked 树 clean）
- 决策来源：Q1–Q6 按 pm 建议（Web 为主 + 配置持久化 / 全局装一次 + 每 bot 白名单 / MCP 全局定义 + 每 bot 勾选 / 仅 stdio / 老 bot 可用全部 / 仅 native 生效）

> **本线红线（已重划，见 C19）**：允许改 `web/**`、`src/skills/**`、`src/mcp/**`、`src/rob/**`、`src/agent/system-prompt.ts`、`src/serve/**`、`shared/protocol.ts`、`src/config/project-file.ts`，以及 **`src/cli/skill.ts` + `src/cli/team.ts`**（后者仅 MCP 接线一行）。
> **测试面**：`test/web/**`、`test/skills/**`、`test/mcp/**`、`test/rob/**`、`test/config/**`（只加用例，不改既有断言语义；`test/mcp/manager.test.ts` 的 `servers` 断言属"跟随字段变更"，允许）。
> **协议只允许加性变更**：新增字段一律可选；**不得**改既有字段必选性/改名/改事件语义。
> **`src/tui/**` 的例外（唯一）**：允许 `src/tui/index.tsx` 里**仅 `new Team({...})` 的接线**，形如 `+ mcpToolsByServer: mcp.toolsByServer` 与 `extraTools: [...mcp.tools, ...plugins.tools] → plugins.tools`（净 3 行：2 增 1 删）。第二步**必须删掉 `...mcp.tools`**，否则 MCP 工具会既经 `mcpToolsByServer` 过滤、又被 `extraTools` 全量注入一次 —— 等于 AC-7 白做，且工具重复。
> `<App>`（:290 附近的单 agent 路径）**与 tui 其余一律零命中**。
> 理由：`runTui` 的 `Team` 是 bot 创建入口；不传 `mcpToolsByServer` 则 `createRob` 走 **C4' 的 `undefined` 分支**、每个 bot 无条件拿到全部 MCP 工具 ⇒ AC-7 在 TUI 面失效，且与 serve/cli 语义分叉。而 `<App>` 是单 agent 路径，正是 C4' 要保住旧行为的那个口子。
> 仍零命中：`screenshots/**`、`src/rob/room-text.ts`。不引入 jsdom/@testing-library。

---

## 0. 一句话方案

**沿用「全局装一次 → 每 bot 白名单」**：配置加 `skills`/`skillsConfigured`/`mcp` 三个可选字段（落 `my-agent.json` 的 `robs[]`）；skill 作用域在 **同一个 turn 快照**里同时约束系统提示与 `load_skill`；MCP 在 **`createRob` 一处**按 bot 过滤工具数组。不改连接层、不做 per-bot 磁盘副本、不做进程热连。

---

## 1. 数据模型

### 1.1 `RobConfig`（`src/rob/types.ts:56-94`）

```ts
export const robConfigSchema = z.object({
  name: robNameSchema,
  role: z.string(),
  model: z.string().min(1).optional(),
  permissions: permissionRulesSchema.optional(),
  backend: robBackendSchema.optional(),
  wake: wakeConfigSchema.optional(),
  // ↓ 新增（全部可选 = 加性变更，C19）
  skills: z.array(z.string().min(1)).optional(),
  skillsConfigured: z.boolean().optional(),
  mcp: z.array(z.string().min(1)).optional(),
}).superRefine(/* 既有逻辑不变 */);
```

`skills` 存**skill 名**（`Skill.name`，即 `SKILL.md` frontmatter 的 name），不是 npm 包名；与 `load_skill` 的入参、系统提示里 `- <name>: <desc>` 同一命名空间。

### 1.2 缺省真值表（C9，**必须 5 行全测**）

> **本表是读侧语义**（`visibleSkills`）。写侧不会产生第 1/2 行（见 §1.3.1）；第 1 行只可能来自历史/手写配置，第 2 行在写侧只能由显式 `skillsConfigured:false` 触发。

| # | `skills` | `skillsConfigured` | 生效集合 |
|---|---|---|---|
| 1 | `undefined` | 任意 | **全部已装**（向后兼容，行为同今天） |
| 2 | `[]` | `undefined` / `false` | **全部已装**（空数组未被"确认过"即视为未配置） |
| 3 | `[]` | `true` | **空集**（用户显式取消全部勾选） |
| 4 | `["a"]` | `undefined` / `false` | 只 `a` |
| 5 | `["a"]` | `true` | 只 `a`（严格） |

> 命名未知/已卸载的名字**静默忽略**（不报错、不自动改写配置，见 §10 U2）。

### 1.3 持久化（C13）

- **白名单进 project file**：`my-agent.json` 的 `robs[]`，由 `src/config/project-file.ts` 读写。
- **密钥只留 env**：MCP 的 `env` **不进** `McpServerInfo` 类型，也不随白名单写入（§3.4）。
**照抄的样板是 `permissions` 那一支，不是 `model` 那一支**（review M1，重要）：`writeRobUpdate` 里
- `permissions`/`wake`：`incoming.X !== undefined` 才写，**缺席 = 保留**；
- `model`/`backend`：`undefined` 就 `delete merged.X`，**缺席 = 删除**。

skills/mcp 属于第一类（缺席 = 保留，C8）。

### 1.3.1 归一与拒绝都在**落盘函数**（**定稿**：写侧归一 + 400，不上移 handler）

> 口径来源：leader 终裁（安全理由，非风格），review 逐行验过。**定稿，不再讨论**。
> 落地：`normalizeSkillScope()` 在 `src/config/project-file.ts:49`，已被 `writeRob`（创建）与 `writeRobUpdate`（更新）**在文件 IO 之前**各自调用（`a5982e8` 落更新侧、`367f355` 落创建侧）。

**结论：写侧归一 + 只给 flag 的 400 拒绝，都钉在落盘函数里；HTTP 层至多是额外便利，不作为正确性依赖。**

**为什么钉在落盘函数而不是 HTTP 边界**：
- `visibleSkills` 读的是**落盘值**。落盘一旦产生「`skills: []` + 无 flag」这一歧义态，读侧已无法区分意图，直接走真值表第 2 行 ⇒ **"少给权限"变成"给全部"**。把不变量钉在落盘函数上 = **存储形态本身无法表示歧义**；钉在 handler 上 = 信任每个未来的调用方都还记得补 flag。
- 若上移 handler：**每条写路径都要各测一遍**，且**存储层失去护栏** —— 未来 CLI 或新路由直接调 writer 就能造出裸 `[]` 把技能范围放大。
- **"忠实合并原语、不做策略"这个定位在现码里不成立**：同一函数里 `model`/`backend` 缺省即 `delete`，那已经是策略。既然已经有策略，把"作用域只能变窄、不得静默变宽"这条更危险的不变量放这里，是一致的。

**位置按实现（读写内聚，不跨层）**：`src/config/project-file.ts`，**不进** `src/skills/scope.ts`（那里是读侧 `visibleSkills`）。
**必须 `export`**：现为模块私有函数，只能经 fs 间接测；AC-12 要求「纯函数且有直接单测」，故要求 `export function normalizeSkillScope(...)` + **`test/config/skill-scope.test.ts`** 里直接断言四态（不碰 fs）。
> 测试文件是**新开**的（不并入既有的 fs 级 `test/config/project-file.test.ts`），命名按已落地实现；`project-file.test.ts` 继续只做读写级用例。

```ts
// src/config/project-file.ts（已落地，export 待补）
export function normalizeSkillScope(incoming: SkillScopeFields): NormalizedSkillScope {
  // ① flag 只用来限定列表，单独出现没有可表达的集合 ⇒ 拒绝。
  if (incoming.skillsConfigured !== undefined && incoming.skills === undefined) {
    return { ok: false, error: "skillsConfigured requires skills" };
  }
  // ② 两者都缺席 ⇒ 不动（更新侧保留原值，创建侧不产生字段）。
  if (incoming.skills === undefined) return { ok: true };
  // ③ 有列表没 flag ⇒ 视为已确认。落盘成 `skills:[]` + 缺 flag 会读回真值表
  //    第 2 行 = 全部已装，即"取消全部"变成"全部可用"——作用域静默变宽。
  return { ok: true, skills: [...incoming.skills], skillsConfigured: incoming.skillsConfigured ?? true };
}
```

**两个调用点（都已过这道闸，且都在 IO 之前）**：

| 入口 | 位置 | 现状 | 要求 |
|---|---|---|---|
| 更新 | `writeRobUpdate` | ✅ `a5982e8`，调 `normalizeSkillScope` 后早退 | 保持：error 必须在读文件之前返回（merge 回调里报不了错） |
| 创建 | `writeRob`（`addRob` → `POST /api/bots` 的落盘点） | ✅ `367f355`，同一 helper | 保持：不直接写 `parsedRob.data` |

> **禁止重复归一（硬）**：凡是**上游**（`PATCH /api/bots/:bot` / `POST /api/bots` handler、`composite.updateBot`、`toRobConfig`、UI 发送层）再补一次 `skillsConfigured ?? true` 或再判一次 400 的实现，一律视为**错误**——会形成双重策略并与配置层语义打架。上游只做**原样下传**：缺席保持缺席（`undefined` 不得被转成 `null`/`false`/`[]`）。

> **后续加固（本轮不做，别现在改代码）**：`robConfigSchema` 类型层仍可表示 `{skillsConfigured:true}` 无 `skills` 的歧义态，目前靠两个写入口都过 helper 防住。彻底做法是 `superRefine` + `transform` 把"归一后的形状"作为配置对象的不变量。开单独一条线做。

**写入形态真值表**（C9 五种形态必测）：

| 调用方传入 | 落盘 | 读回（§1.2） | 语义 |
|---|---|---|---|
| 省略 `skills`/`skillsConfigured` | 原样保留 | 原值 | **不改作用域**（C8 的落点，UI dirty 标记依赖它） |
| `{skills:[…]}`（无 flag） | `skills:[…]`, `skillsConfigured:true` | 恰好该名单 | 归一为已确认 |
| `{skills:[], skillsConfigured:true}` | `skills:[]`, `true` | **空集**（第 3 行） | 取消全部 |
| `{skills:[], skillsConfigured:false}` | `skills:[]`, `false` | 全部已装（第 2 行） | **显式**回到默认，唯一合法回退路径 |
| `{skillsConfigured:true}`（无列表） | 不落盘 | — | **400** `skillsConfigured requires skills` |

于是 **`UpdateBotBody` 省略 `skills` = 不改动该 bot 的 skill 配置**（C8 的落点，见 §6.1）；**唯一的放大路径只能是显式传 `skillsConfigured:false`**。`mcp` 保持 **patch 语义**（缺席 = 不选/不改；给了就整体替换），不做归一（leader 终裁第 6 条）。

> **禁止重复归一（硬）**：上表全部在 `writeRobUpdate` 内完成。凡是在**上游**（`PATCH /api/bots/:bot` handler、`composite.updateBot`、`toRobConfig`、UI 发送层）再补一次 `skillsConfigured ?? true` 或再判一次 400 的实现，一律视为**错误**——那会形成双重策略，且与配置层语义打架（一次归一 + 一次守卫已足够）。上游只做**原样下传**：缺席保持缺席（`undefined` 不得被转成 `null`/`false`/`[]`）。

### 1.4 读侧语义不因写入归一而变

§1.2 真值表第 2 行（`[]` + 未确认 = 全部已装）原样保留——它是**读**语义，用于兼容"从未配置过"的老配置。写入侧不再产生"有列表而无 flag"这种组合（见 §1.3.1），所以第 2 行在**新写入的数据上**只会由 `skillsConfigured:false` 显式触发。AC-11 的向后兼容断言（老配置读回全部可用）不受影响。

---

## 2. Skill 作用域（FR-1/FR-2/FR-3）

### 2.1 纯函数 `visibleSkills`（`src/skills/scope.ts`，新文件，无 React/DOM）

```ts
export interface SkillScopeConfig {
  skills?: readonly string[] | undefined;
  skillsConfigured?: boolean | undefined;
}

/** 真值表见设计 §1.2。未知名忽略；返回保持 installed 的顺序（discover 已按 name 排序）。 */
export function visibleSkills<T extends { name: string }>(
  installed: readonly T[],
  cfg: SkillScopeConfig,
): T[];
```

`resolveBotSkills(cfg, discover = discoverSkills)` 是它的异步薄壳（供 Team 直接调用），**discover 可注入**（C18 精神：测试不碰真目录）。

### 2.2 per-bot `load_skill` 工厂（C1/C2/C3，本线最关键）

`src/skills/tool.ts` 现在导出模块级单例 `loadSkillTool`，`execute` 里直接 `await discoverSkills()`，`ToolContext`（`src/tools/types.ts:4`）**没有 bot 身份**。因此下沉为工厂：

```ts
export interface LoadSkillToolOptions {
  /** null = 不设作用域（全部已装）；数组 = 白名单。 */
  allowed: readonly string[] | null;
  /** 默认 discoverSkills；测试注入 spy 以断言"零调用"。 */
  discover?: () => Promise<Skill[]>;
  /** 默认 (dir) => readFile(resolveInWorkspace(dir, SKILL.md))。 */
  read?: (dir: string) => Promise<string>;
}

export function createLoadSkillTool(options: LoadSkillToolOptions): Tool<typeof schema>;
/** 单 agent（cli run / tui 的 `<App>` 路径 / serve solo）继续用无作用域实例。
 *  （tui 的 `new Team` 是 bot 路径，按 bot 作用域，见 §0 红线例外。） */
export const loadSkillTool: Tool<typeof schema> = createLoadSkillTool({ allowed: null });
```

**执行顺序是契约（C2，写反则 AC-3 永远红）**：

1. `SKILL_NAME_PATTERN` 不匹配 → `{ ok: false }`（不做任何 IO）
2. `allowed !== null && !allowed.includes(args.name)` → **立即 `{ ok: false, error: "Unknown skill: …" }`**，**不得**调用 `discover()` / `read()`
3. `discover()` → `find(name)`
4. `read(dir)`

**遮蔽机制**：该工厂产物作为 `extraTools` 注入，`src/agent/agent.ts:127-145` 的既有逻辑（`shadowed` 去重 + `definitions` 过滤 + `lookupTool` 优先 extraTools）会**自动遮蔽** registry 里的同名 `load_skill`，无需改 registry。
`src/tools/registry.ts:21` 保留 `loadSkillTool`（无作用域）给单 agent 使用，**不删**。

### 2.3 注入链（一处快照 + **保存即重建**）

```
保存配置 (PATCH /api/bots/:bot)
  └─ composite.updateBot → TeamHub.replaceBot → Team.updateRob
       ├─ existing.stop() + approvals.denyRob(TURN_INTERRUPTED)   ← 保存会打断进行中的 turn（U7）
       └─ createRob(config)   ← 用新 config 重建 Rob（C11'）
            └─ skills: () => resolveBotSkills(config)             ← 闭包持**该次保存**的 config
                 └─ createNativeBackend.run(turn):
                      const skills = await options.skills()       ← ① 本 turn 唯一快照
                      ├─ runAgent({ skills })                     ← ② 系统提示
                      └─ extraTools: [ ...既有, scopedLoadSkill ]  ← ③ 每轮新数组（M3）
```

| 改动点 | 位置（按符号名定位） | 内容 |
|---|---|---|
| `RunAgentOptions.skills?: readonly Skill[]` | `runAgent` 的 options | 透传给 `buildSystemPrompt({ …, skills })` |
| `buildSystemPrompt` | `system-prompt.ts` 的 `options.skills ?? discoverSkills()` | **已支持**，无需改；由 qa 的 C17 直接断言 |
| `NativeBackendOptions.skills?: () => Promise<readonly Skill[]>` | `backend.ts` 的 `NativeBackendOptions` | `run()` 开头调用**一次** |
| `RobOptions.skills?` | `rob.ts` 的 `RobOptions` | 传给 `createNativeBackend` |
| `Team.createRob` | `team.ts` 的 `createRob` | 从 `config`（**本次保存传入的那份**）算出 skill 解析器与 MCP 工具集；**不从 `this.options.robs` 反查** |

**C10（一个 turn 只解析一次）**：`skills` 在同一 `run()` 内只 `await` 一次，系统提示与 `load_skill` 白名单**共用这一个数组**，结构上不可能出现「提示列了 A、工具拒绝 A」。

**C11'（更正，review B2）**：~~不重建 Rob、进行中的上下文不丢~~ **与现码事实相反**。事实链是 `Team.updateRob`：`disarmWake → existing.stop() → approvals.denyRob(TURN_INTERRUPTED_REASON) → createRob(config)` 重建 runtime（`TeamHub.replaceBot` 每次保存都走它）。故准确表述为：

- **每次保存 = runtime 重建**（沿用现码，不新写机制）；重建后实例的**下一 turn** 用新配置。
- **MCP 过滤"即时"的性质来自重建**：过滤发生在 `createRob`，而每次保存都会 `createRob`。两者是**同一件事**，不是两条独立性质（U1 的修正由此而来，见 §10）。
- **保存会打断该 bot 正在跑的那一轮**（审批被 deny，`turn interrupted`）。既有行为，本线不改；记入 §10 U7，UI 保存按钮旁提示「保存会中断正在进行的对话」。
- **不做**「每 turn 重读配置」的旁路：那会让 MCP 切换失去即时性，并与现码形成两套语义。
- **禁止读实时 roster 取 skill 配置（硬）**：`TeamHub.roster` 与 `TeamOptions.robs` 是**同一个数组引用**，`replaceBot` 原地替换，看起来"天然实时"，很容易被后人"优化"成 `skills: this.skillsFor(config.name)`（每 turn 反查 roster）。**不要**。理由：B2 已定走"保存即重建"，实时读取会和重建形成**两条真相源**，在重建窗口期出现"实例内配置"与"roster 配置"不一致；且第二条路径没有任何测试能固定住语义。**只保留一条**：`createRob` 抓 config 快照，闭包持有。

- **口径对齐 pm 裁决**（「白名单在 `createRob` 时解析一次」）：**配置快照确实在 `createRob` 固定**（闭包捕获本次保存的 `config`，之后任何配置改动都必须经过一次重建才可见）。**唯一例外是"已装 skill 目录"**：`resolveBotSkills` 在**每 turn** 调一次 `discoverSkills()`，这样**新装的 skill 无需重建 bot 就能进入"全部已装"语义**（否则用户装完 skill 得重启 serve 才生效，与 AC-5/AC-1 体验冲突）。白名单名字集合仍来自 `createRob` 时的配置快照——两者不冲突，因为一个来自磁盘发现、一个来自配置。

**M3（禁止污染共享数组）**：`backend.ts` 的 `run()` 已经是 `extraTools: [...turn.bridge.tools, ...(options.extraTools ?? [])]` 每轮**新建数组**。per-bot `load_skill` 必须追加进这一步构造的新数组，**禁止** `options.extraTools.push(...)`（那是 Rob 持有的共享数组，每轮 push 会线性累积；`agent.ts` 的 dedupe 只防重复广告，不防数组增长）。

**只读/单 agent 不受影响**：`skills` 未注入时 `runAgent` 行为与今天完全一致（`buildSystemPrompt` 走 `discoverSkills()`）。

### 2.4 CLI backend（Q6 / C12）

- **只对 native 生效**：`createNativeBackend` 之外不注入 `skills`，也不注入 per-bot `load_skill`（claude/opencode/pi 自带工具栈）。
- **Q6 谓词 = 两份实现 + 一条跨层一致性用例锁定（不是"无漂移面"）**：
  - **服务端**（已有，`src/rob/types.ts`）：`supportsBotScopedTools(backend: RobConfig["backend"] | undefined)` ⇒ `backend?.kind !== "cli"`（未配置 backend 时按 native 默认，故 `undefined ⇒ true`）。
  - **web**（`web/src/botScope.ts` 新文件）：`supportsBotScopedTools(backend: BackendKind): boolean` ⇒ **`backend !== "cli"`**（**故意写成服务端的同形否定式**，不是 `=== "native"`：将来若新增非 cli 的 kind，两侧默认行为一致，且逐字可比对；写成 `=== "native"` 会让新 kind 在两侧分叉）。
  - **为什么必须两份**：`web/tsconfig.json` 的 `include` 是 `["src", "../shared", "vite.config.ts"]`，**不含 `../src`** ⇒ web 构建**无法 import** `src/rob/types.ts`。这是结构性事实，不是风格问题；任何"后面再统一"的说法都不成立。
  - **防漂移靠测试，不靠断言**：`test/rob/bot-scope-consistency.test.ts` 遍历 `BackendKind` 全取值映射成 `RobConfig["backend"]`，断言两侧返回值逐项相等；再加服务端 `undefined ⇒ true` 的显式断言。root tsconfig 可同时 import `src/` 与 `web/src/`，可行。
  - **穷举必须由类型强制（硬）**：取值集合**不得硬编码成数组**——未来加第三种 kind 时数组不会变红，等于没锁。写法固定为
    ```ts
    const KINDS = { native: true, cli: true } satisfies Record<BackendKind, true>;
    // 遍历 Object.keys(KINDS) as BackendKind[]
    ```
    新增 `BackendKind` 成员时此处**编译期报错**，用例才真正锁住"两侧对所有 kind 一致"。
  - **类型名注意**：协议里的 `BotKind` 是 `"workspace" | "rob"`（bot 的种类），**不是** backend；web 侧入参应用 `BackendKind`（`"native" | "cli"`）。
- **C12 定：保留，不清空**。CLI backend 的 bot 若已存 `skillsConfigured:true`，切到 CLI 时不改配置、切回 native 时**继续生效**（不提示、不弹窗）。理由：不静默丢用户数据；写进文档 + 加一条用例（`test/rob/…`：切 CLI 再切回，`visibleSkills` 结果不变）。

---

## 3. MCP（FR-5/FR-6/FR-7）

> **行号时点**：本节行号以**当前 HEAD** 为准，仅作定位辅助；符号（`connectMcpServers` / `createRob` / `filterToolsByServers`）才是权威锚点。改动会导致漂移，评审请以 grep 符号为准。**注意**：PRD §14.5「事实」节里「`manager.ts:54` 硬编 `new StdioMcpClient`、`ConnectMcpServersInput`(:28-32) 无注入点」记录的是**改动前**状态；改动后注入缝已存在（§3.1.1；声明在 `ConnectMcpServersInput` 内 :38，缺省实现在 `connectMcpServers` 内 :49-50），该条已过时。

### 3.1 连接结果按 server 分组（C5/C6）

`src/mcp/tools.ts:31` 的 `mcpToolName()` 经 `sanitize()`（**不可逆**：`a.b` 与 `a_b` 同形），**禁止**从 `mcp__<server>__<tool>` 反推归属。故 `ConnectMcpServersResult.servers` 增字段：

```ts
export interface McpServerSummary {
  name: string;
  toolCount: number;
  /** 新增：该 server 暴露的工具全名（已含 mcp__… 前缀），供按 bot 过滤。 */
  tools: string[];
}

export interface ConnectMcpServersResult {
  tools: Tool[];
  notices: string[];
  servers: McpServerSummary[];
  /** 新增：与 tools 同源的一一映射，按 server 分组。 */
  toolsByServer: Record<string, Tool[]>;
  dispose: () => Promise<void>;
}
```
`manager.ts` 组装处：`toolsByServer[name] = mapped.tools`（与 `tools.push(...mapped.tools)` 同一次迭代，不可能漂）；`servers[].tools` 由 `mapped.tools.map(t => t.name)` 同处生成。

> **协议面：无需变更**。`McpServerSummary` / `ConnectMcpServersResult` 定义在 `src/mcp/manager.ts`，`shared/protocol.ts` 与 `web/**` 对它们**零引用**（`grepped`），`servers` 只在进程内用（tui 打印）。故 `tools` 是**内部加性字段**，不触发协议评审。
> **但会打到既有断言**：`test/mcp/manager.test.ts:45` 用 `toEqual([{name:"good", toolCount:2}])` 严格比对 `servers`，新增 `tools` 后必红——改 `McpServerSummary` 必须同步该断言（见 §12 第 11 项）。

### 3.1.1 测试缝：`ConnectMcpServersInput.createClient?`（C15）

```ts
// src/mcp/manager.ts（类型名以实现为准：McpClientOptions，定义在 src/mcp/client.ts）
export interface ConnectMcpServersInput {
  servers: McpServers;
  workspaceRoot: string;
  timeoutMs?: number;
  /** 测试缝：构造一个 client。缺省 new StdioMcpClient(options) —— 生产行为不变。 */
  createClient?: (options: McpClientOptions) => McpClient;
}
```

**这是为测试让步，不是生产扩展点**：① **仅测试用**，生产路径永不设置（全仓唯一非缺省用法在 `test/mcp/manager.test.ts:122`）；② 缺省 `new StdioMcpClient(options)`，**生产行为与加此字段前逐字一致**；③ **不改变 `McpClient` 接口本身**，也不经协议 / HTTP / 配置文件暴露（`shared/protocol.ts`、`web/**` 对该字段零引用）。

**为什么需要它**：`StdioMcpClient.dispose()`（`client.ts:96-112`）现实中**不会抛**——只 `kill` + `await exited`，`kill` 返回 boolean、`exited` 只 resolve。故 C15 要求覆盖的 **dispose 脱敏分支不可达**，真实 client 测不到。按 pm §14.1「不得以"不可达所以不测"取代证据」，改为注入一个 `dispose()` 会抛错且**错误文本含 env 值**的假 client 来 pin 住它。

**该测试覆盖三条断言（缺一不算过）**：
1. **脱敏**：`dispose()` 抛出的错误文本进 notice 后，env 值被替换为 `«redacted»`，原文不出现；
2. **不 reject**：`dispose()` 自身 **resolve**（错误被记录而非抛出）——调用方按"dispose 失败非致命"处理；
3. **dispose 后的 notices**：调用方在 `dispose()` **之后**重读同一 `notices` 数组才能看到这条（dispose 是 append 到 live 数组，不返回新数组，见 §3.4）。

### 3.2 过滤点：`createRob`（C4）

`src/serve/server.ts:208` 现在是 `extraTools: [...mcp.tools, ...plugins.tools]` 一份扁平数组给所有 bot。改为：

```ts
// server.ts
const robHub = new TeamHub({
  ...hubOptions,
  mcpToolsByServer: mcp.toolsByServer,   // 新增
  extraTools: plugins.tools,             // 只剩非 MCP 的全局工具
  robs: resolved.config.robs,
  rooms: resolved.config.rooms,
  providerEnv: runtime.current().providerEnv,
});
```
`TeamHubOptions` 增 `mcpToolsByServer`，经 `createTeam()` 传给 `TeamOptions`。
`createRob`（`team.ts`），**已落地写法**（与初稿不同，以下为准）：

```ts
// undefined = 这个调用方根本没接 MCP 分组（cli run / solo / 单测），
// 必须逐字沿用原 extraTools，不能"过滤成空数组"——那会悄悄摘掉工具。
const mcpTools =
  this.options.mcpToolsByServer === undefined
    ? undefined
    : filterToolsByServers(this.options.mcpToolsByServer, config.mcp ?? []);
return new Rob({
  …,
  extraTools:
    mcpTools === undefined
      ? this.options.extraTools                      // 原引用原样传，行为零变化
      : [...mcpTools, ...(this.options.extraTools ?? [])],
  // 配置快照来自本次传入的 config（**不是** `this.options.robs`），
  // 每 turn 再由 resolveBotSkills 做一次 discoverSkills（§2.3 C11'）。
  skills: () => resolveBotSkills(skillScopeOf(config)),
});
```

> **`undefined` 逃生口是契约（C4'）**：设计初稿写的是 `this.options.mcpToolsByServer ?? {}`，那会让"没接 MCP 分组"的调用方 `filterToolsByServers({}, …) === []`，把 MCP 工具整体摘掉。**必须保留 `undefined` 分支**：
> - `mcpToolsByServer === undefined` ⇒ 不参与过滤，`extraTools` **是原引用**（不是新数组），不走 Team 的调用者（cli run / solo）行为逐字不变；
> - `mcpToolsByServer` 有值 + `config.mcp` 缺省 ⇒ `[]` ⇒ **零 MCP 工具**（§10 U6：缺省=全不启用，不是继承全部）。

**纯函数**（`src/mcp/scope.ts`，新文件；泛型以便无进程测试）：

```ts
/** 按 enabled 顺序展开；未知 server 名忽略；不存在的工具不可能混入。 */
export function filterToolsByServers<T>(
  toolsByServer: Readonly<Record<string, readonly T[]>>,
  enabled: readonly string[],
): T[];
```

### 3.3 生命周期：只做可见性过滤，**不断开进程**

- MCP server 仍在 serve 启动时连接一次（`server.ts:208` 之前），进程退出才 `dispose()`。
- 取消某个 bot 的勾选 = **该 bot 的工具列表里不再出现这些工具**；server 进程**继续存活**（其他 bot 可能还在用）。
- **不做**：按需 connect/disconnect、PID 管理、引用计数。这是设计约束，dev 不得顺手实现（PRD §8 已列，此处再钉一次）。

### 3.4 密钥与能力（C14/C15/C16）

**写模型：只写不读。**

```ts
// shared/protocol.ts
export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  /** 只回键名，永不回值。类型层面没有 env（C14）。 */
  envKeys: string[];
}

export interface McpServerBody {
  command: string;
  args?: string[];
  /** string = 设置/覆盖；null = 删除该键；缺席 = 保持不变（写回已存值）。 */
  env?: Record<string, string | null>;
}
```

- 读：`GET /api/mcp` → `McpServerInfo[]`，`envKeys` 由 `Object.keys(config.env ?? {})` 生成。
- 写：`PUT /api/mcp/:name` 把 `env` 里 `string` 的部分写入配置、`null` 的键删除、**缺席的键从已存配置原样保留**（避免 UI 不显示值就把值抹掉）。
- **C15 泄漏面**：连接失败的 notice（`manager.ts` 的 `catch` 内 `notices.push(redactMcpServer(...))`，当前 :92）可能回显 `StdioMcpClient` 的错误文本。`dispose`/notice **统一过 `redactMcpServer()`**：
  ```ts
  /** 深扫字符串中的 env 值，替换为 «redacted»。空值/单字符不参与(避免误伤)。 */
  export function redactMcpServer(text: string, env: Readonly<Record<string,string>>): string;
  ```
  **notice 与 error 两条路径各一条用例**（qa 的 C15）。
  **dispose 路径**：`StdioMcpClient.dispose()` 不抛 ⇒ 该分支真实不可达，靠 `ConnectMcpServersInput.createClient?` 注入假 client 覆盖（见 §3.1.1，三条断言）。
- **C16 能力提升**：新增/启用 MCP server 的**写操作 loopback-only**（§5）；启用后首轮工具调用**仍走现有 `authorize`（ask 审批）**，因为过滤只改"可见性"、`gateway`/`execute` 路径不变。设计**不引入**任何"启用即自动放行"的捷径。

---

## 4. 协议 diff（C19：只加性）

`shared/protocol.ts`：

```ts
export interface BotInfo {
  … // 既有字段全部不动
  /** 新增，全部可选 */
  skills?: string[];
  skillsConfigured?: boolean;
  mcp?: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  packageName: string;
  version: string;
  // **不下发 `dir`**（pm 裁决 U4）：本地绝对路径不出 wire；CLI `skill list`
  // 仍保留路径显示。UI 无功能损失。
}

export interface McpServerInfo { /* §3.4 */ }
export interface McpServerBody  { /* §3.4 */ }
export interface InstallSkillBody { spec: string }

// ⚠ review B1-3：`UpdateBotBody` 是 **type alias**，不是 interface。
//    export type UpdateBotBody = Omit<BotDraft, "name">;
// 新字段必须加在 **BotDraft**（下方），`UpdateBotBody` / `CreateBotBody`
// 自动继承。给 alias 单独加字段编译不过，别踩。
export interface BotDraft {
  … // 既有：name / role / model? / backend?
  skills?: string[];
  skillsConfigured?: boolean;
  mcp?: string[];
}

export interface UpdateBotResponse / SkillListResponse / McpListResponse { … }
```

> 只加性自检：三个新字段全部可选 → 旧客户端/旧配置文件解析行为不变（C19/AC-11）。

**禁止**（review C19 红线）：把任何既有可选字段改成必选、改名、改事件语义、改 `BotKind`/`BackendKind` 取值。

---

## 5. 服务端路由（`src/serve/**`）

| 方法 | 路径 | 行为 | loopback |
|---|---|---|---|
| **POST** | **`/api/bots`**（**既有路由，必须改**｜leader 实测补漏） | 同样只显式读 `{name, role, model, backend}` → 加 `skills`/`skillsConfigured`/`mcp` 原样下传；**不做归一**（守卫在 `writeRob`） | 沿用现状 |
| **PATCH** | **`/api/bots/:bot`**（**既有路由，必须改**｜review B1-1） | 现在只显式读 `{role, model, backend}` 重建 body，其余字段丢弃 → 必须把 `skills`/`skillsConfigured`/`mcp` 也显式透传（`undefined` 时保持 `undefined`，交给下游"省略=不改"）。**归一与 400 拒绝不放这里**，在 `writeRobUpdate`（§1.3.1，唯一落盘点） | 沿用现状（不改） |
| GET | `/api/skills` | `visibleSkills` 用的原始清单：`discoverSkills()` → `SkillInfo[]` | 否（只读） |
| POST | `/api/skills` | `addSkill(spec)`；失败返回 400 + 可读原因，**无半装**（`install.ts` 已有回滚） | **是** |
| DELETE | `/api/skills/:name` | `removeSkill(name)` | **是** |
| GET | `/api/mcp` | `McpServerInfo[]`（**无 env 值**） | 否 |
| PUT | `/api/mcp/:name` | 结构校验 + 写入配置层（`project-file.ts` 的 mcp 层） | **是** |
| DELETE | `/api/mcp/:name` | 删除 server 定义 | **是** |

- 403 口径照抄 `server.ts:1178-1185` 的 `isLoopbackHost(...)` 分支（同一措辞风格）。
- 只读路由不做 loopback 限制，与现有 `/api/settings` GET 一致。
- **注意（见 §10 U1）**：新增/编辑 MCP server **定义**在下次 serve 启动时才连接；`PUT/DELETE` 后响应里明确带 `restartRequired: true` 提示。

### 5.1 bot 写入链路的逐字段重建点（review B1 + leader 补漏，**缺一个 AC-1 就静默 no-op**）

bot 的创建与保存路径上，字段会被**逐字段白名单式重建**。新增字段必须在下列各点**同时**放行，否则 UI 勾选后保存会返回成功、而 `my-agent.json` 一个字节都没变：

| # | 位置 | 现状 | 必须改成 |
|---|---|---|---|
| 1 | `src/serve/server.ts` 的 `app.patch("/api/bots/:bot", …)` | handler 里 `{ role, model, backend }` 显式重建 | 追加 `skills`/`skillsConfigured`/`mcp`（保持"缺席即不改"）。**不要**在这里补 `skillsConfigured`——归一在落盘函数（§1.3.1） |
| 2 | `src/serve/composite.ts` 的 `toRobConfig(draft)` | 只映射 `name`/`role`/`model`/`backend` | 追加三个字段的直通（**这是第二道闸，比 §11 之前写的"composite 透传"更具体**） |
| 3 | `shared/protocol.ts` 的 **`BotDraft`** | `UpdateBotBody = Omit<BotDraft,"name">` 是 **type alias** | **新字段加到 `BotDraft`**（`UpdateBotBody`/`CreateBotBody` 自动继承）。**不要**试图给 `UpdateBotBody` 单独加字段——type alias 上加不了 |
| 4 | `src/serve/server.ts` 的 `app.post("/api/bots", …)` | 同样只读 `{name, role, model, backend}` | 同 #1：原样透传三个新字段，**不做归一**（守卫在 `writeRob`，§1.3.1） |

**这四处只放行字段，不做语义**：`skills`/`skillsConfigured`/`mcp` 原样下传，缺席保持缺席；归一与 400 守卫**只在落盘函数**（`writeRobUpdate` 更新、`writeRob` 创建，共用 `normalizeSkillScope`，`src/config/project-file.ts`，§1.3.1）。见该节「禁止重复归一」硬条款。

**dev 自检**：写完后跑一条端到端——`PATCH /api/bots/x` 带 `skills:["a"]`（**不带 flag**）→ 读 `my-agent.json` 必须是 `skills:["a"]` + `skillsConfigured:true`（证明归一发生在配置层、且只发生一次；AC-1 取证项之一）。

---

## 6. UI 落点

### 6.1 `BotSettingsPanel`（`web/src/components/BotSettingsPanel.tsx`）

新增两个区块，**仅当 `supportsBotScopedTools(bot.backend)` 为真时渲染**，否则显示一行只读说明「由该 CLI 自行管理」（Q6）。

- **Skills 区块**：候选 = `SkillInfo[]` 全量；已选 = `bot.skills` 按 §1.2 真值表回显（`skillsConfigured !== true` ⇒ 全选且顶部提示「当前为默认：全部已装」）。勾选/取消是本地 state。
- **MCP 区块**：候选 = `McpServerInfo[]`；已选 = `bot.mcp ?? []`（缺省 = 全不选）。**常显状态行**「MCP：未启用（可用 N 个）」或「已启用 M ×/N」，避免留白让人误以为不可用（U6 ①）。新增/编辑 server 定义保存后提示「已保存，重启后生效」（U1）。
- **不显示 `dir`**：`SkillInfo` 已无该字段（U4），UI 只用 `name/packageName/version/description`。
- **保存语义（C8，必须显式）**：面板用 **dirty 标记**——只有用户在这个面板里**实际动过** Skills/MCP 区块，才把 `skills`/`skillsConfigured:true`/`mcp` 放进 `UpdateBotBody`；只改 role/model/backend 时**这三个字段一律省略**，服务端 `writeRobUpdate` 因"字段未定义"**原样保留**（§1.3）。
  - 文案：「保存将把该 Bot 的 Skill 设为当前勾选」（首次动 Skills 时提示一次）。
  - **发送形态硬约束**（§1.3.1）：`skills` 与 `skillsConfigured` **必须成对**发送；只发 flag 会 **400**。面板不提供"回到默认（全部已装）"以外的第三种状态：该动作发送 `{skills: [], skillsConfigured: false}`（唯一合法回退路径），普通勾选/取消发送 `{skills: [...], skillsConfigured: true}`（`[]` + `true` = 取消全部）。
  - 双开两个 tab 的后写覆盖：**接受**并写进 §10 U5（本期不做乐观锁）。

### 6.2 已安装 Skill 视图（`SettingsDialog`）

「已安装 Skill」区块：表格 `name / packageName / version / description`，附输入框 + 「安装」按钮（npm spec）+ 每行「移除」。顶部提示「安装/移除会立即对所有 Bot 可见；哪些 Bot 能用由各 Bot 的勾选决定」。

### 6.3 数据获取

`web/src/useHub.ts` 增：`loadSkills()`、`installSkill(spec)`、`removeSkill(name)`、`loadMcpServers()`、`saveMcpServer(name, body)`、`removeMcpServer(name)`；`App.tsx` 把它们传给 `BotSettingsPanel`/`SettingsDialog`（`BotSettingsPanel` 由 `App.tsx` 的 bot settings 分支渲染，按符号名定位）。

### 6.4 移动端契约（C20）

`BotSettingsPanel` 与移动端线同文件：新增区块只用既有 `.panel-*`/`.btn`/`.modal-*` 类；**不得**改动 `@media (max-width:640px)` 内既有规则、不得移除 `.file-panel.mobile-open`/`.sidebar.drawer-open`/`pointer:coarse` 44px 段。新增控件命中区 ≥44px 沿用 `.btn` 既有规则。

---

## 7. 纯函数边界（FR-10 / AC-12）

| 纯函数 | 文件 | 用例落在 |
|---|---|---|
| `visibleSkills(installed, cfg)` | `src/skills/scope.ts` | `test/skills/scope.test.ts`（5 行真值表 + 未知名忽略 + 顺序） |
| `resolveBotSkills(cfg, discover)` | `src/skills/scope.ts` | 同上（注入 discover） |
| `createLoadSkillTool({allowed, discover, read})` | `src/skills/tool.ts` | `test/skills/tool.test.ts`（**越界→ok:false 且 discover/read 零调用**） |
| `filterToolsByServers(byServer, enabled)` | `src/mcp/scope.ts` | `test/mcp/scope.test.ts` |
| `redactMcpServer(text, env)` | `src/mcp/redact.ts` | `test/mcp/redact.test.ts`（深扫、notice/error 两路径） |
| `normalizeSkillScope(incoming)` | `src/config/project-file.ts`（**须 export**） | `test/config/skill-scope.test.ts`（四态直测，无 fs）：flag-only ⇒ `ok:false`；`skills` 无 flag ⇒ `skillsConfigured:true`；`skills:[]`+`true` ⇒ 空集；`skills:[]`+`false` ⇒ 原样 |
| `supportsBotScopedTools(backend)`（服务端） | `src/rob/types.ts` | `test/rob/bot-scope-consistency.test.ts`（跨层一致性：与 web 侧全取值逐项相等；`undefined ⇒ true`；取值集合用 `satisfies Record<BackendKind, true>` 穷举） |
| `supportsBotScopedTools(backend)`（web） | `web/src/botScope.ts` | `test/web/botScope.test.ts`（step 4）+ 上述跨层用例（已可跑） |
| Skill/MCP 表单校验 | `web/src/botScope.ts`（`skillSelection`/`mcpSelection` 归一） | `test/web/botScope.test.ts` |

**不做**：任何宽度判断、DOM、React hook 进上述文件；**不引入 jsdom**。

---

## 8. AC 映射（AC-1..AC-14）

| AC | 落点 | 取证 |
|---|---|---|
| AC-1 勾选并持久化 | §1.3 `writeRobUpdate` 合并 + §1.3.1 归一/400（两落盘入口）+ §5.1 **四处逐字段重建点** + `BotSettingsPanel` dirty 标记 | 纯函数（`test/config/skill-scope.test.ts` 里 `normalizeSkillScope` **直接**测四态：flag-only → 400、`skills` 无 flag → true、`[]`+`true` → 空集、`[]`+`false` → 不变）+ **端到端两条**：`PATCH /api/bots/x` 带 `skills:["a"]`（无 flag）→ 读回 `["a"]`+`true`；`POST /api/bots` 同形态同样成立（创建路径守卫） |
| AC-2 未指派不进系统提示 | §2.3 `RunAgentOptions.skills` → `system-prompt.ts:43` | 纯函数 `visibleSkills` + 断言 `## Skills` 段落 |
| AC-3 `load_skill` 拒绝且不读文件 | §2.2 顺序契约 | 纯函数 spy：`ok:false` 且 `discover`/`read` **零调用** |
| AC-4 已装 Skill 视图 | §6.2 + `SkillInfo[]` | 纯函数（视图模型）+ 人工 |
| AC-5 安装/移除 + 无残留 | §5 `addSkill`/`removeSkill`（复用回滚） | 集成 + 纯函数（目录集回滚）；注意 **C22 flake** |
| AC-6 MCP CRUD + 校验 | §3.4/§5 | 纯函数（`McpServerBody` 校验）+ 集成 |
| AC-7 每 bot 只见启用 server 的工具 | §3.2 `filterToolsByServers` in `createRob` | 纯函数 + 集成（假 connector） |
| AC-8 单 server 失败只 notice | `manager.ts` 连接循环的 `catch`（当前 :88-97）既有 | 集成（假 connector，**不起真进程**，C18） |
| AC-9 下次 turn 生效（**不包含"不打断"**） | §2.3 **C11'：保存即重建 runtime**；新实例的下一 turn 用新配置 | 集成：保存 → 用 `updateBot` 返回的**新实例**跑下一 turn（旧已被 `stop()`，**不得**断言同一实例）。**保存会 `stop()` + `denyRob(TURN_INTERRUPTED)` 打断在跑的一轮 = 已知行为非缺陷**（U7），UI 须提示；qa **不得**写出"不打断/上下文不丢"的断言 |
| AC-10 403 + 脱敏 | §5 + §3.4 | 集成（非 loopback 403）+ 纯函数（深扫） |
| AC-11 向后兼容 | §1.2 真值表 1/2 行；**`mcp` 缺省=全不启用属行为变更**（U6，须在发布说明写明，非 bug） | 纯函数（缺省解析）+ 回归 |
| AC-12 纯函数化 | §7 表 | 审查 + 实跑 |
| AC-13 前三条线不回归 | — | 干净 HOME 全量实跑（基线 161/1435，本线会变） |
| AC-14 红线 | §0 + `git diff --name-only` | 审查 |

---

## 9. C1–C22 落点对照

| C | 落点 |
|---|---|
| C1 `load_skill` 下沉 per-bot | §2.2 工厂 + extraTools 遮蔽 |
| C2 先查白名单再 discover | §2.2「执行顺序是契约」4 步 |
| C3 工厂可注入 | §2.2 `LoadSkillToolOptions` |
| C4 过滤只在 `createRob` | §3.2 |
| C5 禁前缀反推 | §3.1 `toolsByServer` / `servers[].tools` |
| C6 按 server 分组 + 纯函数 | §3.1 / §3.2 `filterToolsByServers` |
| C7 `skillsConfigured` | §1.1 / §1.2 |
| C8 只有真改 skills 才置 true | §6.1 dirty 标记 + §1.3「省略=不改」 |
| C9 读侧真值表 5 行 + 写侧归一/400（两落盘入口共用） | §1.2 / §1.3.1 / §7 |
| C10 一 turn 一快照 | §2.3（`run()` 内单次 await） |
| C11' **保存即重建**（更正 review B2） | §2.3：`updateRob` 每次保存都 `stop()`+`createRob()`；MCP 即时性**由此产生**；进行中的 turn 被 `TURN_INTERRUPTED` 打断（U7） |
| C12 Q6 谓词 + CLI 切换语义 | §2.4（`supportsBotScopedTools`；**保留不清空**） |
| C13 白名单进 project file、密钥只留 env | §1.3 / §3.4 |
| C14 `McpServerInfo` 无 env + 深扫 | §3.4 |
| C15 notice/error 不带密钥 | §3.4 `redactMcpServer`；dispose 路径靠 §3.1.1 的 `createClient` 测试缝注入 |
| C16 能力提升：loopback + 仍走 ask | §3.4 / §5 |
| C17 AC-2 走 `options.skills` 缝 | §2.3 表 |
| C18 假 connector、不起进程 | §8 AC-8 |
| C19 协议只加性 | §4 |
| C20 移动端契约不回退 | §6.4 |
| C21 回归基数会变 | §8 AC-13 |
| C22 install flake 先隔离复跑 | §8 AC-5 |

---

## 10. 边界项与 pm 裁决（U1–U6 **全部收口**，见 PRD §11 裁决表）

- **U1 → 接受偏差（已定）**：**新增/编辑/删除 MCP server 定义需重启 serve 才连接**（连接在启动期一次完成）；**已配置** server 的「按 bot 启用/禁用」是**即时**的——**因果是"每次保存都重建 runtime"（§2.3 C11'），不是热过滤**，dev 不得以"避免重建"的方式优化掉。
  **实现要求（硬）**：`PUT/DELETE /api/mcp*` 的成功响应**必须带 `restartRequired: true`**；UI 保存后明示「已保存，重启后生效」；不得暗示"保存即可用"。**热连接另开一线**，本线不承诺（与 §3.3「只做可见性过滤」冲突）。
- **U2 → 接受**：残留白名单（skill 已卸载）**静默忽略**；UI 灰显「未安装」；**不自动改写用户配置**。
- **U3 → 接受**：`env` 写模型「只写不读 + 缺席保留 + null 删除」；**即使 loopback 也不回显明文**（C14 是类型级约束，无例外）。
- **U4 → 采纳 pm 减法：`SkillInfo` 不下发 `dir`**（§4 已删该字段）。CLI `skill list` 仍保留路径显示；UI 零功能损失。
- **U5 → 接受**：无乐观锁，双开 tab 后写覆盖先写；C8「省略=不改」把最坏影响限制在 skills/mcp 区块。
- **U6 → 维持缺省全不启用，但不得静默丢失**（**已定**，三条必须做）：
  ① Bot 面板常显「MCP：未启用（可用 N 个）」，不要留白让人以为不可用；
  ② 发布说明写明「升级后既有 bot 默认不启用任何 MCP server」属**行为变更**；
  ③ AC-11 已标注该语义。
  **否决**「缺省=全部启用」的兼容方案（等于静默授予所有 bot 可能执行命令的工具）。
- **U7 → 已知行为，接受**（review/leader B2）：`PATCH /api/bots/:bot` 保存任意设置（含只改 role）都会走 `Team.updateRob` → `existing.stop()` + `approvals.denyRob(TURN_INTERRUPTED)` → **打断该 bot 正在跑的那一轮**。本线不改此行为；UI 在保存按钮旁提示「保存会中断正在进行的对话」。若要"只改 role 不打断"，需另开线做增量 runtime 更新（不在本设计范围）。
- **L2 → 采纳**：`McpServerInfo` 会原样回显 `args`，**密钥只允许放 `env`**；文档与 UI 文案明写。若 args 里出现 `env` 中的密钥值，GET 时同样过 `redactMcpServer()` 兜底（不作为主防线）。

---

## 11. 任务拆分（dev，小步提交）

1. **数据与纯函数**（可并行、无 UI）：`src/skills/scope.ts`、`createLoadSkillTool` 工厂、`src/mcp/scope.ts`、`src/mcp/redact.ts`、`RobConfig` 三个可选字段 + `project-file.ts` 合并分支；对应单测。
   **本步两个已知坑（review M1/M2，dev step-1 WIP 已命中其一）**：
   - 样板是 `permissions`/`wake` 那一支（**缺席=保留**），**不是** `model`/`backend`（缺席=delete）。
   - **禁止** `if (incoming.skills === undefined) delete merged.skills;`——只发 `{skillsConfigured:true}` 时会把 skills 删成 `undefined`，落到真值表第 1 行「全部已装」，与"已确认"语义相反。按 §1.3.1 的写法：只发 flag 不发数组 ⇒ **400**；发数组不发 flag ⇒ 归一为 `skillsConfigured: true`。（更新路径已在 `a5982e8` 落地并有用例。）
   - **落盘守卫已抽成 `normalizeSkillScope`**（`src/config/project-file.ts`，`writeRobUpdate` 与 `writeRob` 共用，`367f355`）。**本步只补两件事**：① `export` 它；② 加**直接单测**（不经 fs 的四态断言）——AC-12 要求纯函数且有直接取证，间接经文件测不算。
2. **注入链**：`agent.ts`（`skills` 选项）、`backend.ts`（resolver；**每轮构造新数组，禁止 push 进 `options.extraTools`**，review M3）、`rob.ts`、`team.ts`（`createRob` 内按**本次传入的 config** 算 skill 解析器与 MCP 工具集）、`manager.ts` 的 `toolsByServer`/`servers[].tools`；集成/单测。**沿用既有"保存即重建"（§2.3 C11'），不要为 AC-9 引入每-turn 重读配置的旁路。**
   **本步必须带 C12 用例**（pm 点名）：CLI backend 的 bot 存有 `skillsConfigured:true` → 切 CLI（配置与解析结果不变）→ 切回 native（`visibleSkills` 仍为该白名单）。缺这条，日后会被后人当 bug「修」成清空。
3. **协议与服务端**：`shared/protocol.ts` **在 `BotDraft` 上加**三个可选字段（`UpdateBotBody` 是 alias，自动继承）+ 6 条新路由（含 loopback 403）+ `TeamHub` 选项。
   **本步必须逐处改掉"四处逐字段重建点"（§5.1，review B1 + leader 补漏，缺一个 AC-1 静默 no-op）**：
   ① `src/serve/server.ts` 的 `app.patch("/api/bots/:bot", …)` **与** `app.post("/api/bots", …)` 两个 handler（现在都只重建 `{role, model, backend}` / `{name, role, model, backend}`，需要透传三个新字段；**只透传，不做归一**——归一在两个落盘函数里，见 §1.3.1）；
   ② `src/serve/composite.ts` 的 `toRobConfig(draft)`（第二道闸，只映射四个字段）；
   ③ `shared/protocol.ts` 的 **`BotDraft`**（类型源头；`UpdateBotBody`/`CreateBotBody` 自动继承）。
   **自检用例**（必须覆盖"归一在配置层且只有一次"）：`PATCH /api/bots/x` 带 `skills:["a"]`、**不带** `skillsConfigured` → 读回 `my-agent.json` 为 `skills:["a"]` + `skillsConfigured:true`；再发一次同样的请求，结果不变（幂等，证明没有双重归一）。另加 `PATCH` 带 `skills:[]`（不带 flag）→ 读回空集（AC-1 取证）。
4. **Web**：`useHub` 六个方法、`BotSettingsPanel` 两区块（dirty 标记）、`SettingsDialog` 已装清单、`web/src/botScope.ts` + `test/web/botScope.test.ts`；**守住移动端契约**。

每步一个 commit；提交前 `git checkout -- screenshots/`；diff 只含 §0 允许路径。

---

## 12. 落地核对清单（只读复核用，architect 维护）

复核时**逐条打勾**，每条给出"怎么验"的机械判据（不靠读感受）。状态基于最近一次实地核对。

| # | 检查项 | 判据 | 当前状态 |
|---|---|---|---|
| 1 | **C2 判定顺序** | `src/skills/tool.ts` 的 `execute`：① `SKILL_NAME_PATTERN` 格式校验 ② `allowed !== null && !allowed.includes` 立即 `ok:false`（**discover/read 零调用**）③ 之后才 discover/read | ✅ 已核代码 + spy 单测 |
| 2 | **C10 单快照** | `src/rob/backend.ts` 的 `run()`：`await options.skills()` **只出现一次**；同一 `skills` 既进 `runAgent({skills})` 又 `.map(s => s.name)` 建 `createLoadSkillTool`；`extraTools` 为**新建数组**（无 push 累积） | ✅ 已核代码 |
| 3 | **C11' 快照来源** | `createRob` 用 `skillScopeOf(config)`，闭包 `() => resolveBotSkills(scope)`；全文件不得出现 `skillsFor(` 或从 `this.options.robs` 反查 skill 配置 | ✅ 已核 |
| 4 | **B1 四处真放行** | ① `server.ts` PATCH handler ② `server.ts` POST handler ③ `composite.ts` `toRobConfig` ④ `shared/protocol.ts` 的 `BotDraft` —— 四处都能看到 `skills`/`skillsConfigured`/`mcp` | ⛔ 待步骤 3 |
| 5 | **无重复归一** | 上述四处 handler/composite **不得**出现 `?? true` 或 `skillsConfigured requires skills`；该字符串只应出现在 `src/config/project-file.ts` | ⛔ 待步骤 3 |
| 6 | **AC-7 过滤接线** | `filterToolsByServers` 在 `createRob` 被调用；三个生产调用点（`tui/index.tsx:153`、`serve/server.ts:210`、`cli/team.ts:123`）都传 `mcpToolsByServer` | 🟡 已接线（WIP 未提交），代码已核 |
| 7 | **C4' `undefined` 逃生口** | `mcpToolsByServer === undefined` ⇒ `extraTools` 传**原引用**、不过滤；有值 + `config.mcp` 缺省 ⇒ `[]`（零 MCP 工具，U6） | 🟡 已核，与 §3.2 一致 |
| 8 | **`servers` 严格断言同步** | 增 `McpServerSummary.tools` 后，`test/mcp/manager.test.ts:45` 的 `toEqual([{name,toolCount}])` 必须补 `tools`，否则必红 | ⛔ 待修（leader 已派 dev） |
| 9 | **C12 用例** | bot 存 `skillsConfigured:true` → 切 CLI（配置与解析不变）→ 切回 native（`visibleSkills` 复原） | ⛔ 缺失（leader 已派 dev） |
| 10 | **落盘守卫两入口** | `normalizeSkillScope` 被 `writeRob` 与 `writeRobUpdate` 各调一次，且均**在文件 IO 之前** | ✅ 已核（`367f355`） |
| 11 | **谓词双侧穷举** | `test/rob/bot-scope-consistency.test.ts` 用 `satisfies Record<BackendKind, true>` + `Object.keys` | ✅ 已核 |
| 12b | **测试缝未外溢** | `createClient` 只出现在 `src/mcp/manager.ts` 的 `ConnectMcpServersInput` 与 `test/mcp/manager.test.ts`；`shared/`、`web/`、HTTP body、配置文件**零出现**；`grep -rn createClient shared/ web/ src/serve/` 应为空 | 已核 |
| 12 | **红线** | `git diff --name-only` ⊆ §0 允许路径；无 `screenshots/**`；`shared/protocol.ts` 仅加性。**`src/tui/**` 只允许 `src/tui/index.tsx` 的 `new Team({...})` 接线（2 增 1 删：`+mcpToolsByServer:`、`extraTools` 去掉 `...mcp.tools`），`<App>`(:290) 与其余必须零命中**——`git diff src/tui/` 只应看到这两处 | 每步提交时查 |

> **第 6/7/8 项是 AC-7 的唯一取证链**：没有接线，单测绿也等于功能不存在；`undefined` 逃生口丢了会伤到 cli run/solo；`servers` 断言不同步则 CI 红。
> **纯函数单测 ≠ AC-7 取证**：`test/mcp/scope.test.ts` 只证明「给定分组与选择，过滤结果正确」，不证明「建 bot 时真的用了它」。AC-7 需要 **Team→Rob 集成组**——造 `TeamOptions.mcpToolsByServer` + `robs:[{mcp:["docs"]}]`，断言该 rob 的 `extraTools` 里只有 docs 的工具、`mcp:[]` 或省略时为 0 个、`mcpToolsByServer` 省略时原样继承。
> **第 9 项是 C12 的唯一取证点**：缺它，C12 只是设计承诺。
