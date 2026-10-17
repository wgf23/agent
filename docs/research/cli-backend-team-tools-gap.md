# CLI 后端 bot 无法参与 bot 间聊天：根因定位

> ⚠️ **已过期**：结论被 gateway 推翻，见 `docs-dist/verification/cli-backend-team-bridge.md`。

状态：已复核代码 + 新增可复现单测
范围：`pi` / `opencode` / `claude` 三种 `kind: "cli"` 后端（`createCliBackend` / `createOpencodeBackend` / `createClaudeBackend`）
验证文件：`test/rob/cli-backend-team-tools-gap.test.ts`（3 项断言，本地全绿）

---

## 0. 结论先行

**不是崩溃类 bug，而是“半成品设计边界”导致的功能性缺陷。**

团队消息工具的注入是**只在 native 后端构造**的（`src/rob/backend.ts:51,87-97`），
而 CLI 后端的工具白名单**只存在 pi/claude/opencode 自己的内置文件工具**
（`src/rob/cli-backend.ts:45-50,70-82`；`src/rob/claude-backend.ts:29-38,77-88`；
`src/rob/opencode-backend.ts:34-41`）。

关键的不对称在于：**收 DM 的链路是后端无关的，回 DM 的链路是 native-only 的**。
`Team.postDm` 无条件把 DM `deliver` 给目标 rob（`src/rob/team.ts:396-402`），
无论该 rob 是 native 还是 CLI；而能回消息的 `send_message` 工具只在 native 分支存在。
于是 CLI rob **能读到 DM、却没有任何工具能回复** —— 这就是“无法参与 bot 间聊天”的直接根因。

设计意图确实存在（三处注释都写明 CLI 后端“跑自己的工具注册表”）：
`src/rob/team.ts:74`、`src/rob/rob.ts:66`、`src/rob/types.ts:45-46`。
但这只解释了“为什么没有注入”，没有解释“为什么仍然把它放在一个会互相 DM 的团队里并投递 DM”。
边界只做了一半，因此以“设计边界”开脱不成立，应按缺陷处理（见 §4）。

---

## 1. 精确调用链：一个 CLI rob 收到 DM 时发生什么

### 1.1 投递（后端无关）

| 步骤 | 位置 | 行为 |
|---|---|---|
| A1 | `src/rob/tools.ts:73-75` | native 侧的 `send_message` 调用 `team.postDm(from, to, text)` |
| A2 | `src/rob/team.ts:396-402` | `postDm` 记录 DM，并 **无条件** `this.robs.get(to)?.deliver({ kind: "dm", from, text, at })` |
| A3 | `src/rob/rob.ts:177-179` | `Rob.deliver` 只把 inbound 推进 `this.inbox`（`AsyncQueue`）——与后端种类无关 |

结论：DM 会进入 CLI rob 的 inbox。

### 1.2 起一轮 turn

| 步骤 | 位置 | 行为 |
|---|---|---|
| B1 | `src/rob/rob.ts:251-270` | `run()` 主循环 `waitForBatch` → `runOnce` |
| B2 | `src/rob/rob.ts:282-303` | `runOnce` 调 `this.backend.run({ inbound: batch, ... })` |
| B3 | `src/rob/rob.ts:124-154` | 构造函数里 `backend.kind === "cli"` 时走 `createOpencodeBackend` / `createClaudeBackend` / `createCliBackend`，**不传 `team`、不传任何团队工具** |

### 1.3 CLI 后端把 DM 变成给外部进程的 prompt

以 pi 为例：

| 步骤 | 位置 | 行为 |
|---|---|---|
| C1 | `src/rob/cli-backend.ts:104-152` | `createCliBackend.run` 拼 `args` |
| C2 | `src/rob/backend.ts:125-127,153-158` | `promptFor(inbound)` 对 dm 渲染成 `[from rob:<name>] <text>` |
| C3 | `src/rob/cli-backend.ts:477-480` | 通过 stdin 发 `{type:"prompt", message: inbound.map(promptFor).join("\n\n")}` 给 pi 子进程 |
| C4 | `src/rob/cli-backend.ts:119-137` | 子进程用 `--tools read,write,edit,bash`（或 `--no-tools`）启动 |

claude / opencode 同理：
`src/rob/claude-backend.ts:116,126-129`（`--allowedTools` 仅 Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch）、
`src/rob/opencode-backend.ts:778`（同样的 `promptFor`）。

### 1.4 为什么它没有 `send_message`

1. `createSendMessageTool` / `createListRobsTool` / `createReadMessagesTool` / `createDelegateTool`
   的**唯一构造点**是 `src/rob/backend.ts:86-97`，属于 `createNativeBackend`。
   `src/rob/rob.ts:144-154` 的 CLI 分支根本没有引用它们。
2. pi 侧工具集是**硬编码白名单**：`PI_TOOLS` 只有
   `read_file→read / write_file→write / edit_file→edit / bash→bash`（`src/rob/cli-backend.ts:44-50`），
   `piToolAllowlist` 也只在这 4 个里按权限过滤（`src/rob/cli-backend.ts:70-82`）。
   **没有任何映射能产出 `send_message`**。
3. 系统提示注入不对等：native 的 `systemInstructions` 会带上
   `"Use send_message ..."` 和全队 roster（`src/rob/rob.ts:415-423` 调 `renderCollaboration`），
   而 pi 只拿到 `--append-system-prompt <role>`（`src/rob/cli-backend.ts:126`）。
   所以 pi 甚至不知道有队友、有 DM 这回事。
4. 配置层也主动拒绝在 CLI 后端上开团队工具权限：
   `CLI_UNSUPPORTED_TOOLS = [send_message, delegate, remember, forget]`（`src/rob/types.ts:45-52`），
   校验器直接报 “only available to the native backend”（`src/rob/types.ts:101-110`）。

净效果：CLI rob 能看到 `[from rob:X] ...` 字样，却没有任何工具可回应——
“参与不了 bot 间聊天”。

---

## 2. 最小可复现验证

新增 `test/rob/cli-backend-team-tools-gap.test.ts`，三个独立边界的断言：

| 用例 | 断言 | 证据强度 |
|---|---|---|
| `native rob advertises every team tool` | 用 `createMockProvider` 跑一个 native `Rob`，`provider.requests[0].tools` 含 `send_message / list_robs / read_messages / delegate` | **强**：真实执行 native 后端到 provider 的完整注入路径 |
| `cli-backend rob launches its child with only pi's read/write/edit/bash` | 用 `test/fixtures/fake-pi.mjs` 跑 `createCliBackend`，从 `FAKE_PI_ARGV_FILE` 读实际 argv：`--tools` 值恰为 `read,write,edit,bash`，且整个 argv 不含任何团队工具名 | **强**：在**进程边界**上验证外部 CLI 实际收到的工具集，且用了真实 DM inbound（`kind:"dm"`） |
| `the cli allowlist module cannot name a team tool` | 即使把 4 个团队工具全设为 allow，`piToolAllowlist(robToolRules(), true)` 仍只返回 `read,write,edit,bash` | 中：纯模块级检查，锁定白名单无法产出团队工具 |

运行：

```bash
npx vitest run test/rob/cli-backend-team-tools-gap.test.ts
# ✓ 3 passed
```

说明：环境里没有真 pi，因此 CLI 侧用仓库自带的 `fake-pi.mjs` fixture 替代真实进程。
它忠实接受 `--tools/--no-tools/--append-system-prompt` argv 并落盘，足以证明
**CLI 后端不可能把团队工具交给外部进程**——这一点与 pi 的真实实现无关，因为
argv 在 `createCliBackend.run` 内就已确定（`src/rob/cli-backend.ts:119-137`）。

补充（可选）观察：native 用例与 CLI 用例用的是**同一份** `robToolRules()`
（`src/rob/tools.ts:14-23`，其中 `send_message/list_robs/read_messages: allow`），
排除了“权限被 deny 所以看不到工具”的干扰——差异纯粹来自后端种类。

---

## 3. 影响面

- 受影响：所有 `kind:"cli"` 后端 rob（pi / opencode / claude）。
- 不受影响：`codex` / `gemini`——它们 `rob:false`，被 `robBlockedReason:"no rob backend yet"` 挡在门外
  （`shared/agents.ts:51-68`），根本不能作为 rob 上线。
- 用户可观察症状：CLI rob 收到 DM 后只会回一句普通文本（甚至不知道要回给谁），
  团队讨论 / `list_robs` / `delegate` 对它全部不可用；`renderCollaboration` 的 roster 也没进它的系统提示。

---

## 4. 结论：bug 还是设计边界？

**判定：功能性缺陷（bug），当前实现处于“设计边界只做了一半”的状态。**

支持“设计边界”的证据：
- 三处注释明示 CLI 后端跑自己的工具注册表：`src/rob/team.ts:74`、`src/rob/rob.ts:66`、`src/rob/types.ts:45-46`。
- 配置校验主动禁止在 CLI 后端配这些工具权限：`src/rob/types.ts:101-110`。

但以下事实让“纯设计边界”站不住：
1. **收发不对称**：DM 投递（`src/rob/team.ts:396-402`）对后端种类无判断，
   而回复能力是 native-only。要么两边都禁用，要么两边都提供——现在是“能收不能回”。
2. 产品把 CLI rob 与 native rob 放在**同一个 roster、同一个 DM 网络**里，
   `postDm` 不区分后端。用户按直觉期待“队友之间能互相说话”，实际却被静默降级。
3. 至少应在 `postDm` / roster 层显式告知或屏蔽 CLI rob，而不是让它收到无法回应的 DM。

建议修复方向（按代价从低到高）：
- **A（最小、推荐）**：在 `postDm` 投递前判断目标是否为可收发团队消息的后端；
  对 CLI rob 不投递 DM，并在 `roster()`/UI 标注“该 bot 无法参与团队 DM”。
- **B（完整）**：给 CLI 后端实现团队工具的桥接——例如 pi 用 `--extension` 注册
  `send_message` 等工具回传到本进程（`src/rob/cli-backend.ts:31-42,136` 已有 extension 通道），
  并把 `renderCollaboration` 注入其系统提示。opencode/claude 同理。
- **C**：若确认不做，则需要产品文档明确“CLI 后端 bot 不参与 bot 间聊天”，
  并在配置/创建界面禁用或警告，避免用户误配。

在 A/C 落地前，应将该问题登记为已知缺陷，而不是当作预期行为。

---

## 附：关键 file:line 索引

- 团队工具仅在 native 注入：`src/rob/backend.ts:51,86-97`
- native vs cli 后端分派：`src/rob/rob.ts:124-154`；native 额外加 memory 工具 `src/rob/rob.ts:165-172`
- pi 工具白名单：`src/rob/cli-backend.ts:44-50,70-82`；argv 组装 `:119-137`；prompt 下发 `:477-480`
- claude 工具白名单：`src/rob/claude-backend.ts:29-38,77-88,126-129`
- opencode 工具/权限映射：`src/rob/opencode-backend.ts:34-41,95-115`；prompt `:778`
- DM 投递（后端无关）：`src/rob/team.ts:396-402`；inbox `src/rob/rob.ts:177-179`
- 设计边界注释：`src/rob/team.ts:74`、`src/rob/rob.ts:66`、`src/rob/types.ts:45-46`
- 配置层拒绝：`src/rob/types.ts:45-52,101-110`
- codex/gemini 现状：`shared/agents.ts:51-68`
