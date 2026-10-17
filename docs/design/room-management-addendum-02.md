# 增量修订说明 02 —— B 笔（删除房间）的三个未闭合点

状态：**增量说明，不修改主设计原文**（`docs/design/room-management.md` 保持 852 行 / `4b3ed305…`）
上游输入：review A2 / A3 / A4（manager 逐条核过源码，判定成立）
作用范围：**只取代**下列三处主设计条文 —— §5.5 的返回类型与 ENOENT 分支、§5.1 步骤 4 的 coordinator 措辞、§11:793 的类型名。其余条文（含 §6.1 时序、§6.3 分支矩阵、§6.4 单飞）**全部不变**。
提交归属：随 **B 笔**一起入库（它记录的是 B 笔尚未写的代码，不是部署前置）。

---

## A2 —— `removeRoom(config)` 的 ENOENT 必须是成功 no-op

### 问题

主设计 §5.5 写了「条目不存在 ⇒ `{ok:true}`」，但同一节的对照表标题是「**只有一处**与 `removeRob` 不同」，而 `writeRobRemoval` 的 ENOENT 分支是 `{ok:false, error: "Unknown rob: <name>"}`（`src/config/project-file.ts:598-600`）。照着抄会得到：

> 删除一个**没有 `my-agent.json` 的工作区**里的房间 ⇒ 归档已成功、config 阶段 500、**每次重试都 500**。

因为 `isEnoent` 是「**文件**不存在」，而「**条目**不存在」是另一件事。两者必须都按成功处理。

### 冻结语义

| 情形 | 结果 | 是否写盘 |
|---|---|---|
| `my-agent.json` **文件不存在**（ENOENT） | `{ok:true, removed:false}` | **不写**（不得凭空创建一个空配置文件） |
| 文件存在，`rooms` 字段不存在 | `{ok:true, removed:false}` | 不写 |
| 文件存在，`rooms` 里没有该名 | `{ok:true, removed:false}` | 不写 |
| 文件存在，`rooms` 里有该名 | `{ok:true, removed:true}` | 写：`{...raw, rooms: next}` + 结尾换行，**其余键逐字节保留** |
| 读失败（非 ENOENT） / JSON 非法 / schema 不合法 | `{ok:false, error}` | 不写 |

**与 `removeRob` 的 ENOENT 语义故意相反，必须写在函数注释里**：

- rob 不存在 = **错误**：`robs[]` 是 bot 的唯一定义源，名字不在就是调用方搞错了；`Unknown rob: x` 是既有的、被 6 处复用的约定。
- 房间不在 config 里 = **常态**：房间有三个来源 —— `config.rooms[]`、ledger、以及运行中 `POST /api/rooms` 建的 runtime 房（后者**从不写 config**）。所以「config 里没有」不能说明房间不存在，**更不能算失败**。

### 返回类型（取代 §5.5 的 `Promise<WriteResult>`）

`WriteResult`（`project-file.ts:160`）是 `{ok:true} | {ok:false;error}` 的联合，无法携带 `removed`。改为专用类型（只新增，不动 `WriteResult`，`removeRob` 零影响）：

```ts
// src/config/project-file.ts
export type RoomConfigRemoval =
  | { readonly ok: true; readonly removed: boolean }   // removed 表示「确实过滤掉了一条」
  | { readonly ok: false; readonly error: string };

export function removeRoom(workspaceRoot: string, name: string): Promise<RoomConfigRemoval>;
```

`removed` 是 B 笔判定 **404 还是 200** 的唯一依据（见 A3 的决策表），不能省。
串行化沿用模块级 `writeChain`（与 `writeRobRemoval` 同一把链）—— 即便「不写盘」也排在链上，保持读-改-写不交错。

---

## A3 —— `RoomRemoveOutcome` 定义（主设计全文引用 5 次、零定义）

主设计 §5.4:128、§5.3:281、§5.3:288、§6.4:473、§6.4:475 都用了 `RoomRemoveOutcome`，但 `export type RoomRemoveOutcome =` 全仓 grep 为 0 —— 单飞 map 的值类型、以及 200/404/500 的映射只能由 dev 自行发明。**现冻结为 3 个判别式（`status` 是唯一判别键）**：

```ts
// src/rob/team.ts
export type RoomRemoveOutcome =
  | {
      readonly status: "removed";
      readonly room: RoomName;
      /** 盘上是否留下了归档：already_archived ⇒ true（幂等重试与首次结果一致） */
      readonly archived: boolean;
    }
  | { readonly status: "unknown_room" }                  // → 404
  | {
      readonly status: "failed";
      readonly stage: "stop" | "archive" | "config";     // → 500 + stage
      readonly error: string;                            // 用户可见文案
      readonly detail?: string;                          // 底层原因（可选）
    };
```

### 3.1 `archived` 的取值（manager 点名要定，review 后修订）

`archived` 有**两个来源**，取决于走哪条分支（见 §3.3）：

| 分支 | 来源 | `archived` | 依据 |
|---|---|---|---|
| A/B（有实例或**有 ledger**，含损坏 ledger） | `roomStore.archive()` | `status !== "missing_source"` | `archived` / `already_archived` 都 ⇒ true |
| C/E（无实例、无 ledger、config 有条目） | `roomStore.hasArchive(name)` | 直接返回布尔（吞异常，最坏低估为 `false`） | 不调 `archive()`（§3.3 的零副作用路径） |

正常分支的四种 `archive()` 结果：

| `roomStore.archive()` 返回 | `archived` | 依据 |
|---|---|---|
| `archived` | **true** | 刚归档 |
| `already_archived` | **true** | 同一件事发生在更早的一次请求；幂等重试必须与首次同结果（FR-3.5/AC-7） |
| `missing_source` | **false** | 只有「从未落盘的房间」（config 种子房，§4.2 唯一允许 `false` 的情形） |
| `failed` | —— | 不产出 `removed`，直接 `{status:"failed", stage:"archive"}` |

即：**`archived = archive.status !== "missing_source"`**（`failed` 已提前返回）。不要写成 `status === "archived"` —— 那会让幂等重试返回 `archived:false`，前端据此误判为「从未落盘」。

### 3.2 404 与 200 的判别（review A3 的本体）

§6.3 的 A–F 六分支收敛成一条：

> **`removed` ⇔ `instance ≠ undefined` ∨ `config.removed === true` ∨ `archive.status === "archived"`**

派生结论（与 §6.3 逐行对齐）：

| 分支 | instance | ledger | `.trash` | config | archived | HTTP |
|---|---|---|---|---|---|---|
| A | 有 | 可能 | — | — | true | 200 |
| B | 无 | **有** | — | — | true | 200 |
| C | 无 | 无 | 有 | **有** | true | 200 |
| D | 无 | 无 | 有 | 无 | — | **404** |
| E | 无 | 无 | 无 | **有** | false | 200 |
| F | 无 | 无 | 无 | 无 | — | **404** |
| B′ | 无 | **损坏**（`read().ok === false`） | — | — | true | 200 |

**B′ 是 review 抓到的漏洞**：`RoomStore.read()` 对非法 JSON / schema 不合法返回 `{ok:false}`（`room-store.ts:104-124`），**不是** `record:null`。若把它当成「没有 ledger」走前置分支，会把**存在但损坏**的文件误判为不存在，`archived` 还会报 `false`（而文件其实会被 rename 到 `.trash`，真值应为 true）。⇒ 判定必须是 `hasLedger = !r.ok || r.record !== null`（**解析失败按「源可能存在」处理**）。

### 3.2.1 DELETE 成功后重放 = **404**（写死，防被当 bug 修）

**同一次删除成功之后，再发一次同样的 DELETE ⇒ 404 `unknown room`，不是 200。**

理由：`removed` 的唯一依据是 config 的 `removed` 标志（§3.3 前置分支）；重放时 config 已无该条目、ledger 已在 `.trash`、registry 已摘 ⇒ 分支 D ⇒ 404。

**与 §3.1「`already_archived` ⇒ 幂等重试同结果」不矛盾**：后者只在「**config 还没摘**」时可达（分支 B / 分支 A 的 archive 阶段）。一旦 config 摘除成功、请求返回 200，任务就结束了；之后的 DELETE 是**新请求打在一个已经不存在的房间上**。

- 前端正确行为：删除成功后从本地状态移除该房间（AC-10），不重发；重发得到 404 时按「已经没了」静默处理，**不要弹错误条**。
- **禁止**为了「重放返回 200」而引入磁盘 tombstone / `deleted:true`（PRD D-2 已否决：多一个状态源就多一条漂移路径）。

### 3.3 ⚠️ 前置分支必须**零归档动作**（review 后重做，原版有阻塞级缺陷）

#### 原版的两个缺陷（均已核实）

1. **C/E 先 `removeRoomConfig` 再 `archive()` ⇒ 失败后不可重试、且文案撒谎。**
   config 摘除是**不可回滚**的写盘；此后 `archive()` 的 `mkdir(trashDir)` 若失败（EACCES/ENOSPC）会返回 `stage:"archive"`，而 §4.2 对该 stage 的承诺是「**盘上不变、重启会回来**」—— 此刻 config 已删、ledger 本就没有 ⇒ **盘上变了、重启也不会回来，这句话是假话**；用户按提示重试 ⇒ `cfg.removed === false` ⇒ **404**，前后矛盾（先说「请重试」，再说「房间不存在」）。
2. **`hasLedger = r.ok && r.record !== null` 把「坏 ledger」当成「没有 ledger」**（见 §3.2 的 B′）。

#### 冻结实现：前置分支只用两个**同步、零副作用**的原语

```ts
// src/rob/room-store.ts —— 两个新成员（都同步；hasArchive 只读目录、不写；markDeleted 不碰文件）
export interface RoomStore {
  …
  /** `<name>.*.json` 是否已存在于 .trash（内部复用 archive 的 newestArchive）。
   *  **必须自己吞掉一切异常并返回 false**（ENOENT / EACCES / ENOSPC 一律 false），
   *  绝不向上抛 —— 写法照 `readAll` 的 `try { readdirSync(dir) } catch { … }`
   *  （`room-store.ts:131-137`）。理由：`.trash/` 在「从未落盘」的工作区里
   *  根本不存在，裸 readdirSync 会抛 ENOENT；而这个调用发生在 config 已摘除之后，
   *  抛错会被路由兜成 500 —— 房间已经删完了却报失败。 */
  hasArchive(room: RoomName): boolean;
  /** deleting.add(room)：只钉名字，不做任何文件操作。同步、无异常路径。 */
  markDeleted(room: RoomName): void;
}
```

```ts
// src/rob/team.ts —— removeRoomNow
const instance = this.roomRegistry.get(name);
const read = this.roomStore.read(name);
const hasLedger = !read.ok || read.record !== null;   // 损坏 ledger 也走正常分支（§3.2 B′）

// ── 前置分支：无实例、无 ledger ────────────────────────────────
if (instance === undefined && !hasLedger) {
  const cfg = await removeRoomConfig(name);
  if (!cfg.ok)
    return { status: "failed", stage: "config", error: /* 含「重启后会重建」 */ cfg.error };

  // D / F：config 也没有 ⇒ 房间从来不存在 ⇒ 404，且【零副作用】（不建 .trash、不钉名、不广播）
  if (!cfg.removed) return { status: "unknown_room" };

  // C / E：config 有条目 ⇒ 摘除即完成。之后不得再有任何可能失败的 I/O。
  if (this.roomRegistry.has(name))
    // 极窄竞争：config 摘除期间有人建了同名房 ⇒ 不要钉死它，报可重试
    return { status: "failed", stage: "config", error: /* 「重启后会重建」 */ };

  // 先求值再钉名：即便将来 hasArchive 多了会失败的分支，此刻状态仍可回退。
  const archived = this.roomStore.hasArchive(name);        // 已吞异常，恒返回布尔
  this.roomStore.markDeleted(name);                        // 同步，无异常路径
  return { status: "removed", room: name, archived };
}

// ── 正常分支 A / B（含 B′）：§6.1 c1→c2→c3→d→e 一字不改 ──────────
if (instance !== undefined) {
  if (instance.view().run.phase === "running") instance.interrupt();
  await instance.stop();                                  // 抛错 ⇒ {status:"failed", stage:"stop"}
  this.roomRegistry.delete(name);
}
const archive = await this.roomStore.archive(name);
if (archive.status === "failed")
  return { status: "failed", stage: "archive", error: archive.error };
const cfg = await removeRoomConfig(name);
if (!cfg.ok)
  return { status: "failed", stage: "config", error: /* 含「重启后会重建」 */ cfg.error };
return { status: "removed", room: name, archived: archive.status !== "missing_source" };
```

四条要点：

1. **前置分支绝不调 `archive()`**。`archive()` 的第一步是 `deleting.add(room)`（主设计 §5.4:317），它是 404 路径上产生 tombstone 的根源 —— 删一个从不存在的名字返回 404，却让该名字在本进程内被 `createRoom` 判成 `duplicate`（§6.4.1），用户完全无从理解。改为「`cfg.removed` 为真才 `markDeleted`」，**404 路径零副作用**。
2. **前置分支不会出现「返回 500 但其实已经删完了」**：`mkdir`/`rename` 全部不参与；`hasArchive` / `markDeleted` 都是同步、都不写盘，且 `hasArchive` **契约上必须吞异常恒返回布尔**（见接口注释，照 `readAll:131-137` 的 catch 写法）。另把 `hasArchive` 的求值放在 `markDeleted` **之前**，这样即便将来它多了会失败的分支，钉名也还没发生、状态可回退。
   **取舍（有意为之）**：`hasArchive` 吞掉 EACCES 时会低估 `archived`（盘上其实有归档却报 `false`）。这是**安全方向的谎** —— 报「没归档」不会让用户丢数据，报「已归档」而实际没有才会。所以吞掉是对的。
3. **`stage:"config"` 的语义仍然诚实**：前置分支里 config 写失败时，房间仍在 config 里 ⇒ 「重启后会重建」为真；正常分支里 config 写失败时，ledger 已在 `.trash` ⇒ 同上。
4. **`room_removed` 广播只在 `status === "removed"` 时发**；404、500 一律不发（否则另一台手机会凭空少一个房间）。

### 3.4 路由映射（`src/serve/server.ts`）

| outcome | HTTP | body |
|---|---|---|
| `removed` | 200 | `{ok:true, removed:{name, archived}}` |
| `unknown_room` | 404 | `{error:'Unknown room "x".'}`；**含「DELETE 成功后重放」**（§3.2.1） |
| `failed` `stage:"stop"` | 500 | `{error, stage:"stop"}`；语义「删除失败，房间仍在，可重试」 |
| `failed` `stage:"archive"` | 500 | `{error, stage:"archive", detail?}`；语义「盘上不变、重启会回来」 |
| `failed` `stage:"config"` | 500 | `{error, stage:"config", detail?}`；**`error` 必须含「重启后会重建」** |
| hub 无 `removeRoom` | 501 | `{error:"this server cannot manage rooms"}` |

**`auditAdmin` 的 `action` 必须放宽为 `"patch" \| "delete"`**（`server.ts:401-403` 现为单成员字面量 `"patch"`）。不放宽则 DELETE 的 6 处 `auditAdmin` 调用**编译不过**，AC-11e 缺一半 —— 这是编译错误，不是风格问题。

---

## A4 —— §5.1 步骤 4 的 coordinator 措辞更正（**只改文档，代码已正确**）

主设计 §5.1 的伪代码是：

```ts
const nextCoordinator = patch.coordinator === undefined ? this.coordinator : patch.coordinator;
const coordCheck = validateRoomCoordinator(nextCoordinator ?? undefined, nextMembers);
if (coordCheck.status === "rejected") return coordCheck;   // ← 无条件校验：错
```

它会导出一个**已存在的行为回退**：只改 `members`、且新名单恰好漏掉现任 coordinator 时返回 `coordinator_not_member`。而现有 `setMembers` 的语义是**清空** coordinator，且 §5.2:267 自己写着「语义完全不变」——两处自相矛盾。

`src/rob/room.ts` 已按正确写法落地（**stated / cleared 两分支**），现把措辞改为与之逐字对齐：

```ts
const stated = patch.coordinator !== undefined;
let nextCoordinator: RobName | null = stated ? (patch.coordinator ?? null) : this.coordinator;

if (stated) {
  // 调用方「指定」了协调者 ⇒ 必须在新名单里（对新名单校验，杜绝「先设他再移除他」写坏一个悬空名）
  const check = validateRoomCoordinator(nextCoordinator ?? undefined, nextMembers);
  if (check.status === "rejected") return check;          // coordinator_not_member
} else if (nextCoordinator !== null && !nextMembers.includes(nextCoordinator)) {
  nextCoordinator = null;                                 // 「只改成员」⇒ 兼容 setMembers：清空，不拒绝
}
```

**判定规则一句话**：
- **指定了** `coordinator`（含显式 `null`）⇒ 对新名单校验，不在名单里 ⇒ **拒绝** `coordinator_not_member`（AC-4 三态之一）。
- **没指定**，只改 `members` ⇒ 现任 coordinator 不在新名单里 ⇒ **静默清空为 `null`**（保持 `setMembers` 既有语义，TUI 零回归）。
- 两者都在一次 `persist` + 一条 `members` 事件里生效（`coordinator` 字段随之广播）。

---

## 附：§11:793 类型名更正

| 位置 | 原文 | 应为 |
|---|---|---|
| §11 提交 A 表、`shared/protocol.ts` 行 | `UpdateRoomBody` | **`PatchRoomBody`** |

实际定义在 `shared/protocol.ts:473`，注释即「PATCH /api/rooms/:name」，`members?` / `coordinator?` 两字段都对。**纯改名，无行为变化**（B 笔不需要动它）。

---

## 附：运维可见性建议（review 提议，manager 判「可选」—— 我认同可选，不强推）

现状：`resolveAdminToken` 的 `onNotice` 只在**权限异常**时写一行；解析成功时静默。加上 addendum-01 的惰性时机，运维在启动日志里**完全看不到令牌来源**。

可选的低成本补法（**不改变惰性语义、不触发解析**）：在 `serve` 启动完成、打印监听地址的那一行之后，补一行**不含令牌**的汇总：

```
admin token: source=<env|file|none>
```

- 实现方式二选一：① `buildApp` 的惰性闭包**保持不动**，另在 serve 启动处按「env 是否存在 + 文件是否存在」做**存在性**判断（不读内容）；② 若愿意接受启动期解析，则直接用 `resolveAdminToken` 的结果（与 addendum-01 的行为冲突，不推荐）。
- **代价**：stderr 多一行常量文本。**收益**：`source=none` 一眼可见 —— 这正是「换新 dist 后所有 PATCH 403」那个故障最可能的现场特征。
- **不阻塞 B 笔**；若采纳，单独一笔 `feat(serve)` 做，不要塞进删除房间。

---

## 对 AC 的影响

| AC | 影响 | 说明 |
|---|---|---|
| AC-5 / AC-7 | 无 | 归档判据未变（§6.2.1 / §6.2.2 不动） |
| AC-6 重启不复活 | 无 | 仍靠「config 摘除 + ledger 移走」；A2 只保证「本来就没有 config」时不误报失败 |
| AC-8 部分失败可重试 | **补强（review 后加强）** | A2 消除了「没有 `my-agent.json` 的工作区重试必现 500」；A3 的 `already_archived ⇒ archived:true` 保证重试结果与首次一致；**§3.3 新版保证前置分支（C/E）在 config 写成功后不再有任何会失败的动作** ⇒ 不再出现「500 说请重试、重试说 404」 |
| AC-9 不越界 | **补强** | A3 §3.3 前置分支保证 404 路径**不建 `.trash`、不设 tombstone、不广播** |
| AC-11e 审计 | **依赖 A3 §3.4** | `action` 不放宽则 DELETE 审计行编译不过 |
| AC-12 回归 | 无 | `removeRob` / `WriteResult` / `renderRoomOutcome` 零改动 |
| AC-13a/b | 无 | §6.4.1 未变；§3.3 反而保证「404 不占用名字」 |

---

## 未闭合边界（按现状接受）

1. **`Team` 的 `options.rooms` 是启动快照**，不代表 config 文件的当前内容 ⇒ 判定 config 有无必须走 `removeRoom()` 的 `removed` 标志（A2 已定），**不得**用 `options.rooms` 判断。
2. **前置分支（C/E）会为「从未落盘」的名字设 tombstone**，动作降级为 `markDeleted()`（不再经由 `archive()`）。语义上该名来自 config ⇒ 视为「曾被声明过的房间」，重启后可复用，与 AC-13b 一致；已接受，不额外处理。
   **例外已堵死**：D/F（config 也无）**不钉名**，所以「删错名字」不会造成「之后建不了同名房间」。
3. **`stage:"stop"` 的 HTTP 暴露**：§4.2 只列了 `archive`/`config`。本说明把 `stop` 一并写进 `stage` 联合，属**加性**（老客户端只读 `error`），记录在此以免 review 误判为越界。
4. **前置分支的 config 写与 `markDeleted` 之间有极窄竞争窗口**：期间若有并发 `POST /api/rooms {name}` 成功（`createRoom` 不经过单飞 map），会被随后的 tombstone 掩盖后续写入。已在 §3.3 冻结代码里用「`markDeleted` 前再查一次 `roomRegistry`，命中则返回 `stage:"config"` 可重试」堵住；窗口仍在（查完到钉名之间），但后果从「静默丢写」降级为「请求报可重试」。同一个进程内对同名房间同时删与建本就无意义，不再加锁。
