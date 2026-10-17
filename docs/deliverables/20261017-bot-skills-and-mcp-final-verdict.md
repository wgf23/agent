# B-4 终判：bot skills + MCP 作用域（AC-1..AC-14）

> **锚点（产物 / release 认证）= 远端 `1eb7110`**；其后的本地 docs 提交**不影响该锚点**。
> **实测条件**：`1eb7110..<实测时 HEAD>` 的**非 `.md` 改动数 = 0**（即代码面自 `1eb7110` 起逐字节未变），且实测时工作区对 `src/ test/ shared/` **零改动**。
> **为什么这样写**：`origin/main == HEAD` 是**会腐坏的状态句** —— push 之后 `origin/main` 前移，而 `1eb7110` 仍是实测锚点。按 PRD §12.8d，会腐坏的状态不写进散文，改写成**条件陈述**。
> **跑法与口径**：`HOME=/tmp/fakehome`，`vitest run --maxWorkers=4` ⇒ `170` files / `1579` tests 全绿（两轮一致）。
> **数字规则**：本文所有 diff 数字**同句带区间**；不带区间的裸数字一律不写（PRD §12.8d「第 7 起：裸数字」）。
> **证据规则**：证据指针一律写成 `文件路径: 完整用例名`，逐字完整，禁前缀/片段（PRD §12.8d-2）。

---

## 1. AC 终判表

| AC | 结论 | 证据指针 | 说明 |
|---|---|---|---|
| **AC-1** bot 的 skill 白名单可勾选并持久化、重启后仍在 | **绿** | `test/config/project-file.test.ts: round-trips a skill whitelist and MCP selection through the file`；`test/serve/bots-http.test.ts: confirms a skill list patched without its flag, once` | 落盘 + HTTP 透传双向读回。**「可勾选」属 UI，见 AC-4** |
| **AC-2** 未指派的 skill 不出现在系统提示 `## Skills` | **未做（实现正确、零断言）** | — | ⚠️ **无用例**。探针（锚 `1eb7110`，干净树）：把 `src/rob/backend.ts` 的 `skills,` 改成 `skills: undefined`（提示不再反映作用域）⇒ `test/rob` + `test/skills` **`313` 用例全绿**。行为本身正确（另一探针：作用域只含 `alpha` 时提示含 `## Skills` 与 `alpha`、不含 `beta`） |
| **AC-3** `load_skill` 对未指派 skill 失败且不读文件 | **绿** | `test/skills/tool.test.ts: refuses an out-of-scope skill without touching discover or read`；`test/skills/tool.test.ts: refuses every skill under an empty allowlist, again with no IO` | 断言含「未触碰 discover / 未读文件」，非仅返回失败 |
| **AC-4** 「已安装 Skill」视图列 name/包/版本/描述 + 指派状态 | **部分：API 绿 / UI 未做** | API：`test/serve/catalog-http.test.ts: lists an installed skill without its directory`；`test/serve/catalog-http.test.ts: has no dir key at all` | UI 属 B-6a，未开工 |
| **AC-5** UI 装/删 skill、失败可读、无残留包目录 | **未做（HTTP/UI 层）；CLI 已绿** | CLI：`test/skills/install.test.ts: rejects an invalid package and installs nothing`；`test/skills/install.test.ts: keeps a pre-existing package when a re-add fails validation` | `src/serve/server.ts` 无 skill 安装/移除路由（`app.get("/api/skills")` 为只读） |
| **AC-6** 可增删改 MCP server、保存前校验、非法 `command` 被拒 | **未做** | — | `src/serve/server.ts` 只有 `app.get("/api/mcp")`，无 `PUT/DELETE /api/mcp`（B-5 未开工） |
| **AC-7** 每个 bot 只看到自己启用的 MCP server 工具 | **绿** | `test/mcp/scope.test.ts: does not leak tools from servers the bot did not enable`；`test/rob/team.test.ts: gives each rob only the mcp servers it enables` | 纯函数层 + 运行时层各一条 |
| **AC-8** 单 server 启动失败只产生 notice，不阻塞其他 | **绿** | `test/mcp/manager.test.ts: turns one server's failure into a notice without stopping the others` | |
| **AC-9** 保存后**新实例的下一 turn**生效；保存**会**打断进行中的一轮 | **未做（证据无效）** | — | ⚠️ **原拟指针是假用例**：`test/rob/skill-injection.test.ts: re-resolves the scope on every turn, so a new install shows up` 的断言是 `expect(installed).toHaveLength(2)` —— 断言的是**用例自己的局部数组**，与 backend 无关。探针证实两处均无用例：①「不再重解析」⇒ `test/rob` `89` 用例全绿；②删掉 `this.approvals.denyRob(config.name, TURN_INTERRUPTED_REASON)`（保存不再打断）⇒ `test/serve` + `test/rob` `432` 用例全绿。行为本身正确（探针：turn1 提示无 `beta`、turn2 有） |
| **AC-10** 非 loopback ⇒ 403；C15 五条泄漏路径闭环 | **部分：泄漏面绿 / 403 面未做** | 泄漏面：`test/mcp/manager.test.ts: refuses a server whose tool names expose its configuration, and says why`（`notices` + `tools[].name`）；`test/mcp/manager.test.ts: redacts a description that carries a value and keeps the server`（`tools[].description` / `servers[].tools`）；`test/mcp/redaction-parameters.test.ts: AC-10/12: contract positions in inputSchema refuse the server > refuses a server whose schema hides the value in required[]`（`tools[].parameters`）；`test/serve/catalog-http.test.ts: returns the variable names and never their values`（`GET /api/mcp` 不回 env 值） | 403 面只对 **agents 安装/取消**成立（`test/serve/agents-http.test.ts: refuses an install and a cancel on a non-loopback bind`）；**skill 安装 / MCP 定义的 403 无从验证 —— 端点不存在**（见 AC-5/AC-6） |
| **AC-11** 向后兼容：无 `skills` = 全可用；无 `mcp` = 不启用 | **绿** | `test/skills/scope.test.ts: row 1: an absent list allows every installed skill`；`test/mcp/scope.test.ts: returns nothing when the bot enables no server` | 「无 `mcp` = 不启用」是**行为变更**，须在 UI/发布说明可见（U6），UI 未做 |
| **AC-12** 新增判断均为纯函数 + 有单测；不引入 jsdom | **绿** | `test/mcp/redact.test.ts: scanServerToolText > never reports a key alongside a cause other than a value hit`；`test/mcp/scope.test.ts: filterToolsByServers > returns the tools of the enabled server only` | `src/mcp/redact.ts` / `src/mcp/scope.ts` 无 IO 依赖；`package.json` 无 `jsdom` / `@testing-library` |
| **AC-13** 前三条线不回归 | **绿** | 全量实跑（见页首口径）：`170` files / `1579` tests | 含 `test/web/*`、`test/rob/room-text*` |
| **AC-14** 红线：路径集 + 三项禁止 + `src/tui` 窄口 | **绿** | 见下方四段式 | |

### AC-14 四段式（区间 `ad3b41a..1eb7110`）

| 项 | 累计 `ad3b41a..1eb7110` | 本轮 `ea72c40..1eb7110` | 判读 |
|---|---|---|---|
| `src/tui/**` | **2/1**（仅 `src/tui/index.tsx`，单 hunk） | **0/0** | design 唯一例外，合规 |
| `screenshots/**` | **0** | **0** | 零 |
| `src/rob/room-text.ts` | **0** | **0** | 零 |
| `shared/protocol.ts` | **37/0**（纯加性、零删除） | **23/0** | C19「协议只允许加性变更」允许 |

> **不写「四项零命中」**：四项里**有两项非零**。把合规改动写成「不存在」，复查时会误判成越界 —— 与 §12.8d 治的是同一类病。

---

## 2. 用户可见面：**零**

- `web/` 区间 `ad3b41a..1eb7110` 只新增 **1** 个文件：`web/src/botScope.ts`（`+14` 行）。
- 该文件**零组件引用**：`grep -rn "botScope" web/src/` 无命中；唯一引用是 `test/rob/bot-scope-consistency.test.ts`。
- 构建产物文件名与尺寸与 `ad3b41a` 一致：`index-X8xuyzSI.js` = `570444` B、`index-BzkrIWNV.css` = `50230` B。
⇒ **服务端能力上线，UI 零变化。B-6a 未开工，用户看不到任何新界面 —— 不得对外表述为「有新功能」。**

---

## 3. 非阻塞项（未关闭的记「未做」，不写「接受风险」）

| # | 项 | 状态 | 后果 |
|---|---|---|---|
| 1 | design §10 L5「`examples` 非数组 ⇒ 整 server 拒绝」的括号只在 `malformed` 为**首个**拒因时成立 | **未做** | 文档措辞精度问题，不改行为；下批改措辞 |
| 2 | design **文首红线块**（位于 H1 与 `## 0. 一句话方案` 之间）「授权面 = 下方清单」漏列 **7** 个文件 | **已做（`8a8a5b4`）** | `8a8a5b4` 已把散文白名单换成 `text` 字面清单；对 `ad3b41a..1eb7110` 的 **36** 个非 `.md` 文件做机械覆盖校验，**UNCOVERED = 0**。被补的正是旧散文漏掉的 **7** 个文件（逐个可数）：`.gitignore`、`src/agent/agent.ts`、`src/tools/types.ts`、`src/tools/registry.ts`、`test/fixtures/fake-mcp-server.mjs`、`test/serve/bots-http.test.ts`、`test/serve/catalog-http.test.ts`。（`src/tui/index.tsx` 原由 tui 例外条款覆盖，**不计入**这 7 个。）**下批不得重复补**（正清单、负向清单、`--no-renames` 机制均已在 `8a8a5b4` 内） |
| 3 | `was refused` 中性兜底零用例 | **未做（设计要求，非遗漏）** | design §13.3.1「`was refused` 类中性兜底属于不可达防御」明文不写用例；且实测删守卫后 `test/mcp` `13` failed，说明该兜底**在不变量被破坏时才出现** ⇒ 为它造期望值用例 = 把 bug 固化成契约 |

> **#2 的更正留痕（review 核出、leader 独立复现）**：本行原记「**未做**」，而 `8a8a5b4` 在写终判（`566c1dd`）**之前**就已完成 —— **写终判那一刻它已经是「已做」了**。
> ⇒ **腐坏方向是「把有写成没有」**，与「没做的说成做了」同样有害，且更隐蔽：前者会让人**重做一遍**（正是本文 §4 自己警告的"据此修正回去"），后者至少会被"没做出来"顶回来。
> ⇒ 这也是 §12.8d 的一次自反：**`未做` 本身就是一个会腐坏的状态句。** 该行**保留不删**，唯一目的是**防重复补**；判据是「有提交号 + 机械校验结果」，不是「我记得做了」。
> ⚠️ **不要用行号复查这一条**：`1eb7110` 的 `:8-14` 是 7 行散文，`7a91d6c` 的 `:8-14` 是 1 行标题 + 代码块前 6 行（代码块实际延伸到 `:20`）。**按旧 `:8-14` 去核，会看到 7 个中的 3 个（`src/agent/agent.ts`、`src/tools/types.ts`、`src/tools/registry.ts`），漏掉 4 个（`test/serve/**` 2 个、`test/fixtures/**` 1 个、`.gitignore`）** —— **部分对上比完全看不到更容易让人放心**：看到 3 条对上了，人就不往下查了。锚点变窄，反向制造"仍未补"的错觉。

## 4. 本轮新发现的证据缺口（同样记「未做」）

| # | 缺口 | 建议补法 | 是否阻塞 |
|---|---|---|---|
| 4 | **AC-2**：作用域 → 系统提示的接线无断言 | 一条用例：作用域 `[alpha]`、已装 `[alpha,beta]`，断言 `messages[0].content` 含 `alpha` **且不含** `beta` | 否 |
| 5 | **AC-9**：「每 turn 重解析」的现有用例是**假用例**（断言自己的局部数组） | 改成断言 turn2 的提示/工具集含新装 skill | 否 |
| 6 | **AC-9**：「保存打断进行中一轮」无断言 | 断言 `denyRob` 的 reason 为 `TURN_INTERRUPTED_REASON` | 否 |

> 三条均为**补断言**，不改变任何实现，按 leader 的判据（「改动会不会让已在跑的验证失效」）可并入下批，不需解冻。
> **共性是假阴性方向**：实现是对的，但**删掉实现也不响** ⇒ 属 PRD §12.8d-2 的**第 3 层（假用例）/ 第 2 层（断言退化）**。

---

## 5. 变异探针留痕（锚 `1eb7110`，干净树）

| 探针 | 结果 | 判读 |
|---|---|---|
| 删 `redact.ts` 的 `!refused &&`（保留两格） | `test/mcp/redact.test.ts` **1 failed / 36 passed** | `refused` 守卫被钉住 |
| 同上 + **只留非判别格** | **37 passed 全绿** | **假用例**：非判别格单独不构成守卫证据 |
| 守卫在位 + **只删判别格** | **37 passed 全绿** | **删格不响**：验证可被静默拆除 |
| F2 回退为 `out[k]=v` | `test/mcp/redact.test.ts` **2 failed / 35 passed** | 顶层与 `properties.x` 两层均被钉住 |
| 互换两种拒因措辞 | `test/mcp/manager.test.ts` **2 failed / 14 passed** | 互斥断言有效 |
| 删 `external-ref` 显式分支 | `test/mcp/manager.test.ts` **1 failed / 15 passed** | 显式分支被钉住 |
| 删 `refuseIfHit` 的 `if (refused) return;` | `test/mcp` **13 failed / 83 passed** | 守卫② 由多 server 连续扫描间接覆盖 |

> 判别格/非判别格的判据见 PRD §12.8d-4；「代码形状不是证据」见 §12.8d-3。

---

## 6. 一句话结论

**AC-1/3/7/8/11/12/13/14 绿；AC-4/AC-10 部分绿（泄漏面已闭环，UI/写端点未开工）；AC-5/AC-6 未做；AC-2/AC-9 实现正确但证据缺口（记「未做」）。**
**对外口径：服务端作用域与泄漏修复已上线，UI 零变化。**
