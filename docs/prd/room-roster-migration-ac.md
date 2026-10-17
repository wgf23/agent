# 验收标准：rnd 迁到 8 人 / coordinator=manager / 删除 ppp

状态：**已执行并取证，入库（作为迁移审计痕迹）**。运维动作于 2026-10-18 01:16:05 完成，A-1..A-7 实际取证见 §5（pm 于 01:2x 独立复取，不采信脚本自报）。
适用范围：只覆盖**数据与运行态**的上线核对。代码侧结论另见 `docs/prd/room-max-members.md`（AC-1..AC-12），本文件不重复。

## 0. 前置（不满足就不执行）

- P-1 config 已是目标态：`my-agent.json` 的 `robs` = pm/architect/dev/qa/review/ci/ui/manager（8），`rooms` 只剩 `rnd`，`rnd.members` 8 人、`coordinator = manager`。
- P-2 目标 `rnd.json` 能被 `node scripts/room-members.mjs rnd --dry-run` 算出迁移（打印 `6 人 -> 8 人` 且 `pm -> manager`），且 dry-run 前后 `rnd.json` 的 sha 不变。
- P-3 执行者持有**用户/运维的明确授权**；pm 不派、不执行、不碰数据。

## 1. 验收判据（逐条可机械核对）

取证载体只用两种：**运行时状态**（SSE `hello` 首帧）与**产物/文件的逐字节比对**。禁止用"某源码标识符在产物里搜不到""数量看起来对"这类必要不充分的启发式。

### A-1 房间成员与 coordinator（运行时）
```
timeout 5 curl -sN http://127.0.0.1:4317/api/events | head -1 | sed 's/^data: //' \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); r=[x for x in d["rooms"] if x["name"]=="rnd"][0]; \
                assert sorted(r["members"]) == sorted(["pm","architect","dev","qa","review","ci","ui","manager"]), r["members"]; \
                assert r["coordinator"] == "manager", r["coordinator"]; print("A-1 ok")'
```
逐名断言，**不得只断言 `len(members)==8`**（长度相等而名单错会漏）。

### A-2 ppp 已删除（运行时）
`hello.rooms[]` 中**不存在** `name == "ppp"`。仅断言"rnd 存在"不够。

### A-3 ledger 盘态与运行时一致
- `~/.local/share/my-agent/rooms/-home-heiwa-my-agent/rnd.json`：`members` 逐名 = 8 人集合，`coordinator == "manager"`，`runOpen == false`，`queue == 0`。
- `.../ppp.json` **不存在**。
- 注：`rnd.json` 的 sha 每轮都会变（transcript 增长），**不可当锚**；只能比对字段。

### A-4 进程新鲜度
- `systemctl show -p MainPID --value my-agent` 的值 **≠ 758671**（改造前的 pid）。
- 该 pid 的 `ps -o stat=` **不以 `T` 开头**（被 SIGSTOP 冻结未解冻会显示 `T`）。
- 只有 A-4 成立，A-1~A-3 才证明"读的是新进程"，否则可能是老进程内存态的幻觉。

### A-5 bot store：逐个点名，不数个数
- 这 6 个**必须不存在**：`bots/test.json`、`pi-test.json`、`opencode.json`、`dmtest.json`、`aaa.json`、`leader.json`。
- 这 8 个**必须存在**：`pm`、`architect`、`dev`、`qa`、`review`、`ci`、`ui`、`manager`。
- **禁止**用 `ls bots | wc -l == 8` 作为唯一判据（数量对而名单错会漏）。

### A-6 构建产物
- 若本次**未重建**：`dist/index.js` sha 应仍为 `ccb2773a…`（659,662 B）。
- 若本次**重建**：记录新 sha 与字节数，并复查 `grep -c "ROOM_MAX_MEMBERS = 20" dist/index.js >= 1`；此时 A-6 的判据是"dist 由当前 HEAD 构建"，**不是**旧 sha。
- `maxMembers === 20` 恒真（常量派生），**不构成迁移证据**，只证"线上跑的是 cap-20 代码"。

### A-7 前端产物与服务一致性
```
curl -s http://127.0.0.1:4317/ | grep -o 'assets/index-[^"]*\.js' | head -1   # 取被引用的文件名
sha256sum web/dist/assets/index-TzOeO2eV.js                                 # 与服务端返回内容比对
curl -s http://127.0.0.1:4317/assets/index-TzOeO2eV.js | sha256sum
```
三者 hash 必须一致（HTML 引用 = 盘上文件 = 实际返回）。包内应含 `mention-menu`（当前部署包已满足）。

## 2. 明确不作判据 / 已知不可追溯

- **不作判据**：在 minify 产物里 grep 源码标识符（如 `mentionQuery`）——变量名被压缩，命中 0 不代表缺代码，命中 1 也不代表逻辑对。
- **不作判据**：脚本自报的 `ALL ASSERTIONS PASSED` / 日志里的 `written`。
- **不作判据**：`limits.maxMembers === 20`（见 A-6）。
- **不可追溯（如实记录，不判"通过"也不判"缺陷"）**：AC-7 要求执行前有 9 个备份文件，但三条 ops 日志全部停在 step 0（房间 busy），**备份逻辑从未执行**，`~/.local/share/my-agent/backup-*` 不存在；ppp 那 6 个 bot 的 store 已不在盘上且全盘无副本 ⇒ 其 memory/usage/seq **不可恢复**。台账记："AC-7 未满足、且已无法追溯满足；成因是删除早于任何脚本执行，不是'执行了却漏备份'"。

## 3. 迁移后的回归（不阻塞上线，但要在同一窗口内报数）

- `pnpm test -- test/rob/room.test.ts test/rob/room-text.test.ts test/rob/team-rooms.test.ts`
- 聚焦面期望：room 37 / room-text 17 / team-rooms 12。
- 全量门禁由 ci 在迁移后的 HEAD 上跑五步并报 exit code；本文件的 A-1..A-7 与代码结论分开记。

## 4. 移动端 `@` 无弹窗（独立于迁移，勿混判）

现状事实：`web/dist/assets/index-TzOeO2eV.js`（01:00 构建，sha `5c32a63b…`）已部署，服务返回内容与盘上逐字节一致，包内含 `mention-menu`/`mention-item` ⇒ **不是"未部署"**。

未定的是**为什么用户看不到**。候选假设（按可能性排序，均**未取证**）：
1. **中文输入法组合期抑制**：`onChange` 在 `isComposing === true` 时直接 `setMention(null)`，`onKeyUp` 同样跳过。用中文键盘打 `@` 时若仍处于组合态，浮层按设计**不出现**（这是 AC-6 的硬约束，不是 bug）。→ 取证：在英文键盘/切到 ASCII 输入后打 `@`，若弹层出现即为此因。
2. **键盘遮挡**：`.composer` 为 `position: relative`、`.mention-menu` 以 `bottom: calc(100% + 6px)` 向上展开、`max-height: 240px` + 内部滚动；窄视口下若父容器被压缩，浮层可能落到可视区外。→ 取证：390px 视口截图 + 键盘展开态。
3. **候选为空**：`members` 里没有匹配项或该名字已被 @ 过（候选排除已 @ 的成员）。→ 取证：在非中文输入法下打 `@` 一个字符，看 `mention.candidates` 是否非空。

修法方向（**待取证后定，勿先改**）：若为 1 → 需产品决策（放宽"组合期不弹"或提示用户切输入法）；若为 2 → 仅 `web/src/styles.css` 调整（ui 负责）；若为 3 → 检查 `room.members` 来源（`web/src/state.ts` roster）。

## 5. 实际取证（pm 独立复取，2026-10-18 01:2x；不采信脚本日志自报）

| 判据 | 结果 | 实测值 |
|---|---|---|
| A-1 成员/coordinator | **通过** | `hello.rooms[rnd].members` = `manager, pm, architect, ui, dev, qa, review, ci`（逐名比对 True）；`coordinator = manager` |
| A-2 ppp 已删 | **通过** | `hello.rooms[].name` = `["rnd"]`，不含 `ppp` |
| A-3 ledger 盘态 | **部分通过（runOpen 项受时机影响）** | `members` 逐名 = 8 人（True）、`coordinator = manager`、`queue = 0`；`runOpen = true` —— 取证时本轮对话正在进行（见注） |
| A-4 进程新鲜度 | **通过** | `MainPID = 1046150`（≠ 758671），`ps -o stat=` = `Ssl`（非 `T`），启动 01:15:53 |
| A-5 bot store | **通过** | `bots/` = `architect, ci, dev, manager, pm, qa, review, ui`（8 个）；`test/pi-test/opencode/dmtest/aaa/leader` 逐个点名**均不存在** |
| A-6 构建产物 | **通过（未重建路径）** | `dist/index.js` sha = `ccb2773af7c…a58b7`，659,662 B，mtime 00:59:41 ⇒ 与迁移前一致；`grep -c "ROOM_MAX_MEMBERS = 20"` = 1 |
| A-7 前端产物与服务一致 | **通过** | HTML 引用 `assets/index-TzOeO2eV.js`；盘上 sha = 服务返回 sha = `5c32a63b9c10…6569c6` |
| A-3' rooms 目录 | **通过** | 目录内 = `rnd.json` + `rnd.json.bak`（脚本备份），无 `ppp.json` |

**注（A-3 的 `runOpen == false`）**：该项在取证瞬间必然为 `true`，因为本房间此刻正在跑这一轮。它只应在**房间空闲**时判读；已满足的部分（成员逐名、coordinator、queue=0）不受影响。判据本身不改。

**未满足项（如实记录，不判通过也不判缺陷）**：见 §2「不可追溯」——AC-7 要求的执行前 9 文件备份从未发生，ppp 那 6 个 bot 的 store 在脚本执行前已被用户手动删除，`backup-*` 目录从未生成 ⇒ **memory/usage/seq 不可恢复**。成因是「删除早于任何脚本执行」，不是「执行了却漏备份」。
