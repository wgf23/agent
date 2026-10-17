# PRD：房间管理（改成员 / 改 coordinator / 删除房间）

状态：**confirmed — manager 2026-10-18 批准，范围冻结**（pm 产出；不写代码、不派执行动作）
上游输入：用户 2026-10-18 需求「room 现在没有管理的地方，无法设置内容、删除 room」
适用范围：**web 一期的房间设置抽屉**。TUI 二期。

> **行号约定**：本文件引用一律**符号为准、行号兜底**。行号取自 2026-10-18 工作树（A 笔已应用），A/B 两笔提交后仍可能位移；**以符号名核对，行号仅作导航**。

## 0. 背景与问题

现状（已核代码，非推测）：

| 能力 | 现状 |
|---|---|
| 建房间 | `POST /api/rooms`（`server.ts` 的 `app.post("/api/rooms")`，`src/serve/server.ts:1164`）+ web 新建对话框（`web/src/useHub.ts:406`） |
| 发消息 / 中断 | `POST /api/rooms/send`（`:1156`）、`POST /api/rooms/interrupt`（`:1176`） |
| 改成员 | **web 无入口**；仅 TUI `/room <name> <members...>` → `team.setRoomMembers`（`src/rob/team.ts:623`）→ `Room.setMembers`（`src/rob/room.ts:687`） |
| 改 coordinator | **全仓无 setter**。`Room` 只在构造时读（`room.ts:499`）；`setMembers` 仅在该 coordinator 被移出成员时清空为 `null`（`room.ts:657-662`） |
| 删除房间 | **完全没有**。服务端无 `DELETE`，`RoomStore`（`src/rob/room-store.ts`）只有 `read`/`readAll`/`save`/`flush`，**无 delete/unlink** |

⇒ 用户必须「改 config → 停 serve → 跑脚本 → 重启」才能改成员，且**无法在 UI 里删除房间**。

## 1. 目标与非目标

### 目标（一期）
1. 网页里能**改成员**（整体替换语义，与后端 `setMembers` 一致）。
2. 网页里能**改 coordinator**。
3. 网页里能**删除房间**，且删除后**重启不复活**。
4. 三个动作在其它标签页/手机上**立即同步**（不依赖刷新）。

### 非目标
- 不删 bot store。bot 是全局资产，可跨房间复用；删房间连带删 bot 是 2026-10-18 那次「6 个 bot 不可恢复」事故的重演，**禁止**。
- 不删 workspace 里的 deliverable 文件（`docs/deliverables/…` 不在 ledger 内）。
- 不做房间重命名、不做成员「增量 add/remove」（沿用整体替换）。
- 不做多用户/账号体系。

## 2. 决策记录（含一处 pm 自查更正）

- **D-1 删除 = 摘 ledger **+** 摘 config 条目**（硬约束，非选项）。
  - 机制证据（双向）：`Team.openRooms()` 的房间集合是 `config.rooms ∪ 盘上 ledger ∪ failed`（`team.ts:335-339`）；`record !== undefined` 时直接用 ledger 建房间、**不看 config**（`:340-352`）；只有**无 ledger** 时才 `seedState(name, config)` 播种并写新 ledger（`:368`）。
  - ⇒ **只删 config**：ledger 还在 ⇒ 房间照开（仅多一条 drift notice）。
  - ⇒ **只删 ledger**：config 还在 ⇒ 下次启动**原地复活**（transcript 清空、成员回种子）= 假删。
- **D-2 实现方式：照 `removeRob` 新增 `removeRoom`，复用 `writeChain`。**
  - **pm 自查更正**：我此前称「`my-agent.json` 全仓只被读、没有写入口」，**错误**。`src/config/project-file.ts` 已有 5 个写函数全部 `writeFile` 到 `my-agent.json`：`addPermissionRule:206`、`addRob:281`、`setRobWake:371`、`updateRob:457`、`removeRob:574`，并由模块级 `writeChain:202` 串行化（`:212/:285/:376/:462/:580`）。
  - `removeRob` 的范式正是「只摘指定条目、其余键逐字节不动」：`{ ...raw, robs: nextRobs }` + `JSON.stringify(…, null, 2) + "\n"`，注释原文 *"leaves every other key and every other rob byte-for-byte intact"*。⇒ `removeRoom` 同构（摘 `rooms[]` 中同名一项），**不新发明机制**。
  - **不采用**「应用自有 deleted 标记」（tombstone）：多一套状态源就多一条漂移路径，而 `openRooms()` 的 seed 逻辑是唯一真相源。
  - **pm 自查更正（已由 manager 复核，保留）**：`setRoomMembers` 的**定义**在 `src/rob/team.ts:623`（提交时 `616`）；`:631`（提交时 `:624`）是该函数体内的 `return target.setMembers(members)` 调用行。pm 初稿引用 `:624` 系行号错位，已改，本更正条目按 manager 要求保留存证。
- **D-3 run 中删除 = 先 `interrupt()` 再删**，不接受强删（强删会让正在跑的 turn 悬空）。
- **D-4 改成员沿用既有 `busy` 契约**：`Room.updateSettings` 在 `live !== null` 时返回 `{status:"rejected", reason:"busy"}`（`room.ts:630`），UI 在运行中**禁用入口并显示原因**，不得静默失败。
- **D-5 协议只做加性扩展**（`shared/protocol.ts` 现有 `RoomEventInfo` = `entry|run|run_ended|turn|members`，`:434-456`；`members` 分支此前 **不带 coordinator**）。加性 = 老客户端忽略未知字段仍可工作。
- **D-6 破坏性路由必须带管理令牌（`X-Admin-Token`），未配置即 403（fail-closed）** —— manager 2026-10-18 裁决 D。
  - 适用范围：`DELETE /api/rooms/:name`、`PATCH /api/rooms/:name`（改成员、改 coordinator）**全部算破坏性路由**。
  - 比较方式：`node:crypto` 的 `timingSafeEqual`，**两侧长度不等直接判否**（先比长度再比内容，避免 `timingSafeEqual` 抛错，也不泄露长度）。
  - **未配置令牌 ⇒ 一律 403，不做「本机放行」例外**。理由：例外只能靠 bind host 或 `request.ip` 判断，而实测 bind 是 `--host 0.0.0.0`（`isLoopbackHost("0.0.0.0") === false`，`server.ts:1494` 定义、调用点 `:1303/:1390/:1436`），且用户的手机是 `192.168.x.x` ⇒ 任何 IP 判据都会把用户自己挡在门外（把功能变成死的），或者等于没判。
  - 手输房间名**保留，但只作误操作防护，不冒充鉴权**（见 FR-4.1）。
  - 审计：每次尝试（成功与 403、以及 4xx/5xx）落一行 `ts / ip / action / room / result`。
  - 先例：写 provider 凭证的设置路由（`src/serve/server.ts:1302-1306`）就是 fail-closed（非 loopback 直接 403）——沿用同一精神，不引入新范式。
- **D-7 删除不直接 unlink，先 `rename` 进 `.trash/`** —— manager 2026-10-18 裁决。
  - 实现：`rename(ledger, <rooms>/.trash/<name>.<ts>.json)`，同一文件系统、**原子、零拷贝**；再摘 registry、再摘 config。
  - **不写自动 GC**：保留目录成本近乎为零，自动清理会把「可恢复」重新变成「不可逆」。

## 3. 功能需求

### FR-1 改成员
- FR-1.1 新增 `PATCH /api/rooms/:name`，body `{ members: string[] }`（**整体替换**，与 `setMembers` 语义一致）。
- FR-1.2 服务端调用链**必须**复用 `team.updateRoomSettings`/`team.setRoomMembers` → `Room.updateSettings`/`Room.setMembers`，**不得**在路由层自行校验成员合法性（校验只有一处：`validateRoomMembers`，`src/rob/room.ts:347`）。
- FR-1.3 运行中（`live !== null`）返回 **409** 且响应体带可读原因（`busy`）；**不得**返回 200 后静默不生效。
- FR-1.4 成功时 `members` 事件广播（既有事件，`Room.updateSettings` 内 `emit({kind:"members"…})`，`src/rob/room.ts:675-680`，现含 `coordinator`），并持久化（紧随其后的 `this.persist()`，`:681`）。

### FR-2 改 coordinator
- FR-2.1 新增 `Room.setCoordinator(name: string | null)`，**写在 `room.ts` 内紧邻 `setMembers`**，复用 `validateRoomCoordinator`（`src/rob/room.ts:378`；全仓 3 个调用点、0 个定义在 config 侧）。**不新增 import**。
- FR-2.2 校验规则：`name === null` 允许（清空）；非 null 必须**在成员内**，否则 `rejected`（复用既有规则，不另写一套）。
- FR-2.3 持久化 + 事件：`coordinator` 必须有变更事件，否则其它标签页/手机不会更新（见 FR-5.1）。
- FR-2.4 `PATCH /api/rooms/:name` 同时接受 `{ coordinator: string | null }`；两个字段都可选，但**至少一个**存在，否则 400。

### FR-3 删除房间
- FR-3.1 新增 `DELETE /api/rooms/:name`。
- FR-3.2 **时序硬约束**（可核对，顺序不得变）：
  1. 若该房间有 `live` run ⇒ `room.interrupt()`（记录 outcome=`interrupted`）；
  2. `await room.stop()` —— **它已经保证 `ledger.flush()`**（`room.ts:711-724`：`stop()` 置 `stopped`、必要时 `finish(...)`，`completeStop()` 先 await 运行循环、再 `await this.ledger.flush()`、再 resolve）。**不要再额外加一次 flush 调用**（重复无害但会掩盖真实依赖）；
  3. `roomRegistry.delete(name)`（**必须先摘实例再动文件**：否则实例下一次 `persist()` 会把文件写回来）；
  4. `rename(ledgerPath, <rooms>/.trash/<name>.<ts>.json)`（**不是 unlink**；`rename` 同文件系统原子，等价于「瞬间移走」，不存在半删状态）；
  5. `removeRoom(workspaceRoot, name)` 摘 config 条目。
  - **注意顺序陷阱**：`.trash/` 必须在 rooms 根目录内（`<rooms>/.trash/`），**不能放 `/tmp`**——跨文件系统 `rename` 会退化成 copy+unlink，既非原子又会在大 transcript 上产生可观察的窗口。
- FR-3.3 **部分失败规则**（每一半都要有确定语义，不许留半死状态）：
  - 步骤 3 之后、4 之前失败 ⇒ 房间在本进程已消失、盘上 ledger 仍在 ⇒ 重启后房间回来（**数据没丢**，可重试删除）。响应必须报错，UI 显示「删除未完成，请重试」。
  - 步骤 4 成功后、5 失败 ⇒ 本进程已无此房间，但 config 种子在 ⇒ 重启**会以空 transcript 重建**。响应必须报错并明示「重启后会重建」；提供重试（再调一次 DELETE，幂等：ledger 已不在 `rooms/` 且 `.trash/` 内已有该名的归档，则跳过 4）。
  - 步骤 1-3 任一失败 ⇒ 房间**保持可用**，不做任何盘上改动。
  - **可恢复性（D-7）**：任何一步失败后，`.trash/<name>.<ts>.json` 若已生成，即为该房间 transcript 的完整副本；PRD 要求该文件**只增不减**，人工可用 `mv` 放回 `rooms/` 后重启恢复。
- FR-3.4 删除**只**作用于：ledger 文件（移入 `.trash/`）+ config `rooms[]` 中同名一项。**不删** bot store、不删 deliverable 文件、不改其它房间、**不删 `.trash/` 里的任何历史归档**。
- FR-3.5 幂等：对**从未存在**的房间返回 404；对「ledger 已不在 `rooms/`、config `rooms[]` 已无同名项、`.trash/` 内已有该名归档」的重复请求返回 404（UI 视为已完成）。**注意**：重复请求**不得**再产生第二条 `.trash` 归档（避免重试把回收目录刷满）。

### FR-4 二次确认（UI）
- FR-4.1 删除必须**手输房间名**确认（输入框与目标名逐字相等才启用按钮），按钮文案含「移入回收目录，重启不会重建」。
  - **定位说明（D-6）**：手输房间名是**误操作防护（防手滑点错）**，**不是鉴权**。真正的边界是 `X-Admin-Token`；两者都要有，缺一不可。
  - 文案不得写「不可恢复」——删除是移入 `.trash/`（D-7），说「不可恢复」是错的事实。
- FR-4.2 改成员/改 coordinator 一次确认即可（对比无破坏性）。
- FR-4.3 运行中：删除入口**允许**（D-3 先 interrupt 再删），但必须提示「将中断当前这一轮」；改成员/coordinator **禁用**并显示「本轮结束后可改」（D-4）。

### FR-5 事件（加性）
- FR-5.1 `members` 事件**加性扩** `coordinator: string | null`（`shared/protocol.ts` 的 `RoomEventInfo` 中 `members` 分支，A 笔前只有 `room`/`members`）。三处必须同改，否则手机端读到 `undefined`：① `shared/protocol.ts` 的类型 ② 服务端广播点（`room.ts` 的 `emit` 调用与 `src/serve` 的转发）③ `web/src/state.ts` 的 `updateRoom`。
- FR-5.2 新增 `room_removed` 事件 `{ kind: "room_removed"; room: string }`。理由：web 侧「新建房间」是靠事件就地建（`web/src/state.ts` `updateRoom` 注释说明），**没有删除事件则手机端直到刷新都还显示该房间**。
- FR-5.3 两者都是**加性**：不删既有字段、不改既有事件的形状；老客户端忽略未知字段。

## 4. 非功能约束

- NF-1 **不引入 jsdom/@testing-library**（沿用仓库既有约束）；web 侧逻辑若可纯函数化（如「成员全选状态 ↔ `setMembers` 入参」），放进 `web/src/*.ts` 纯模块再做 node 测试。
- NF-2 越界红线：`src/tui/**`、`screenshots/**` 本次不动。
- NF-3 所有写盘路径必须走既有串行化：config 走 `writeChain`，ledger 走 `RoomStore.save`。
- NF-4 错误必须可读且区分「不允许」（4xx）与「内部失败」（5xx），不得把 409 busy 写成 500。

## 5. 验收标准（可机械核对）

取证只用：HTTP 状态码与响应体、ledger 字段、`hello` 首帧、`ps stat`、文件点名。**禁止**用「产物里搜源码标识符」「看起来数量对」这类启发式。

### AC-1 改成员（空闲，成功）
- PATCH `{members: [...]}` ⇒ **200**；响应含新成员列表。
- ledger `members` 与请求**逐名相等**；`coordinator` 落在成员内则不变，被移出则变 `null`。

### AC-2 改成员（运行中，拒绝）
- 运行中 PATCH ⇒ **409**，响应体可读（含 `busy` 或等价中文）。
- **零写入**：ledger `members` 与 `transcript` 长度与请求前**完全相同**（对比前后两次读取）。

### AC-3 改成员（非法输入）
- 成员不存在于 roster / 人数越界 / 重名 ⇒ **4xx**，ledger 不变。（**档位见 AC-14e**：空闲房间上为 400；若该房间正在运行，`updateSettings` 的 `busy` 守卫在成员校验**之前**（`room.ts:629-630`）⇒ 实际返 **409**，此非缺陷。）
- 校验只有一处：`validateRoomMembers`（不得在路由层复制规则——`src/rob/room.ts:347` 是唯一来源）。

### AC-4 改 coordinator（成功 / 清空 / 非法）
- 设为成员内某人 ⇒ 200，ledger `coordinator` = 该名；
- 设为 `null` ⇒ 200，ledger `coordinator` = `null`；
- 设为非成员 ⇒ 4xx，ledger 不变。（**档位见 AC-14e**；运行中同理先返 409，见 AC-3 括注。）

### AC-5 删除（空闲，成功）
- DELETE（带合法 `X-Admin-Token`）⇒ **200**。
- `rooms/<name>.json` **不存在**；**且** `rooms/.trash/<name>.<ts>.json` **存在**，其内容与删除前的 ledger **逐字节相同**（sha 相等）——这条同时证明「移走了」而不是「删掉了」。（**快照取在静默点**：该房间无进行中 run、且 `rooms/<name>.json` 的 sha 连续两次读取相同；否则 `archive()` 的 `flush()` 会把在飞写入落盘，不属于删除路径多写）
- config `rooms[]` 中**无**同名项；其它房间与其它键**逐字节不变**（前后比对 `my-agent.json` 的其它键）。
- `hello` 首帧 `rooms[]` 中**无**该房间。
- `.trash/` 中删除前已存在的历史归档**一份都没少**（点名比对文件名集合）。

### AC-6 删除后「重启不复活」（本 PRD 的核心判据）
- 删除后重启 serve ⇒ `hello` 首帧 `rooms[]` 中**仍无**该房间。
- 反向对照（用于证明判据有效）：若**只删 ledger、不删 config**，重启后房间**必须**复现——这条作为实现自检，若不复现说明判据写错了。
- **可恢复对照（D-7）**：把 `.trash/<name>.<ts>.json` `mv` 回 `rooms/<name>.json`（config 未回填）⇒ 重启后房间**必须**以完整 transcript 回来。这条证明 `.trash/` 是真的可用，不只是留了个文件。

### AC-7 删除（运行中）
- 运行中 DELETE ⇒ 先产生 `run_ended`（outcome=`interrupted`），再完成删除；
- 删除后 `hello` 中无该房间；**无**悬空 turn 事件（删除完成后不应再收到该房间的 `turn`）。

### AC-8 删除（部分失败可重试）
- 构造 config 写失败（只读 chmod 或 mock）⇒ 响应 5xx，且消息明示「重启后会重建」；
- **不受损**：ledger 已移入 `.trash/`、config 仍在；再次 DELETE（带令牌）⇒ 不再报 500（走 FR-3.5 幂等分支）。
- **归档不重复**：两次 DELETE 后 `.trash/` 中该房间的归档**只有 1 份**（证明重试没有把回收目录刷满）。

### AC-9 删除不越界
- 删除后 `bots/` 目录内容**逐名不变**（点名比对，不数个数）；
- 该房间的 deliverable 文件仍在（`docs/deliverables/…`）。

### AC-10 跨端同步
- 删除后**不刷新**另一个客户端，其房间列表在**一个事件周期内**消失（收到 `room_removed`）。
- 改 coordinator 后另一个客户端**不刷新**即显示新 coordinator（`members` 事件带 coordinator）。
- 老形状兼容：未改的客户端收到带新字段的事件不报错（类型加性；用「缺字段不 crash」的单测钉住）。

### AC-11 鉴权与误操作防护（两道，缺一不可）
- **AC-11a 未配置令牌 ⇒ 全部破坏性路由 403**：不设 `X-Admin-Token` 的部署里，`DELETE` 与 `PATCH` 一律返回 **403**，即使请求来自本机、即使 body 完全合法、即使手输房间名正确。**零写入断言**：ledger 与 `my-agent.json` 的 sha 在请求前后完全相同。
- **AC-11b 令牌错误 ⇒ 403，且不泄露线索**：错误令牌与缺失令牌返回**同样的状态码与同一句错误文案**（不区分「没带」和「带错了」）；响应体不含令牌的任何片段。
- **AC-11c 令牌正确 ⇒ 放行**：同一请求改为携带正确令牌 ⇒ 200，且无 403 日志残留造成的副作用。
- **AC-11d 常量时间比较**：实现必须用 `timingSafeEqual`，长度不等直接判否；代码评审确认**没有** `===` 直接比较令牌（这条由 review 检查 diff，不进自动化）。
- **AC-11e 审计日志**：每次尝试都落一行 `ts / ip / action / room / result`，**成功与 403 都要有**。断言：连发 3 次（1 正确 + 2 错误）⇒ 日志新增 **3** 行，且其中 2 行的 `result` 是拒绝。
- **AC-11f 误操作防护（UX，不冒充鉴权）**：输入框内容与房间名不逐字相等时删除按钮**禁用**（`disabled` 属性可断言）；令牌正确但名字输错 ⇒ 请求**根本发不出去**。
- **AC-11g 运行中**：改成员/coordinator 入口为禁用态且**有可见原因文案**（不是静默）。

### AC-12 回归
- `test/rob/room.test.ts`、`test/rob/room-text.test.ts`、`test/rob/team-rooms.test.ts`、`test/web/**` 全绿；
- 既有 `POST /api/rooms`、`/send`、`/interrupt` 行为不变（回归用例）。**例外且互通**：AC-13a 新增的「同名重建被拒」分支走的是既有 `createRoom` rejected ⇒ 400 路径，**不视为破坏 AC-12**；反之 AC-12 的回归用例不得把该拒绝当作新行为去放宽。

### AC-13 同进程同名重建（tombstone 冲突，manager 2026-10-18 追加裁定）
来源：设计 §6.4.1（`docs/design/room-management.md`）。删除后 store 的 tombstone 与进程同寿且**永不**移除；若此时允许同名重建，实例的每次 `persist()` 都会被 `save()` 静默丢弃 ⇒「能聊天、重启后凭空消失」的静默数据丢失（比假删更糟）。
- **AC-13a 删除后同进程重建 ⇒ 拒绝**：DELETE 成功后，在本进程内 `POST /api/rooms {name:"<原名>"}` ⇒ **400**（**不得**为 409：409 是被否决的方案，判据必须钉死），`reason` 必须复用既有 `"duplicate"`（**不得**新增枚举成员——`renderRoomOutcome` 是穷尽 switch 且在禁改清单内）；`hello` 中不出现该房间；ledger 目录中**不产生**同名文件。
- **AC-13b 重启后同名可复用**：`stop` + 重启 serve（tombstone 清空、ledger 不在、config 已摘）⇒ 同名 `POST /api/rooms` ⇒ **成功**，且该房间的正常持久化可见：新建后发一条消息、再重启一次，房间与消息**仍在**（证明不是「建了但写盘被丢」）。
- **AC-13c 不破 AC-12**：重建被拒时必须走既有 `createRoom` 的 rejected 分支，不改 `renderRoomOutcome`、不改既有房间的创建/发送/中断行为。

### AC-14 PATCH 的 HTTP 契约（五档拒绝 + 正向；manager 2026-10-18 追加裁定）
来源：A 笔已实现（`src/serve/server.ts` 的 `app.patch("/api/rooms/:name")`，状态映射 `:1224-1237`），但 PRD 原只对 DELETE 写了 404，PATCH 侧此前**无任何 HTTP 契约** ⇒ 删完房间后 PATCH 若误返 200/500，AC-1..AC-13 全绿也审不出来。本条纯加性，不改任何既有 AC。

- **AC-14a 正向**：对**存在且空闲**的房间发合法 PATCH ⇒ **200**，响应体 `{ok:true, room:{…}}`。（缺这档，「三档全拒」的空实现也能伪绿。）
- **AC-14b 未知房间 ⇒ 404**：PATCH 一个**不存在**的房间名（含「已被删除、且已从 registry 摘除」的名字）⇒ **404**，响应体带可读错误（`Unknown room "<name>".` 的等价文案，复用 `renderRoomOutcome`，界面不得自造）。
- **AC-14c 忙碌 ⇒ 409**：运行中（`live !== null`）PATCH ⇒ **409**，文案含 `busy`；**零写入**（ledger `members`/`coordinator`/`transcript` 长度与请求前相同）。
- **AC-14d 已停止 ⇒ 409（域层契约，非端到端可达）**：对**已 `stop()` 但仍在 registry 中的实例** PATCH ⇒ **409**，文案含 `stopped`。`Room.updateSettings` 先判 `stopped` 再判 `busy`（`src/rob/room.ts:629-630`），但删除路径的第 3 步就把实例摘出 registry ⇒ 端到端只会走 `unknown_room` ⇒ 404，**本条构造不出真实请求**，因此**载体是域层单测**：直接 `Room.stop()` 后调 `setMembers`/`setCoordinator` ⇒ `{status:"rejected", reason:"stopped"}`。**qa 不得为此去伪造 e2e 场景，也不得因「e2e 拿不到 409」报缺陷。**
- **AC-14e 其余拒绝 ⇒ 400**：`member_count` / `unknown_member` / `duplicate_member` / `reserved_member` / `coordinator_not_member`、以及 body 形状非法（无 `members` 也无 `coordinator`、字段类型不对）⇒ **400**，ledger 与 `my-agent.json` 的 sha 前后不变。
- **AC-14f 鉴权优先**：以上各档在**未带/带错** `X-Admin-Token` 时**一律 403**，不泄露房间是否存在（403 先于 404 判定，避免把 404 当房间存在性探测的旁路）。

## 6. 已裁决事项（manager 2026-10-18，原为未决冲突）

### 6-1 鉴权：裁决 D —— `X-Admin-Token` + fail-closed（**已定，不再是选项**）

- **A（按 bind host 限本机）否决**：实测 bind 是 `--host 0.0.0.0`，`isLoopbackHost("0.0.0.0") === false`（`isLoopbackHost` 定义见 `server.ts:1494`）⇒ 功能整体不可用，包括用户自己。产品不能用，判据再严也没意义。
- **C（只靠手输房间名）否决**：手输名字是 UX 确认，**不是安全边界**。局域网零鉴权下任何人打开页面都能删。
- **采纳 D**（细节见 D-6）：`X-Admin-Token` + `timingSafeEqual` + 未配置即 403 + 手输房间名只作误操作防护 + 审计日志。
- **令牌来源**：环境变量 `MY_AGENT_ADMIN_TOKEN`（运行态，不入库）；allow `my-agent.json` 覆盖属实现细节，由 architect 定，但**必须支持 env**，否则 dev 环境无法起。
- **交付物要求**：PRD 只要求「未配置 ⇒ 403」，**不要求提供 UI 设置令牌的入口**（一期用 env）；这一点由 architect 在设计里明确，避免 dev 自行发明设置页。

### 6-2 可恢复性：裁决 D —— 先 `rename` 进 `.trash/`，不直接 unlink（**已定**）

- 位置：`<rooms>/.trash/<name>.<ts>.json`（`<rooms>` = `~/.local/share/my-agent/rooms/<workspace-slug>/`）。
- 同一文件系统 ⇒ 原子 `rename`、零拷贝；**不得放 `/tmp`**（跨设备会退化为 copy+unlink，非原子）。
- **不写自动 GC**；PRD 明确「保留目录只增不减」。要不要人工清理属文档事项，不进代码。
- 理由（写入 PRD 是为了让后来者知道边界）：本轮已真实丢过一次数据（6 个 bot store 无副本、`backup-*` 从未生成）。在一个「删除」功能上再写 `unlink`，等于把同一个错误再犯一遍。

## 7. 交付物与分工（§6 已裁决，可按此启动）

1. **architect** → `docs/design/room-management.md`：API 表（PATCH/DELETE 请求/响应/错误码）、`Room.setCoordinator` 与 `Team.removeRoom` 签名、事件加性 diff（`members` 加字段 + `room_removed`）、删除时序图、AC 映射。
2. **dev** → 实现：`src/rob/room.ts`（setCoordinator）、`src/rob/team.ts`（removeRoom）、`src/rob/room-store.ts`（**archive = rename 进 `.trash/`，不是 unlink**）、`src/config/project-file.ts`（removeRoom，照 `removeRob`）、`src/serve/server.ts`（两条路由 + `X-Admin-Token` 校验 + 审计日志）、`shared/protocol.ts`（加性）、`web/src/**`（设置抽屉 + 令牌输入或 env 说明 + state 事件）。
   - **令牌校验必须是可复用的单一实现**（一个 `requireAdminToken(request)` 之类的守卫），不许在两条路由里各写一份比较逻辑——两份就会有一份漏掉 `timingSafeEqual`。
3. **qa** → 按 AC-1..**AC-14** 出用例；AC-6 必须含反向对照（只删 ledger ⇒ 必须复活；`.trash` 放回 ⇒ 必须恢复）；AC-13a/b 属 B 笔（删除）范围；**AC-14d 只写域层单测**（`Room.stop()` 后 `setMembers` ⇒ `reason==="stopped"`），不得伪造 e2e，也不得因 e2e 拿不到 409 报缺陷。
4. **review** → 只审上述文件范围的 diff，重点：**时序（先摘实例再 rename）**、部分失败语义、是否在路由层复制了校验规则、**令牌比较是否只有一处且用 `timingSafeEqual`（AC-11d）**、`.trash/` 是否落在 rooms 根内（跨设备 rename 会退化）。
5. **ci** → 五步 + 产物 sha。

## 8. 明确不在本 PRD 内

- `scripts/room-members.mjs` 的去留：本 PRD 落地后，改成员走 UI 就不再需要「停 serve 跑脚本」，届时可只在 `docs/rnd-team.md` 留「config 种子变更」用途。**本 PRD 不删该脚本**。
- 房间重命名、房间模板、批量迁移。
