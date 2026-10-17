# 增量修订说明 01 —— 令牌解析时机（惰性 + memo）

状态：**增量说明，不修改主设计原文**
适用基线：`e9eae02`（A 笔：改成员 + 改 coordinator，含令牌守卫；主设计 `docs/design/room-management.md` 852 行 / `sha256=4b3ed305…` 随该笔入库）
作用范围：**只取代主设计 §8.1 的标题与首句（「启动时一次」）**；§8.1 的解析顺序、`source` 语义、`fail-closed`、不生成裁决、§8.2 比较逻辑、§8.3/§8.4 **全部不变**。
提交方式：随 **B 笔**（删除房间）一起提交，或单独一笔 `docs(design)`；由 manager 决定。

---

## 1. 偏差登记

| | 主设计 §8.1 原文 | 实现 `src/serve/server.ts:381-397` |
|---|---|---|
| 解析时机 | 「**启动时**解析一次」 | 「**首次 admin 请求时**惰性解析 + memo」 |
| 落点 | `buildApp` 顶部无条件调用 | `adminToken()` 闭包内首次调用才解析 |

实现原文（逐字，`server.ts:381-397`）：

```
// Resolved once, on the first admin request: reading the file at startup
// would make every server build depend on `hello()` and would pick up a
// token the process may not have needed. The result is memoized, so a token
// changed mid-flight is still never picked up by half the requests.
let resolvedAdminToken: AdminTokenContext | null = null;
const adminToken = (): AdminTokenContext => {
    if (resolvedAdminToken === null) { resolvedAdminToken = resolveAdminToken({ … }); }
    return resolvedAdminToken;
};
```

### 1.1 准确语义

- **进程内只解析一次** 这一条**仍然成立**。差别只在「一次」发生在**启动**还是**首个破坏性请求**。
- **memo 判别为什么有效**：`resolveAdminToken()` 的返回类型是 `AdminTokenContext`（**恒为对象**），未配置时是 `{ token: null, source: "none" }` —— 也就是说 **`token: null` 是一个合法的「已解析」结果，不是 `null` 本身**。闭包变量用 `AdminTokenContext | null` 且以 `=== null` 判别，`null` 只表示「尚未解析」，因此**未配置态不会被反复重解析**。这一点必须写清，否则后续有人把判别写成 `resolvedAdminToken?.token === null` 就会退化成「每个请求都读盘」。
- **dev 的动机成立且我认可**：启动期解析需要 `hub.hello().workspaceRoot`，而 `hello()` 在 build 期调用会让只实现了部分方法的 hub spy（`test/serve/send-images-http.test.ts`、`test/serve/team.test.ts`）抛错 —— 那是**测试替身的契约问题**，不该由生产代码在 build 期强拉 `hello()` 来背。
- **`requireAdminToken`（`:415-423`）与 `adminTokenMatches`（`src/serve/admin-token.ts`）未变**：仍是全仓唯一比较点，仍是常量时间、仍先比长度、仍是同一句 `Admin token required.`。

---

## 2. 两个可观察差异（运维必须知道）

### 差异 ①：首次 admin 请求**之前**创建的文件会被拾取

「启动时解析」⇒ 启动之后才放令牌**永远不生效**（必须重启）。
「惰性 + memo」⇒ 只要**还没收到过任何 admin 请求**，之后放的文件会在第一个请求时生效。

⚠️ 这是一条**不对称**行为，最容易踩：一旦第一个 PATCH/DELETE 打进来（哪怕被 403 拒了），memo 就固化了 —— 之后再把令牌放上去**必须重启**才生效。**结论：一律按「放好令牌 → 重启」操作，不要依赖惰性窗口。**

### 差异 ②：0600 权限告警从「启动时」推迟到「首次 admin 请求时」

`onNotice` 只在真正解析时触发（`server.ts:392`），所以：

- **启动日志里不再有 token 权限告警**；
- 只有**第一个破坏性请求**到达时，stderr 才会出现 `admin token: admin token file is 644, expected 600`；
- ⇒ **如果从未有人发起管理请求，运维永远看不到这行告警。** 这是本次偏差最实际的运维代价，**在 runbook 里用显式 `stat` 检查补偿**（§4 第 3 步），不要依赖日志。

### 2.1 其他运维须知

- **改令牌必须重启**（memo 固化）；`systemctl restart my-agent`。
- **env 优先于文件**（`resolveAdminToken` 的解析顺序未变）：若 unit 里设了 `MY_AGENT_ADMIN_TOKEN`，改 `.my-agent/admin-token` **完全无效**。
- **当前 unit 未设该 env**（`systemctl show -p Environment` 只有 `PATH`）⇒ 生效来源是文件。
- **审计日志的时机也随之变化**：`auditAdmin`（`server.ts:401-413`）仍是一次尝试一行，但「首次请求之前无任何 admin 日志」现在是常态，不是异常。

---

## 3. 裁决不变

**「不首启动自动生成」的裁决（主设计 §12 第 1 条）继续有效**：未配置 ⇒ 两条破坏性路由一律 403，无 loopback 例外，**不生成、不落盘、不回吐**。本次偏差只改「何时读」，不改「读不到怎么办」。

---

## 4. 令牌生成 / 轮换 runbook（可直接执行）

> **为什么必须有这一节**：主设计 §8.1 拍板「由 ops 在本机跑一次生成命令」，但**那条命令全仓不存在** —— `docs/rnd-team.md` 没有、`scripts/` 没有、PRD §7 只写「令牌来源：env」。当前盘上现状是 `.my-agent/admin-token` 不存在、`MY_AGENT_ADMIN_TOKEN` 未设置，正在跑的 serve 还是旧后端（无 PATCH 路由）。⇒ **一旦换成新 dist 重启，所有 PATCH/DELETE 都会 403**，用户会以为功能坏了。这不是理论缺口，是上线即触发的。

### 4.0 部署前置（顺序不可换）

**先生成令牌，再换新 dist 重启。** 反序会得到一个「功能看起来完全坏掉」的窗口。

### 4.1 放置位置（最容易错的一条）

令牌路径**相对于 workspace root**，不是 `$HOME`、也不是 `cwd` 的偶然值：

```
<workspaceRoot>/.my-agent/admin-token     # 本机 = /home/heiwa/my-agent/.my-agent/admin-token
```

来源：`src/serve/admin-token.ts` 的 `ADMIN_TOKEN_FILE = path.join(".my-agent", "admin-token")`，在 `resolveAdminToken` 里与 `workspaceRoot` 拼接；`workspaceRoot` 由 `hub.hello()` 给出（本机 = unit 的 `WorkingDirectory`）。
⇒ 放到 `~/.my-agent/admin-token` **不会生效**，且不会报错，只会 403。

### 4.2 生成命令（只在本机终端显示，绝不进房间）

```bash
cd /home/heiwa/my-agent
mkdir -p .my-agent
( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex")+"\n")' > .my-agent/admin-token )
chmod 600 .my-agent/admin-token
```

三条硬约束：

1. **权限必须 600**：`umask 077` + 显式 `chmod 600`（双保险）。实现会 `stat` 并告警，但**不会拒绝** —— 所以不能指望服务端兜底。
2. **绝不回显到任何持久化位置**：不要 `cat` 进终端记录、不要 `echo` 进房间消息（**房间消息会落 ledger**）、不要写进 `my-agent.json`、不要贴进 issue。查看用 `cat .my-agent/admin-token` 只在**本机终端**、看完即过；手机上通过抽屉手输。
3. **64 位十六进制**（32 字节）⇒ 无空白、无换行问题（实现 `trim()` 掉尾随换行）。

> 备选（等价）：`export MY_AGENT_ADMIN_TOKEN=<64 hex>` 写进 unit 的 `Environment=`。缺点：令牌进了 unit 文件（`/etc/systemd/system/my-agent.service`），比 600 的普通文件更容易被误读、误备份。

### 4.3 验证（三步，缺一不可）

```bash
# ① 权限
stat -c %a /home/heiwa/my-agent/.my-agent/admin-token      # 期望 600

# ② 服务端确实读到了（用错的令牌必须 403，用对的令牌必须非 403）
T=$(cat /home/heiwa/my-agent/.my-agent/admin-token)
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  -H "X-Admin-Token: definitely-wrong" -H 'Content-Type: application/json' \
  -d '{"coordinator":null}' http://127.0.0.1:4317/api/rooms/rnd
#   期望 403 —— 证明守卫生效（✗ 若 200/400 说明路由没走守卫）

curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  -H "X-Admin-Token: $T" -H 'Content-Type: application/json' \
  -d '{"coordinator":"manager"}' http://127.0.0.1:4317/api/rooms/rnd
#   期望 200（或 404/409，取决于房间状态）—— 只要**不是 403** 即证明令牌被读到

# ③ 明确拒绝「未配置」不会误判为令牌错
#   fail-closed 语义下两者同为 403 + 同一句 "Admin token required."（AC-11b 不泄露）
```

⚠️ 若 ② 的第二次仍是 403：先查 §4.1 路径、再查 unit 是否设了 env、最后确认**是否重启过**（memo）。

### 4.4 轮换令牌

1. 覆盖文件（`umask 077` + `chmod 600`，同上）；
2. **`systemctl restart my-agent`** —— 不重启不生效（§2 差异 ①）；
3. 手机抽屉里重新输一次（`sessionStorage` 随标签页，旧值不会自动更新）；
4. 轮换后旧令牌立即失效（无宽限期、无多令牌并存 —— 单共享密钥模型，与 PRD 非目标一致）。

### 4.5 撤销令牌

`rm .my-agent/admin-token`（或删 unit 的 env）+ 重启 ⇒ 两条路由回到「一律 403」。这是**有意设计的关闭开关**，不是故障。

---

## 5. 建议：`docs/rnd-team.md` 增一节「管理令牌运维」

**我的评估：要加。** 理由：`.trash` 清理已经在那里占了「运维必须记得的事」这一档位置，令牌是同类且更致命（错一次 = 功能全 403，且**没有任何启动期日志提示** —— §2 差异 ② 放大了这一点）。没有文档，下一次部署几乎必然踩 §4.1 的路径坑。

建议与 `.trash` 小节并列，草稿（可直接粘，落点由 manager 定）：

```markdown
## 管理令牌（房间管理的破坏性操作）

改成员 / 改 coordinator / 删除房间需要 `X-Admin-Token`。未配置 ⇒ 一律 403（fail-closed，无本机例外）。

**位置**：`<workspace root>/.my-agent/admin-token`（本机 `/home/heiwa/my-agent/.my-agent/admin-token`），
**不是** `~/.my-agent/`。优先级：`MY_AGENT_ADMIN_TOKEN` env > 该文件。

**首次生成**（只在本机终端执行，令牌绝不贴进房间/日志/提交）：
    cd /home/heiwa/my-agent && mkdir -p .my-agent
    ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex")+"\n")' > .my-agent/admin-token )
    chmod 600 .my-agent/admin-token
    stat -c %a .my-agent/admin-token    # 必须是 600

**生效**：令牌在**首个管理请求时**读取一次并缓存 ⇒ **改/删令牌后必须 `systemctl restart my-agent`**。
权限不是 600 时只在首个管理请求的 stderr 告警一行 ⇒ 不要依赖日志，用上面的 `stat` 自查。

**撤销**：删文件 + 重启 ⇒ 回到「一律 403」。

**注意**：`.my-agent/` 已被 `.gitignore:4` 忽略，令牌不会误入库；不要把令牌写进 `my-agent.json`。
```

---

## 6. 对 AC 的影响：无

| AC | 是否受影响 | 说明 |
|---|---|---|
| AC-11a 未配置 ⇒ 403 | **不受影响** | fail-closed 逻辑未变；「何时读」不改「读不到怎么办」 |
| AC-11b/c 不泄露 | 不受影响 | 同一句、同码 |
| AC-11d 常量时间单点比较 | 不受影响 | `admin-token.ts` 零改动 |
| AC-11e 审计日志 | **取证时机变化** | 首个管理请求之前无 admin 日志属正常；qa 用例应先打一发请求再看 stderr |
| AC-12 回归 | 不受影响 | A 笔已绿 |

---

## 7. 未闭合边界（已知、按现状接受）

1. **首次请求之前/之后不对称**（§2 差异 ①）：不修。修法（每请求 stat 文件 mtime）会引入 I/O 与新的时序面，收益不抵成本；用 runbook 的「改完就重启」覆盖。
2. **0600 告警可能永不可见**（§2 差异 ②）：不修。用 §4.3 的显式 `stat` 作为部署门禁；若日后要做，最便宜的做法是在 `serve` 启动完成后补一行**不含令牌**的 `admin token: source=file|env|none` 汇总日志（不触发解析、不改变惰性语义）—— 需要时可作为独立小改提出。
3. **单共享密钥、无轮换宽限期**：与 PRD 非目标一致，不扩成账号体系。
