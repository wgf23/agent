# 设计：房间管理（改成员 / 改 coordinator / 删除房间）

状态：**已落盘，待 manager 审**
上游输入：`docs/prd/room-management.md`（confirmed，范围冻结；D-1..D-7 + AC-1..AC-12）
下游消费者：dev（两笔提交）、qa（测试计划）、review（A/B 清单）、ui（390px 抽屉）
基线：`a079ff4`（`docs/design` 与 `docs/prd` 之外的代码基线）。**文中行号以该提交为准，会随提交漂移；每条锚点都配了逐字引句，引句才是判据。**

---

## 0. 冻结裁决清单（本设计必须逐条闭合的输入）

| 编号 | 内容 | 本设计落点 |
|---|---|---|
| D-1 | 删除 = 摘 ledger **+** 摘 config `rooms[]` | §3.2、§6.1 |
| D-2 | 照 `removeRob` 新增 `removeRoom`，复用 `writeChain` | §5.5 |
| D-3 | run 中删除 = 先 `interrupt()` 再删，不接强删 | §6.1 步骤 1 |
| D-4 | 改成员沿用 `busy` 契约，UI 显式可见 | §4、§9.3 |
| D-5 | 协议只做加性扩展 | §7 |
| D-6 | 破坏性路由必须 `X-Admin-Token`，未配置即 403（fail-closed） | §8 |
| D-7 | 删除先 `rename` 进 `<rooms>/.trash/`，不 unlink、无自动 GC | §3.2、§6.2 |
| A1 | 令牌在抽屉里手输一次，存 **sessionStorage**；服务端不回吐 | §8.3 |
| A2 | `removeRoom(config)` 对「条目不存在」= **成功 no-op**，非 404 | §5.5、§6.3 分支 C |
| A3 | 删除 **per-room 单飞**；第二个并发请求走幂等，**不得产生第二份归档** | §6.4 |
| A4 | 运行中改 coordinator 与 `setMembers` **对齐**：busy ⇒ 409 | §5.2、§4 |
| 追加-1 | archive 顺序：`deleting` tombstone → `flush()` → `mkdir .trash` → `rename` | §5.4 |
| 追加-2 | `setMembers` / `setCoordinator` 都要 **先挡 `stopped`** | §5.1、§5.2 |
| 追加-3 | `RoomStore` 只报事实，不认识 HTTP；`room_removed` 只发 `{kind, room}` | §5.4、§7.3 |
| 追加-4 | `members` 事件的 coordinator **必填 `string \| null`** | §7.2 |
| 追加-5 | 重试分支 ①–④ 互斥且写清；registry 无实例时**绝不重建 Room** | §6.3 |

### 0.1 manager 8 条闭合项 → 章节索引（review 只看这张表即可定位）

| # | 条目 | 章节 |
|---|---|---|
| 1 | API 表（PATCH / DELETE，含 400/403/404/409/501/500） | §4.1、§4.2 |
| 2 | `Room.setCoordinator` / `Team.removeRoom` / `RoomStore.archive` 签名 | §5.1、§5.3、§5.4 |
| 3 | archive 顺序（tombstone → flush → mkdir → rename → tombstone 不移除） | §5.4（代码块 1–5 编号与裁决逐字对应） |
| 4 | 删除时序（reject busy → interrupt → stop → registry.delete → archive → removeRoom(config)） | §6.1 |
| 5 | `stopped` 守卫（reason 加 `"stopped"`，在 `live` 之前判，路由 409，不改 `room-text.ts`） | §5.1、§5.2、§4.1 表 |
| 6 | 协议（`members` 必填 coordinator、新增 `room_removed`、`state.ts` 补 `default`） | §7.2、§7.3、§7.4 |
| 7 | 令牌（`requireAdminToken` 单点比较、抽屉手输 + sessionStorage、未配置 403） | §8.1–§8.4、§9 |
| 8 | 拆两笔提交 | §11 |
| + | **tombstone 与同进程重建同名房间的冲突**（manager 追加，必修） | §6.4.1 |

### 0.2 三处对上游清单的**必要更正**（请 review 按此判，不要按旧清单打回）

1. **`room_removed` 只能进 wire 类型，不能进域 `RoomEvent`**：`src/tui/team/state.ts` 有两个无 `default` 的穷尽 switch（`TeamEvent` 与 `RoomEvent`），而 `src/tui/**` 是 NF-2 禁改红线。进域事件 ⇒ typecheck 挂（"function lacks ending return statement"）。详见 §7.1。
2. **`toRoomEventInfo` 的 switch 输入是域类型 `RoomEvent`**，所以给 **wire** 类型加 `room_removed` **不会**迫使它补 case。真正必须补 case 的是 `web/src/state.ts` 的 `applyRoomEvent`（它 switch 的是 wire 类型）。
3. ~~**AC-5 的「逐字节相同」不可达**~~ **（已被 manager 2026-10-18 复核推翻，本设计自行更正）**：`stop()` 只在 `this.live !== null` 时才 `finish()`（`room.ts:715`），**AC-5 是空闲删除 ⇒ 零 persist ⇒ sha 相等可达**。整文件 sha 判据保留；只有**运行中删除（AC-7）**才需要字段级判据（§6.2）。

---

## 1. 现状勘查（事实，非推测）

| 事实 | 锚点（引句为准） |
|---|---|
| 房间集合 = `config.rooms ∪ 盘上 ledger ∪ failed`；有 ledger 就不看 config | `src/rob/team.ts` `openRooms()` 注释：「a ledger is the room's state once it exists, and only a room with no ledger is seeded from config」 |
| `Room` 只在构造时读 coordinator | `src/rob/room.ts` 构造函数 `this.coordinator = options.state.coordinator;` |
| `setMembers` 只挡 `live`，**不挡 `stopped`** | `src/rob/room.ts` `setMembers()` 首行 `if (this.live !== null) return { status: "rejected", reason: "busy" };` |
| `setMembers` 在 coordinator 被移出时清空 | 同函数 `if (this.coordinator !== null && !validation.members.includes(this.coordinator)) { this.coordinator = null; }` |
| `persist()` 是 **fire-and-forget**，调用方无法 await | `private persist(): void { void this.ledger.save(this.state()).then(…) }` |
| `stop()` 终态、幂等，内部保证 `flush()` | `stop(){ if (this.stopped) return this.stoppedPromise; … void this.completeStop(); }`；`completeStop(){ … await this.ledger.flush(); this.resolveStopped(); }` |
| `RoomStore` 只有 `read/readAll/save/flush`，**无 delete** | `src/rob/room-store.ts` 工厂返回 `{ read, readAll, save, flush }` |
| `flush()` 靠 `while (drains.size > 0)` 才真排空 ⇒ **先清表就等于假排空** | `async function flush(){ while (drains.size > 0) await Promise.allSettled([...drains.values()]); }` |
| 迟到 save 会自己重开 drain | `drain()` 的 `finally` 内 `if (pending.has(name)) void drain(name);`（`void`，不在 await 链上） |
| config 写路径存在且串行化，`removeRob` 只摘指定项 | `src/config/project-file.ts`：模块级 `let writeChain: Promise<unknown> = Promise.resolve();`；`writeRobRemoval` 用 `${JSON.stringify({ ...raw, robs: nextRobs }, null, 2)}\n`，缺失则 `Unknown rob: ${name}` |
| `rooms` 只有读，没有写 | 同文件只有 robs 的 5 个写函数（`addPermissionRule`/`addRob`/`setRobWake`/`updateRob`/`removeRob`） |
| 无 `setCoordinator`、无 `Team.removeRoom` | 全仓 grep 零命中 |
| 服务端只有 POST 三条房间路由 | `src/serve/server.ts`：`app.post("/api/rooms"`、`"/api/rooms/send"`、`"/api/rooms/interrupt"` |
| `Hub` 的房间能力是三个可选方法 | `src/serve/hub.ts`：`createRoom?(config: RoomConfig): RoomCreateOutcome;` / `sendToRoom?` / `interruptRoom?` |
| 线上 `members` 事件不带 coordinator | `shared/protocol.ts`：`| { kind: "members"; room: string; members: string[] };` |
| `toRoomEventInfo` 的 switch 输入是**域**类型 `RoomEvent`（不是 wire 类型） | `src/serve/team.ts`：`export function toRoomEventInfo(event: RoomEvent): RoomEventInfo` |
| **TUI 有两个无 `default` 的穷尽 switch**（域事件） | `src/tui/team/state.ts`：`switch (event.kind)`（`TeamEvent`）与 `switch (event.kind)`（`RoomEvent`），两者都无 `default` |
| web 靠事件就地建房，无对称删除事件 | `web/src/state.ts` `updateRoom()` 注释：「An event can name a room hello never sent, one created in another tab, so create it on the spot」 |
| 选中项在房间消失后会自动回落 | `web/src/App.tsx` effect：`state.rooms[selectedId] !== undefined` 不成立则 `setSelectedId(...)` |
| 既有非 loopback 403 先例 | `src/serve/server.ts`：`if (!isLoopbackHost(settings.host))` → 403「only allowed on a loopback bind」 |

### 1.1 由此得到的两条硬结论

1. **`persist()` 不可 await + `flush()` 依赖 drains 表** ⇒ 只做 `flush()`+`rename()` **不够**，迟到的 save 会把 `<name>.json` 写回来。必须 **store 内 tombstone 先锁门**（§5.4），不是 team 层清表。
2. **TUI 的两个 switch 没有 `default`，且 `src/tui/**` 是 PRD NF-2 的禁改红线** ⇒ `room_removed` **不得**进域 `RoomEvent` / `TeamEvent`（进了就必然迫使改 `src/tui/team/state.ts`，typecheck 红）。它只能进 **wire 类型** `RoomEventInfo`（§7.1）。这是本设计对 review 清单的一处**必要更正**。

---

## 2. 设计总览

```
浏览器(390px 抽屉)                     serve                     Team                     Room / Store
  ── PATCH /api/rooms/:name ──► guard(令牌) ──► hub.updateRoom ──► team.updateRoomSettings ──► room.updateSettings
  ── DELETE /api/rooms/:name ─► guard(令牌) ──► hub.removeRoom ──► team.removeRoom ────────► room.stop ─► store.archive
                                                       │                                     └► removeRoomConfig
                                                       └── emit {type:"room", event:{kind:"room_removed", room}}  ← wire-only
```

- 破坏性动作**只有两条路由**，都过同一个 `requireAdminToken`（单点比较，AC-11d）。
- 事件只加性：`members` 扩必填 coordinator（域 + wire 同改）；`room_removed` **只加在 wire**。

---

## 3. 数据模型

### 3.1 ledger（不变）

`~/.local/share/my-agent/rooms/<workspace-slug>/<name>.json`，`storedRoomSchema` 严格模式，字段见 `src/rob/room-store.ts`。本设计**不新增、不改名、不加版本号**。

### 3.2 回收目录（新增，D-7）

```
<rooms>/                      ← roomsRoot()/projectSlug(workspaceRoot)
  rnd.json
  ppp.json
  .trash/                     ← 新增；与 ledger 同文件系统 ⇒ rename 原子、零拷贝
    ppp.1760770000000.json    ← <name>.<epochMs>.json
    ppp.1760770000000-1.json  ← 同名同毫秒冲突时追加 -1/-2（见 §6.5，绝不静默覆盖）
```

三条不变量：

- **`.trash` 必须是 `<rooms>` 的直接子目录**（跨设备 `rename` 会退化成 copy+unlink，非原子）。**禁止** `/tmp`。
- **`readAll()` 不会读到 `.trash` 里的文件**：它只取 `entry.endsWith(".json")` 的目录项，`.trash` 是目录名、不带 `.json` 后缀。**禁止**把归档平铺进 `<rooms>/`（会被当房间加载）。
- 归档文件**只增不减**，无自动 GC（D-7）。人工清理方法写在 **`docs/rnd-team.md`**（`ls -lt .trash/` 查看、`mv` 回 `rooms/` 恢复、**禁止批量 `rm -rf`**），不进代码。

### 3.3 幂等状态（不落盘，进程内）

| 结构 | 归属 | 生命周期 | 作用 |
|---|---|---|---|
| `deleting: Set<RoomName>` | `createRoomStore` 闭包 | 与进程同寿；**不移除** | tombstone：`save()` 见到即丢弃，杜绝「假删」 |
| `inFlight: Map<RoomName, Promise<RoomRemoveOutcome>>` | `Team` | 请求级 | per-room 单飞（A3） |

**不引入** 磁盘 tombstone / `deleted: true` 标记（PRD D-2 否决）：多一个状态源就多一条漂移路径。

**不加** 进程重启后的幂等：进程重启后 `deleting` 为空，但此时 ledger 已在 `.trash`、config 已摘 ⇒ 走 §6.3 分支 C/D，结果一致。

---

## 4. API 表

两条路由都挂在同一个 `buildApp` 作用域内（与既有房间路由同处），**注册顺序不影响**：Fastify 优先匹配静态段 `/api/rooms/send`、`/api/rooms/interrupt`，参数段 `:name` 只接剩下的。

### 4.1 `PATCH /api/rooms/:name`

请求头：`Content-Type: application/json`、`X-Admin-Token: <token>`
请求体（`updateRoomBody`，`.strict()`，**至少一个字段**）：

```json
{ "members": ["pm","architect","dev"], "coordinator": "pm" }
{ "coordinator": null }
```

成功 200：

```json
{ "ok": true, "room": { "name": "rnd", "members": [...], "coordinator": "manager", ... } }
```

`room` 恒为 `toRoomInfo(outcome.room)`（与 `POST /api/rooms` 的 `room` 同形），客户端可直接 `dispatch({type:"room_created", room})` 的既有 reducer 忽略（房间已存在），也可只靠事件。

| 状态 | 触发 | 体 |
|---|---|---|
| 200 | 应用成功 | `{ok:true, room}` |
| 400 | 体不是对象 / 两字段都缺 / `members` 非 `string[]` / `coordinator` 非 `string\|null` | `{error:"expected {members?, coordinator?} with at least one field"}` |
| 400 | 校验拒（`member_count`/`unknown_member`/`duplicate_member`/`reserved_member`/`coordinator_not_member`） | `{error: renderRoomOutcome(outcome, name)}`（文案复用 `room-text.ts`，界面不得自造） |
| 403 | 令牌缺失或错误（**同一句、同码，不区分**） | `{error:"Admin token required."}` |
| 404 | `roomRegistry` 无此实例 | `{error:'Unknown room "x".'}` |
| 409 | `busy`（`live !== null`） | `{error:'Room "x" is busy.'}` |
| 409 | `stopped`（实例已 stop，等 registry 摘除） | `{error:'Room "x" is stopped.'}` |
| 501 | hub 不实现 `updateRoom`（如 solo hub） | `{error:"this server cannot manage rooms"}` |
| 500 | `persist()` 之外的同步抛错 | `{error: <message>}` |

**校验顺序写死**：`guard(403)` → 路由存在性 `501` → 参数/体 `400` → 路由体校验委派 `room.updateSettings` → `404`/`409` 映射 → `200`。
**403 必须在任何写之前**（AC-11a「零写入」）。

### 4.2 `DELETE /api/rooms/:name`

请求头同上，**无请求体**。
成功 200：

```json
{ "ok": true, "removed": { "name": "ppp", "archived": true } }
```

`archived:false` 只出现在「从未落盘的房间」（分支 A 中 ledger 缺失、分支 C 中 `missing_source`）。

| 状态 | 触发 | 体 |
|---|---|---|
| 200 | 已删除（含分支 A/B/C） | `{ok:true, removed:{name, archived}}` |
| 403 | 令牌缺失/错误 | `{error:"Admin token required."}` |
| 404 | 从未存在；或分支 D 已完成（三处皆无） | `{error:'Unknown room "x".'}` |
| 500 | `archive` 失败（stage=`archive`） | `{error, stage:"archive", detail}`；语义：**盘上不变、重启会回来、可重试** |
| 500 | config 摘除失败（stage=`config`） | `{error, stage:"config", detail}`；`error` 文案**必须含**「重启后会重建」 |
| 501 | hub 不实现 `removeRoom` | `{error:"this server cannot manage rooms"}` |

**`stage` 是加性字段**：老客户端只读 `error` 也不崩。

### 4.3 不做的事

- 不做 `GET /api/rooms`（房间数据只经 SSE `hello` 首帧，`docs/design/room-max-members.md` §3 已定）。
- 不做批量删除、不做房间重命名、不做成员增量 add/remove。
- 不在路由层复制任何成员校验规则（PRD FR-1.2）。

---

## 5. 签名与调用链

### 5.1 `Room.updateSettings`（新增，唯一写入面）

```ts
// src/rob/room.ts，紧邻 setMembers
export interface RoomSettingsPatch {
  readonly members?: readonly string[];
  readonly coordinator?: RoomName | null;
}
export type RoomSettingsOutcome =
  | { readonly status: "ok"; readonly room: RoomView; readonly coordinator: RoomName | null }
  | { readonly status: "rejected"; readonly reason: RoomMembershipReason };

updateSettings(patch: RoomSettingsPatch): RoomSettingsOutcome {
  // 1) 先挡 stopped（追加-2）：stop 完的实例不得再写，否则会把刚归档的房间写回来
  if (this.stopped) return { status: "rejected", reason: "stopped" };
  // 2) 再挡 live（D-4 / A4）：一轮的参与者名单不能中途变
  if (this.live !== null) return { status: "rejected", reason: "busy" };
  // 3) 校验（唯一来源；顺序 = 人数 → 保留名 → 重复 → roster）
  const validated = patch.members === undefined
    ? null
    : validateRoomMembers(patch.members, this.host.members());
  if (validated?.status === "rejected") return validated;
  const nextMembers = validated?.members ?? this.memberNames();
  // 4) coordinator 校验对新名单做（避免「先设协调者再移除他」的顺序陷阱）
  const nextCoordinator =
    patch.coordinator === undefined ? this.coordinator : patch.coordinator;
  const coordCheck = validateRoomCoordinator(nextCoordinator ?? undefined, nextMembers);
  if (coordCheck.status === "rejected") return coordCheck;   // reason: "coordinator_not_member"
  // 5) 一次性应用：一次 persist、一条事件
  if (validated !== null) { /* 按 §5.1.1 保留 seen 游标重建 this.members */ }
  this.coordinator = nextCoordinator;
  this.emit({ kind: "members", room: this.name, members: this.memberNames(), coordinator: this.coordinator });
  this.persist();
  return { status: "ok", room: this.view(), coordinator: this.coordinator };
}
```

要点：

- **原子**：`members` 与 `coordinator` 任一项非法 ⇒ **零改动**（PRD AC-3/AC-4「ledger 不变」）。既不半改也不双写。
- **一次 persist、一条事件**：避免两个字段两次广播造成手机端中间态。
- **不新增 import**（PRD FR-2.1）：`validateRoomCoordinator` 与 `validateRoomMembers` 同文件。
- **`stop` 守卫在 `live` 之前**（追加-2 原文顺序）。

#### 5.1.1 成员游标保留（不得回退行为）

`setMembers` 现有实现用 `Map(this.members.map(m => [m.name, m.seen]))` 保留每个成员「已看到哪条」。`updateSettings` 必须沿用同一段逻辑（`cursors.get(name) ?? 0`），否则改一次成员会让所有 rob 重读全部历史。**这段代码从 `setMembers` 平移，不重写。**

### 5.2 旧方法保留为薄委托（TUI 路径零改动）

```ts
setMembers(members: readonly string[]): RoomMembershipOutcome {
  const outcome = this.updateSettings({ members });      // 返回形状不变
  return outcome.status === "ok"
    ? { status: "ok", members: outcome.room.members, coordinator: outcome.coordinator }
    : outcome;
}
setCoordinator(coordinator: RoomName | null): RoomSettingsOutcome {
  return this.updateSettings({ coordinator });
}
```

- `setMembers` 的**返回类型与语义完全不变** ⇒ `src/tui/**`、`team.setRoomMembers`、`renderRoomOutcome` 全部不动。
- `setCoordinator` 单独存在（manager 要求「单独一条」），但内部与 `setMembers` 共用同一守卫与校验，**不可能漂移**。
- `RoomMembershipReason` 扩两个成员：`"stopped"`、`"coordinator_not_member"`。**`room-text.ts` 零改动**——两者的文案 case 都已存在（`Room "…" is stopped.`、`The coordinator must be a member of the room.`）。

### 5.3 `Team` 层

```ts
// src/rob/team.ts，紧邻 setRoomMembers（`setRoomMembers` 实际在 team.ts:616）
updateRoomSettings(room: RoomName, patch: RoomSettingsPatch): RoomSettingsOutcome {
  const target = this.roomRegistry.get(room);
  if (target === undefined) return { status: "rejected", reason: "unknown_room" };
  return target.updateSettings(patch);
}

removeRoom(room: RoomName): Promise<RoomRemoveOutcome>   // 见 §6
```

`src/serve/hub.ts` 的 `Hub` 接口加两个可选成员（与既有「Only a hub with a rob roster manages rooms」同一段）：

```ts
updateRoom?(room: string, patch: RoomSettingsPatch): RoomSettingsOutcome;
removeRoom?(room: string): Promise<RoomRemoveOutcome>;
```

`TeamHub`（`src/serve/team.ts`）实现：`updateRoom` 直接转发；`removeRoom` 转发后在成功时 `this.emit({ type: "room", event: { kind: "room_removed", room } })`。
`CompositeHub`（`src/serve/composite.ts`）两行转发（照 `createRoom` 的既有写法）。

### 5.4 `RoomStore.archive`（store 只报事实，追加-1/追加-3）

```ts
// src/rob/room-store.ts
export type RoomArchiveOutcome =
  | { status: "archived"; from: string; to: string }
  | { status: "already_archived"; to: string }
  | { status: "missing_source" }
  | { status: "failed"; error: string };

export interface RoomStore {
  read(room: RoomName): ReadRoomResult;
  readAll(): { records: StoredRoom[]; failed: Array<{ name: string; error: string }> };
  save(state: RoomState): Promise<SaveRoomResult>;
  flush(): Promise<void>;
  archive(room: RoomName): Promise<RoomArchiveOutcome>;   // 新增
  isDeleted(room: RoomName): boolean;                    // 新增，同步只读；见 §6.4.1
}
```

实现顺序**写死**（这就是 review 追加-1 的冻结口径）：

```ts
async function archive(room: RoomName): Promise<RoomArchiveOutcome> {
  deleting.add(room);                    // 1. 先锁门：此后任何 save 一律丢弃
  await flush();                         // 2. flush 不改内部（drains 表完整）⇒ 真正排空在飞写入
  try { await mkdir(trashDir, { recursive: true }); } catch (e) { return failed(e); }   // 3.
  const source = roomPath(room);
  if (!existsSync(source)) {             // 4. 源已不在：只报事实
    const existing = newestArchive(room);          // glob `<name>.*.json`
    return existing === null ? { status: "missing_source" } : { status: "already_archived", to: existing };
  }
  const to = uniqueArchivePath(room);    // 5. `<name>.<ms>.json`，已存在则 `-1`、`-2`…（绝不覆盖）
  try { await rename(source, to); } catch (e) { return failed(e); }   // 同目录 ⇒ 原子
  return { status: "archived", from: source, to };
}
```

`save()` 开头新增两行：

```ts
function save(state: RoomState): Promise<SaveRoomResult> {
  // 一次删除已开始：该房间不再存在，迟到的写入既不入 pending 也不排 drain。
  if (deleting.has(state.name)) return Promise.resolve({ ok: true, path: roomPath(state.name) });
  …
}
```

三点必须理解：

1. **为什么**：`persist()` 是 `void this.ledger.save(...)`（不可 await）；`drain()` 的 finally 里 `if (pending.has(name)) void drain(name)`（不在 await 链上）。⇒ 「await 在飞 promise」不足以收敛，必须结构性拒绝后续写入。tombstone 是唯一能做这件事的位置（`pending`/`drains` 是闭包私有，team 层碰不到）。
2. **不加锁就竞态**：`deleting` 必须在 `flush()` **之前**加。先 flush 后加锁 = 中间窗口仍可写入。
3. **不返回 HTTP 语义**（追加-3）：`already_archived` / `missing_source` 是事实描述，404/409/500 全在路由层映射（§6.3）。

`RoomStore` 的 `deleting` **不移除条目**（房间已不存在，进程与其同寿）。

### 5.5 `removeRoom(config)`（照 `removeRob`，D-2/A2）

```ts
// src/config/project-file.ts，紧邻 removeRob
export function removeRoom(workspaceRoot: string, name: string): Promise<WriteResult> {
  const run = writeChain.then(() => writeRoomRemoval(workspaceRoot, name));
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function writeRoomRemoval(workspaceRoot: string, name: string): Promise<WriteResult> {
  // 读 → JSON.parse → projectFileSchema → 从 raw.rooms 过滤同名项
  // 条目不存在 ⇒ { ok: true }        ← A2：成功 no-op，不是错误
  // 成功 ⇒ writeFile(`${JSON.stringify({ ...raw, rooms: nextRooms }, null, 2)}\n`)
}
```

差异对照（**只有一处**与 `removeRob` 不同，必须写在注释里）：

| | `writeRobRemoval` | `writeRoomRemoval` |
|---|---|---|
| 目标数组 | `robs` | `rooms` |
| 条目缺失 | `{ok:false, error:\`Unknown rob: ${name}\`}` | `{ok:true}`（**A2**：runtime 建的房间本来就没有 config 条目） |
| 其余键 | 逐字节保留 | 同 |
| 串行化 | 模块级 `writeChain` | 同（同一把链，避免与 rob 写并发互撕） |

`rooms` 字段原本不存在时：`Array.isArray(raw.rooms) ? raw.rooms : []`，过滤后若与原数组等长且原本缺失 ⇒ 直接 `{ok:true}` 不写盘（避免无意义写）。

---

## 6. 删除时序与失败语义

### 6.1 主路径（顺序不可换）

```
DELETE /api/rooms/:name
 1. guard：令牌（§8）。失败 ⇒ 403，零写入。
 2. Team.removeRoom(name)：
    a. 单飞：inFlight.has(name) ⇒ 复用同一 promise（A3，§6.4）
    b. 取 instance = roomRegistry.get(name)
    c. instance 存在：
        c1. instance.view().run.phase === "running" ⇒ instance.interrupt()     ← D-3，产出 run_ended/interrupted
        c2. await instance.stop()        ← 终态；completeStop 内已 await ledger.flush()，不再重复 flush
        c3. roomRegistry.delete(name)    ← 先摘实例，再动文件
    d. await roomStore.archive(name)    ← §5.4；store 只报事实
    e. removeRoomConfig(name)           ← §5.5；缺失 = 成功
    f. 成功 ⇒ hub 广播 {kind:"room_removed", room}
```

为什么 `c3` 必须在 `d` 之前：实例还在 registry 里就可能被 PATCH 到并 `persist()`（`persist` 不可 await，无法外部拦住）。摘掉实例 + `stopped` 守卫 + store tombstone 是**三道**独立保险，缺任一都可能复活。

为什么 `c2` 之后不需要再 `flush()`：`completeStop()` 已 `await this.ledger.flush()`；再调一次无害但会掩盖真实依赖（PRD FR-3.2 明确禁止）。

### 6.2 归档产物核对：两条路径，两套判据

**先分清删除时房间是否在跑**——这决定 `stop()` 会不会写盘，进而决定字节会不会变。

| 路径 | `stop()` 的行为（`src/rob/room.ts:712-718`） | 是否 persist | 字节 |
|---|---|---|---|
| **空闲删除**（`live === null`，= **AC-5**） | `if (this.live !== null) this.finish(...)` **不成立** ⇒ 不 `finish` ⇒ 不 `persist` | **零写入**（`completeStop` 的 `flush()` 也零写入） | **`rename` 原样搬走，sha 相等** |
| **运行中删除**（`live !== null`，= **AC-7**） | `finish(live,"stopped")` ⇒ `persist()` ⇒ `write()` 刷 `updatedAt`（`room-store.ts:158`）+ 追加 `run_ended` | 至少一次 | 必然 ≠ 删除前字节 |

#### 6.2.1 空闲删除（AC-5）：**逐字节相同，sha 相等** — 不降级

**保留 PRD 原文的「逐字节相同」**。这是「移走而非重写」的硬判据：归档文件必须与删除前 `rooms/<name>.json` 的 **sha256 完全相等**。任何字节差异都说明删除路径在动了文件之后还发生了写入 ⇒ 失败（而不是「可接受的 updatedAt 差异」）。

取证（qa）：

```bash
sha256sum rooms/rnd.json                      # ① 删除前
sha256sum rooms/rnd.json                      # ② 立刻再取一次 —— 必须与 ① 相同（静默点）
curl -X DELETE -H "X-Admin-Token: $T" localhost:3939/api/rooms/rnd
sha256sum rooms/.trash/rnd.*.json             # ③ 必须与 ① 逐字节相等
test ! -e rooms/rnd.json && echo "source gone"
```

**前置条件（必写进 qa 用例）：快照必须取在静默点。** `archive()` 内部有 `await flush()`（§5.4），它会把**在飞**的写入落盘；如果取快照时刚有一轮 `run_ended` 还在排队，sha 天然不等 —— **那不是缺陷**。判定静默点的方法：连续两次 `sha256sum` 结果相同（间隔 ≥ 1s），且 `hello` 首帧该房间 `run.phase !== "running"`、`queue` 为空。

#### 6.2.2 运行中删除（AC-7）：字段级判据

`finish()` 追加 `run_ended` 且 `updatedAt` 必刷 ⇒ 整文件 sha 判据在**这条路径上**不可达，改用字段级：

| 字段 | 要求 |
|---|---|
| `members` | 与删除前**逐项相等**（含顺序） |
| `coordinator` | 相等 |
| `createdAt` | 相等 |
| `transcript` | 删除前的 transcript 必须是归档 transcript 的**前缀**（逐条相等） |
| `runOpen` | **必须为 `false`** |
| 允许差异 | **仅两处**：① `updatedAt` 不同；② `transcript` 末尾**至多一条** `run_ended` 类 system 条目 |

超出这个集合即为失败（不允许 `members` 顺序变化、不允许 transcript 中间插入、不允许 `queue` 残留）。

```bash
jq -S '{members,coordinator,createdAt,runOpen}' rooms/.trash/rnd.*.json
jq '.transcript | length' rooms/.trash/rnd.*.json   # 与删除前比，至多 +1
```

> **本节口径变更记录**：上一版把上面这张表标成「AC-5 冻结判据、替换 PRD 原文」——**错误**。该表的前提是 `finish()` 被调过；而 AC-5 是空闲删除，`stop()` 在本文件 715 行的判空后**不会**调 `finish()`。AC-5 恢复 PRD 原文的 sha 判据，该表降级为 **AC-7 专用**。（manager 2026-10-18 复核更正。）

#### 6.2.3 两条路径共同的恢复核对（AC-6 恢复对照）

归档文件内容 ⇒ 人工 `mv` 回 `<rooms>/<name>.json` 重启后，房间与 transcript 完整回来，且**不会**因 `runOpen:true` 触发 `renderRestartNotice()`（空闲删除本就没改 `runOpen`；运行中删除已被 `finish` 落成 `false`）。

### 6.3 重试分支矩阵（互斥，registry 无实例时**绝不重建 Room**）

| # | registry | `<rooms>/<name>.json` | `.trash/<name>.*.json` | config `rooms[]` | 分支动作 | 结果 |
|---|---|---|---|---|---|---|
| A | 有实例 | 可能有 | — | — | interrupt? → stop → registry.delete → archive → removeRoomConfig | 200（`archived` 视 archive 结果） |
| B | 无 | **有** | — | — | **只 archive，绝不 `new Room()`** → removeRoomConfig | 200 |
| C | 无 | 无 | **有** | 有 | `already_archived` ⇒ 只 removeRoomConfig | 200 |
| D | 无 | 无 | 有 | 无 | 什么都不做 | **404**（PRD FR-3.5：UI 视为已完成） |
| E | 无 | 无 | 无 | 有（从未落盘的种子房） | `missing_source` ⇒ removeRoomConfig | 200 |
| F | 无 | 无 | 无 | 无 | 什么都不做 | **404**（从未存在） |

- **B 是 A3 的关键**：并发/重试时第二个请求看到的正是「registry 无、ledger 在」。此处若重建实例再 `stop()` 就会二次 `persist` 并二次归档。写死：**分支 B 只调 `store.archive`**。
- 表里 A 与 B 的区分**只由 `roomRegistry` 决定**，其它三列只用于归档结果判定。
- `.trash` 里的历史归档**永不参与**除 `C/D` 判定外的任何流程（不读取内容、不 GC）。

### 6.4 并发单飞（A3）

```ts
// src/rob/team.ts
private readonly roomRemovals = new Map<RoomName, Promise<RoomRemoveOutcome>>();

removeRoom(room: RoomName): Promise<RoomRemoveOutcome> {
  const active = this.roomRemovals.get(room);
  if (active !== undefined) return active;               // 第二个并发请求复用结果 ⇒ 天然幂等
  const task = this.removeRoomNow(room).finally(() => {
    if (this.roomRemovals.get(room) === task) this.roomRemovals.delete(room);
  });
  this.roomRemovals.set(room, task);
  return task;
}
```

- `finally` 必须**释放**键，否则一次异常会把该房间永久卡在「删除中」。
- 复用 promise 而不是「返回 409 busy」：两个并发 DELETE 的语义是「同一件事」，返回同一结果比让第二个 409 更符合 AC-7/FR-3.5。
- store 侧 `deleting` 是第二道：即便单飞失效，`archive` 的 `already_archived` 也会阻止第二份归档。

### 6.4.1 tombstone 与「同进程重建同名房间」的冲突（manager 追加，必修）

**漏洞**：`deleting` 与进程同寿且**不移除**（§5.4），而 `Team.createRoom` 只查 `this.roomRegistry.has(name)`（`src/rob/team.ts`：「The only place a Room is constructed.」）。
⇒ 删掉 `rnd` 之后，本进程内再 `POST /api/rooms {name:"rnd"}` **会创建成功**，但该实例的每一次 `persist()` 都被 store 的 tombstone 静默丢弃（`save()` 早退成 `{ok:true}`）⇒ **房间能跑、能聊天，重启后凭空消失**。这是比「假删」更糟的静默数据丢失。

**修法（写死）：**

```ts
// src/rob/room-store.ts ── RoomStore 加一个同步只读查询
isDeleted(room: RoomName): boolean;        // return deleting.has(room);

// src/rob/team.ts ── createRoom，在 roomRegistry 检查之后、其它校验之前
if (this.roomRegistry.has(name)) return { status: "rejected", reason: "duplicate" };
if (this.roomStore.isDeleted(name)) return { status: "rejected", reason: "duplicate" };  // ← 新增
```

三条约束：

1. **必须复用 `"duplicate"`，不得新增枚举成员**。`renderRoomOutcome`（`src/rob/room-text.ts`）对 `reason` 是穷尽 switch，而该文件在**禁改**清单（§13）；新增成员会直接 tsc 红。`duplicate` 的既有文案「A room named "x" already exists.」语义正好，且与用户直觉一致（这个名字本进程内已被删除，重启前不可复用）。
2. **不要为了复用而 revive tombstone**（不得从 `deleting` 移除名字）。删除的语义是「这个房间不复存在」；本进程内重建会立刻又踩回静默丢写。重启后 tombstone 清空、ledger 不在、config 已摘 ⇒ 名字自然可复用，语义自洽。
3. **不改 `POST /api/rooms` 的状态码映射**：既有实现把所有 `rejected` 映射 400。本设计新增的这条拒绝走同一分支 ⇒ **400**。

**口径已裁决（manager 2026-10-18）：保持 400，不改成 409**。理由同 PRD AC-12（既有 `POST /api/rooms` 行为不变），且新增枚举会撞 `room-text.ts` 的穷尽 switch。本设计的三条约束原样获准：复用 `"duplicate"`、不 revive、不改既有映射。

**测试（B 笔必带）**：
- `test/rob/team-rooms.test.ts`：删除后同进程 `createRoom` 同名 ⇒ `{status:"rejected", reason:"duplicate"}`；
- 重启语义（tombstone 清空后可重建）**不进单测**（进程级，单测里没有「新进程」），属 **PRD AC-13b** 人工对照：`stop` + 重启 serve ⇒ 同名 `POST` 成功 ⇒ 发一条消息 ⇒ 再重启 ⇒ 房间与消息仍在。AC-13a（同进程重建被拒、不产生同名 ledger）由 `test/rob/team-rooms.test.ts` 覆盖——本设计的 `createRoom` 守卫在 `new Room(...)` 之前返回，结构上不可能写盘。

### 6.5 部分失败语义（逐阶段）

| 失败点 | 盘上状态 | registry | 返回 | 用户可见 | 重试语义 |
|---|---|---|---|---|---|
| 1 guard | 未变 | 未变 | 403 | 「令牌无效」 | 换令牌 |
| c1 interrupt 抛错 | 未变 | 未变 | 500 stage=`stop` | 「删除失败，房间仍在」 | 可重试 |
| c2 stop 抛错 | 可能已落一次终态 | **已 stopped** | 500 stage=`stop` | 同上 | 可重试：下次走分支 B（实例仍在 registry 但已 stopped ⇒ c2 幂等 resolves） |
| d archive `failed` | **ledger 仍在** | 已摘 | 500 stage=`archive` | 「删除未完成，请重试」 | 可重试（分支 B） |
| e config 失败 | ledger 已在 `.trash` | 已摘 | 500 stage=`config` | **「重启后会重建」** | 可重试（分支 C） |
| 归档目标同名 | — | — | — | — | `-1`/`-2` 后缀，**不覆盖** |

`c2` 抛错后的特殊约定：`stop()` 是终态且幂等（`if (this.stopped) return this.stoppedPromise;`）。若 `completeStop` 的 `flush()` rejection 冒泡，实例**已在 registry 之外还是之内？** 本设计定为：**仍留在 registry 直到 `d` 成功**——即 `c3` 放在 `d` 之后？**不。** 明确：`c3` 紧跟 `c2`（先摘实例再动文件，防 persist 复活）。`c1`/`c2` 抛错时**不执行** `c3`，房间保持可用（可重试）。`c3` 之后 `d` 失败才需要「重启会回来」。

---

## 7. 协议加性 diff

### 7.1 关键裁决：`room_removed` 只进 wire，不进域

`shared/protocol.ts` 的 `RoomEventInfo`（wire）与 `src/rob/room.ts` 的 `RoomEvent`（域）是**两个类型**。TUI 只吃域事件（`TeamEvent → RoomEvent`，`src/tui/team/state.ts` 两个无 `default` 的 switch），web 只吃 wire 事件。

⇒ 若把 `room_removed` 加进域 `RoomEvent`，`applyRoomEvent`（TUI）会因「function lacks ending return statement」在 typecheck 挂掉，而 `src/tui/**` 是禁改红线。
⇒ 因此：**`room_removed` 只加进 wire `RoomEventInfo`**，由 `TeamHub` 在删除成功后直接 `emit`（不经过域事件、不经过 `toRoomEventInfo`）。

**由此更正 review 清单的一处**：`toRoomEventInfo(event: RoomEvent): RoomEventInfo` 的 switch 输入是**域**类型，加 wire 联合成员**不会**迫使它补 case。真正必须补 case 的是 `web/src/state.ts` 的 `applyRoomEvent`（它 switch 的是 wire 类型）。

### 7.2 `members` 事件扩 coordinator（必填）

```diff
 // shared/protocol.ts  ── RoomEventInfo
-  | { kind: "members"; room: string; members: string[] };
+  | { kind: "members"; room: string; members: string[]; coordinator: string | null };
```

```diff
 // src/rob/room.ts  ── RoomEvent
   | {
       readonly kind: "members";
       readonly room: RoomName;
       readonly members: readonly RobName[];
+      readonly coordinator: RoomName | null;
     };
```

**必填、不留 `?`**（追加-4）：留 optional 就会出现 `undefined` 一路传到手机端并覆盖成「无协调者」。

四处同改清单（缺一即漂移）：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `shared/protocol.ts` | wire `members` 加必填 `coordinator: string \| null` |
| 2 | `src/rob/room.ts` | 域 `members` 加必填 `coordinator: RoomName \| null`；两处 `emit` 填值（`updateSettings` 与既有 `setMembers` 委托后只有一处） |
| 3 | `src/rob/team.ts` | `createRoom` 的 `this.emit({ kind: "room", event: { kind: "members", room: name, members: validation.members } })` 补 `coordinator: coordinator ?? null` |
| 4 | `src/serve/team.ts` | `toRoomEventInfo` 的 `case "members"` 补 `coordinator: event.coordinator` |
| 5 | `web/src/state.ts` | `case "members"` 同时写 `members` 与 `coordinator` |

**测试侧必然受影响的 6 处**（必填字段 ⇒ 构造字面量要补）：`test/tui/team/state.test.ts:312`、`test/serve/team.test.ts:451`、`test/web/state.test.ts:515`、`test/web/state.test.ts:591`、`test/rob/team-rooms.test.ts:122`、`test/rob/room.test.ts:1093`。补 `coordinator: null` 即可，**不改断言语义**。`test/tui/**` 不是 `src/tui/**`，允许改。

### 7.3 新增 `room_removed`（仅 wire）

```diff
 // shared/protocol.ts  ── RoomEventInfo
+  | { kind: "room_removed"; room: string };
```

**只带 `room`，不带 `archivedPath`**（追加-3）：绝对路径会经 SSE 广播给局域网所有客户端。

广播点（唯一）：`src/serve/team.ts` 的 `TeamHub.removeRoom` 成功分支。

### 7.4 web 侧 reducer

```diff
 // web/src/state.ts ── applyRoomEvent
 	switch (event.kind) {
 		case "members":
 			return updateRoom(state, event.room, (room) => ({
 				...room,
 				members: event.members,
+				coordinator: event.coordinator,
 			}));
+		case "room_removed": {
+			if (state.rooms[event.room] === undefined) return state;
+			const next = { ...state.rooms };
+			delete next[event.room];
+			return { ...state, rooms: next };
+		}
 		…
+		default:
+			// 新事件先到、老客户端后升级：宁可不知道，也不能让 state 变 undefined。
+			return state;
 	}
```

`default: return state` 是**硬要求**（追加-3/manager B 组）：当前 `applyRoomEvent` 是穷尽 switch，未来服务端加事件时老 bundle 会**整棵树变 undefined**（白屏），而不是忽略。加上 default 后 `noFallthroughCasesInSwitch` 不受影响。

选中项回落**无需新代码**：`web/src/App.tsx` 的 effect 已按 `state.rooms[selectedId] !== undefined` 重置（引句见 §1）。

### 7.5 字节级事件样例

`members`（改 coordinator 后）：

```
event: room
data: {"type":"room","event":{"kind":"members","room":"rnd","members":["manager","pm","architect","dev","qa","review","ci"],"coordinator":"manager"}}

```

删除成功后：

```
event: room
data: {"type":"room","event":{"kind":"room_removed","room":"ppp"}}

```

（两行都按 `GET /api/events` 既有 SSE 帧格式：`event: <type>\n` + `data: <json>\n\n`。）

---

## 8. 令牌（D-6 / A1）

### 8.1 来源与解析（启动时一次）

`src/serve/admin-token.ts`（新增，唯一实现）：

```ts
export interface AdminTokenContext {
  readonly token: string | null;
  readonly source: "env" | "file" | "none";
}
export function resolveAdminToken(input: {
  env: Record<string, string | undefined>;
  workspaceRoot: string;
  onNotice?: (line: string) => void;   // → process.stderr.write
}): AdminTokenContext;
export function adminTokenMatches(ctx: AdminTokenContext, presented: string | undefined): boolean;
```

解析顺序（读到即停）：

1. `env.MY_AGENT_ADMIN_TOKEN`，非空（`trim()` 后）⇒ `source:"env"`；
2. `<workspaceRoot>/.my-agent/admin-token`，存在且可读 ⇒ `trim()` 后非空才用，`source:"file"`；文件权限**复核 0600**，若非 0600 打一行 notice（`admin token file is <mode>, expected 600`）但仍使用（fail-open 只针对**权限告警**，不放行未配置）；
3. 都没有 ⇒ `{ token: null, source: "none" }`。

`.my-agent/` 已在 `.gitignore`（第 4 行 `.my-agent/`），令牌**不会入库**。

**不生成**（默认）：未配置 ⇒ 服务端一律 403（A1 裁决）。首次使用由运维在**本机**放一次：
```bash
mkdir -p .my-agent && umask 077 && head -c 32 /dev/urandom | base64 > .my-agent/admin-token
```
或 `export MY_AGENT_ADMIN_TOKEN=…`。**生成与否是待拍板项**（§12 第 1 条）。

### 8.2 比较（单点，AC-11d）

```ts
export function adminTokenMatches(ctx: AdminTokenContext, presented: string | undefined): boolean {
  if (ctx.token === null || presented === undefined) return false;          // fail-closed
  const expected = Buffer.from(ctx.token, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;                      // 先比长度，避免 timingSafeEqual 抛错
  return timingSafeEqual(expected, actual);                                 // node:crypto
}
```

- **全仓只允许这一处**比较逻辑；两条路由共用一个 `requireAdminToken(request)` 闭包（在 `buildApp` 里创建一次，返回 `null` 表示放行、返回 `{code:403, error}` 表示拒绝）。对比函数 `adminTokenMatches` 是它的唯一内核。
- **禁止**在路由里出现 `===` 比较令牌（review 按 AC-11d 查 diff）。
- 缺失与错误返回**同一句** `Admin token required.`（AC-11b 不泄露）。

### 8.3 客户端（A1）

- 抽屉里有「管理令牌」输入框（`type="password"`，`autocomplete="off"`）。
- 存 **`sessionStorage`**（键 `my-agent.admin-token`），**不落 localStorage**：关标签页即失效。
- 读取方式沿用仓库既有可注入存储范式（`web/src/theme.ts` 用 `Pick<Storage,"getItem">` 注入，便于纯函数单测）。
- 服务端**任何响应都不回吐令牌**：`hello`、`RoomInfo`、错误体、日志全部不含令牌或其片段（日志只记 `ok|denied`）。
- 令牌错误时的 UI 文案固定为「令牌无效或未配置」，**不区分两者**（与服务端同码同句一致）。

### 8.4 审计日志（AC-11e）

一行一次尝试，`stderr`：

```
2026-10-18T01:40:12.345Z admin action=delete room=ppp ip=192.168.5.20 result=denied
2026-10-18T01:40:19.008Z admin action=patch room=rnd ip=127.0.0.1 result=ok
```

字段固定 `ts / action / room / ip / result`，`result ∈ {ok, denied, error}`。**不含令牌、不含哈希、不含成员列表。**

---

## 9. UI（390px 抽屉）

### 9.1 组件与落点

| 文件 | 动作 |
|---|---|
| `web/src/components/RoomSettingsDrawer.tsx`（新增） | 抽屉本体；复用 `.modal-backdrop` / `.modal` 既有骨架（`role="dialog"`、Esc、点背景关闭） |
| `web/src/components/RoomView.tsx` | **`.bot-header` 末尾新增 `.bot-header-actions`**（`display:flex; align-items:center; gap:6px; flex:none`）+ `.icon-btn` + 现成 `GearIcon`，`aria-haspopup="dialog"`、`aria-label="房间设置"`；关闭后焦点回该按钮 |
| `web/src/room-admin.ts`（新增，**纯函数 + 令牌存取**） | **A 笔**：`toggleMember`、`reconcileCoordinator`、`settingsChanged`、`canSaveSettings`、`settingsPatch`、`readAdminToken`/`saveAdminToken`（`ADMIN_TOKEN_STORAGE_KEY = "my-agent.admin-token"`，sessionStorage）；**B 笔追加**：`canDeleteRoom({typed, room, token})`、`removeRoomFromState` |
| `web/src/useHub.ts` | `updateRoomSettings(room, patch)`、`deleteRoom(room)`；统一发 `X-Admin-Token` |
| `web/src/styles.css` | `.room-settings` 抽屉样式（见 §9.4 的 ≤640 规格） |

两条**落点红线**：

1. **入口只能挂在 `.bot-header-actions`，`.roster-trigger`（「N 名成员」）保持只读**。把只读的成员数按钮改成编辑入口，会让「看一眼成员」变成「有权限改成员」——风险等级差一个量级，禁止。
2. **文件名就是 `room-admin.ts` + `RoomSettingsDrawer.tsx`**（不是 `room-settings.ts` / `RoomSettingsDialog`）：前者管令牌存取 + 权限相关纯函数，不止 settings；后者是贴底 drawer 而非 modal dialog。

`postJson` 目前只支持 POST 且无自定义头（`headers: { "Content-Type": "application/json" }`）。**扩成** `requestJson(path, { method, body, headers })`，并在 `postJson` 上保持旧签名兼容（`postJson` 内部转调），避免触碰既有 20+ 调用点。

### 9.2 交互

- 成员 = 勾选列表（`state.bots` 中 roster 来源，与 `NewRoomDialog` 的勾选 UI 同款），提交时**整体替换**成数组。
- coordinator = 下拉（`null` + 当前成员的并集）；成员变更导致 coordinator 不在名单内时，UI 就地把它置为「无」并提示（后端也会清空，两边一致）。
- 删除 = 危险区：手输房间名（**逐字相等**才启用确认按钮，`aria-disabled` 而非仅视觉置灰）+ 按钮文案**固定为「移入回收目录（重启不会重建）」**。
  **文案红线：任何位置（按钮、确认句、toast、空态）都不得出现「不可恢复」「永久删除」「无法找回」** —— D-7 是 `rename` 进 `.trash` 归档，写错会误导用户不敢用、也会让 AC-13b 的「放回可恢复」自相矛盾。

### 9.3 busy / stopped 必须可见（D-4）

- `room.run.phase === "running"` ⇒ 成员区与 coordinator 区**禁用**，上方一行可见原因「本轮结束后可改」；删除区**仍可用**，但提示「将中断当前这一轮」。
- 服务端仍可能返回 409（客户端判断有延迟）：把 `409` 的 `error` 原文展示在抽屉内错误条，**不得**显示成「团队已停止」。

### 9.4 无障碍与移动端

- 抽屉 `role="dialog" aria-modal="true"` + 打开时焦点进第一项、`Escape` 关闭、关闭后焦点回入口按钮（与 `FilePreview` 既有范式一致）。
- **≤640 = 贴底全宽 sheet**（不是全屏覆盖层），精确规格：
  - `.modal`：`width:100%`、`border-radius: var(--radius-lg) var(--radius-lg) 0 0`、`max-height: calc(100dvh - 24px)`；
  - 滚动在 `.modal-body` 内（`.room-settings .modal-body { overflow-y: auto }`）；
  - **`.modal-actions` 必须留在 `.modal-body` 之外**，常驻可见 —— 手机键盘弹起时「保存」仍可达；
  - 成员列表每行 `min-height:44px`（触控目标），列表自身 `max-height:220px` 内滚。
- 令牌输入框 `type="password"`、`autocomplete="off"`、`inputmode="text"`（手机键盘不弹数字盘）。
- 不监听 `resize`、不做 JS 判宽（沿用移动端设计原则：纯 CSS 断点）。

---

## 10. AC 映射

| AC | 覆盖点 | 取证方式 |
|---|---|---|
| AC-1 改成员成功 | §5.1 | **curl**：PATCH + 读 ledger `members` |
| AC-2 运行中拒绝 | §5.1 步骤 2 | **curl**：409 + 前后 ledger sha 相同 |
| AC-3 非法输入 | §5.1 步骤 3 | 单测（`test/rob/room.test.ts` 扩 `updateSettings` 用例） |
| AC-4 coordinator 三态 | §5.1 步骤 4 | 单测 + curl |
| AC-5 删除成功（空闲） | §6.1、§6.2.1 | **curl + 文件核对**：`.trash/<name>.<ts>.json` 的 **sha256** 与删除前 `rooms/<name>.json` **逐字节相等**；源文件不存在；config `rooms[]` 已摘。快照须取**静默点** |
| AC-6 重启不复活 | §6.1 | **人工**：重启 serve 后看 `hello` 首帧；含反向对照（只删 ledger ⇒ 必须复活）与恢复对照（`mv` 回来 ⇒ transcript 完整回来） |
| AC-7 运行中删除 | §6.1 c1 | **人工/curl**：先见 `run_ended`（`interrupted`），再无该房间 `turn` |
| AC-8 部分失败可重试 | §6.5 | **人工**（chmod 只读）+ curl 重试；断言归档只有 1 份 |
| AC-9 删除不越界 | §6.1 d/e | **人工**：`bots/` 点名比对、deliverable 文件仍在 |
| AC-10 跨端同步 | §7.4 | **人工**：两个浏览器窗口，一个删、另一个不刷新即消失 |
| AC-11a/b/c 令牌 | §8.1、§8.2 | **curl**（`-H` / 不带 / 错值）+ 前后 sha |
| AC-11d 常量时间 | §8.2 | **review 只读 diff**（不进自动化） |
| AC-11e 审计日志 | §8.4 | **人工**：`stderr` 新增 3 行 |
| AC-11f 手输确认 | §9.2 | **自动**：纯函数 `canDeleteRoom` 单测（`disabled` 判据） |
| AC-11g 运行中禁用 | §9.3 | **人工/浏览器**（ui 复验 390px） |
| AC-12 回归 | — | `test/rob/room.test.ts`、`room-text`、`team-rooms`、`test/web/**` 全绿 |
| AC-13a 同进程同名重建被拒 | §6.4.1 | **单测**：`test/rob/team-rooms.test.ts` ⇒ `{status:"rejected", reason:"duplicate"}` + 同名 ledger 未生成 |
| AC-13b 重启后同名可复用 | §6.4.1 约束 2 | **人工（进程级）**：stop+重启 ⇒ `POST` 成功 ⇒ 发一条消息 ⇒ 再重启 ⇒ 房间与消息仍在 |
| AC-13c 不破 AC-12 | §6.4.1 第 3 条 | **对照**：既有真重复 POST 仍 400；`room-text.ts` 零改动 |

**只能人工/curl 取证（不进单测）**：AC-5 的 sha/静默点核对、AC-6 的两次重启对照、**AC-7 的字段级判据 + 事件顺序**、AC-8 的写失败构造、AC-9、AC-10、AC-11e、AC-11g、**AC-13b（进程级，单测里没有「新进程」）**。
**可自动化（纯逻辑，无 jsdom）**：AC-3/AC-4（`updateSettings` 纯分支）、AC-11f（`canDeleteRoom`）、**AC-13a**（`createRoom` 为同步纯分支）、§7.4 的 reducer（`applyRoomEvent` 是纯函数）、`already_archived`/`missing_source` 的判定（用临时目录的真实 fs，`RoomStore` 可直接测）。

---

## 11. 任务拆分：两笔可独立落地的提交

### 提交 A ——「改成员 + 改 coordinator」（不含删除）

| 文件 | 动作 |
|---|---|
| `src/rob/room.ts` | `updateSettings` + `setCoordinator` + `setMembers` 改薄委托 + `stopped` 守卫 + `RoomMembershipReason` 扩 2 项 + 域 `members` 事件加 `coordinator` |
| `src/rob/team.ts` | `updateRoomSettings` + `createRoom` 的 `members` 事件补 `coordinator` |
| `src/serve/hub.ts` | `updateRoom?` |
| `src/serve/team.ts` | `TeamHub.updateRoom` + `toRoomEventInfo` 的 `members` 补字段 |
| `src/serve/composite.ts` | `updateRoom` 转发 |
| `src/serve/server.ts` | `PATCH /api/rooms/:name` + 引入 `requireAdminToken` |
| `src/serve/admin-token.ts` | **新增**（A、B 共用，必须落在 A 笔） |
| `shared/protocol.ts` | wire `members` 加 `coordinator`（+ `UpdateRoomBody`） |
| `web/src/state.ts` | `members` 写 `coordinator` + `applyRoomEvent` 加 `default` |
| `web/src/useHub.ts` | `requestJson` 扩展 + `updateRoomSettings` |
| `web/src/room-admin.ts` | **新增**纯函数（成员勾选/提交判据/令牌存取） |
| `web/src/components/RoomSettingsDrawer.tsx` | 新增（成员 + coordinator + 令牌，删除区先留空/隐藏） |
| `web/src/components/RoomView.tsx`、`styles.css` | 入口按钮 + 抽屉样式 |
| `test/rob/room.test.ts`、`test/serve/team.test.ts`、`test/web/state.test.ts`、`test/rob/team-rooms.test.ts`、`test/tui/team/state.test.ts` | 补 `coordinator` 字段 + 新用例 |

**A 笔独立验收**：`pnpm typecheck && pnpm lint && pnpm test`（干净 HOME）+ `curl -X PATCH` 三态（200/409/403）。

### 提交 B ——「删除房间」（依赖 A 的 `admin-token.ts` 与 `Hub` 扩展）

| 文件 | 动作 |
|---|---|
| `src/rob/room-store.ts` | `deleting` tombstone + `save` 早退 + `archive`（§5.4）+ **`isDeleted`** |
| `src/rob/team.ts` | `removeRoom` 单飞 + `removeRoomNow`（§6.1/§6.3）+ **`createRoom` 的 `isDeleted` 守卫**（§6.4.1） |
| `src/config/project-file.ts` | `removeRoom` + `writeRoomRemoval`（§5.5） |
| `src/serve/hub.ts`、`team.ts`、`composite.ts` | `removeRoom?` + `room_removed` 广播 |
| `src/serve/server.ts` | `DELETE /api/rooms/:name` |
| `shared/protocol.ts` | wire `room_removed` |
| `web/src/state.ts` | `case "room_removed"` |
| `web/src/useHub.ts`、`room-admin.ts`、`RoomSettingsDrawer.tsx` | `deleteRoom` + 危险区（手输房间名、文案「移入回收目录」） |
| `test/rob/room-store.test.ts`（新增或就近）、`test/web/state.test.ts`、`test/rob/team-rooms.test.ts` | `archive` 四态 + `isDeleted` + **删除后同名 `createRoom` ⇒ `duplicate`** + reducer 用例 |

**B 笔独立验收**：删一个**非种子**房间后重启不复活；`.trash` 有 1 份；`bots/` 不变。

**为什么能独立**：A 只加「改」；B 才有 `archive`/`removeRoom`/`room_removed`。A 落地后即使 B 未做，功能也是自洽的（PRD 的删除需求未满足，但无半成品状态）。

**依赖顺序硬约束**：`admin-token.ts` 必须在 A 笔（否则 A 的 PATCH 无令牌守卫 = 破坏性路由裸奔）。

---

## 12. 拍板状态

### 已裁决（manager 2026-10-18，已并入正文）

| # | 议题 | 裁决 | 落点 |
|---|---|---|---|
| 1 | 令牌是否首启动自动生成 | **不生成**。由 ops 在本机跑一次生成命令、只在该机器终端显示，用户手输进手机抽屉。**令牌绝不打印进房间**（房间消息会落 ledger） | §8.1、§8.3 |
| 2 | `.trash` retention 写在哪 | 写进 **`docs/rnd-team.md`**（只写文档、不写代码）：`ls -lt` 查看、`mv` 回 `rooms/` 根恢复、**禁止批量 `rm -rf`** | §3.2 |
| 3 | AC-5 判据 | **改为「保留 PRD 原文的逐字节相同（sha 相等）」**，无需 pm 改 PRD（manager 2026-10-18 复核更正：空闲删除不调 `finish()` ⇒ 零 persist）。字段级判据降级为 **AC-7（运行中删除）专用** | §6.2.1、§6.2.2 |
| 4 | tombstone 拒绝时的 POST 状态码 | **400**。既有 `POST /api/rooms` 把所有 `rejected` 映射 400，改 409 会让同一路由对两种 rejected 返回不同码并破 AC-12 | §6.4.1 |

**本节无未决项**：以上 4 条均已裁决并写入正文；后续任何新发现一律走「增量修订说明」，不再改动本文件。

---

## 13. 红线与禁改清单

- **禁** 改 `src/tui/**`（§7.1 的整个理由）。`test/tui/**` 允许（不是 `src/tui`）。
- **禁** 引入 jsdom / @testing-library；web 侧只测纯函数。
- **禁** 在路由层复制 `validateRoomMembers` / `validateRoomCoordinator`（唯一来源 `src/rob/room.ts`）。
- **禁** 两份令牌比较（只 `admin-token.ts` 一处 + 一个 `requireAdminToken`）。
- **禁** `unlink` ledger、禁自动 GC `.trash`、禁把 `.trash` 放 `/tmp`。
- **禁** `room_removed` 携带任何绝对路径。
- **禁** 改 `room-text.ts`（本设计所需文案 case 全部已存在）。
- **禁** 提交 `my-agent.json` / `my-agent.json.bak-*` / `screenshots/**`（噪声）。
- **禁** 给 `members` 事件的 `coordinator` 加 `?`。
- **禁** 从 store 的 `deleting` 里「revive」已删名字（§6.4.1 约束 2）；名字的复用以**重启**为界。
- **禁** 为 `isDeleted` 拒绝新增 `RoomCreateReason` 成员（复用 `"duplicate"`，否则 `room-text.ts` 穷尽 switch 炸，而该文件禁改）。
