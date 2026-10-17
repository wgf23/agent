# 研发全流程 Bot 团队

在 `my-agent.json` 的 `robs` 里定义了一支覆盖研发全流程的团队，并用一个 `rooms` 把它们串成流水线。每个 bot 都是独立 agent，有自己的角色、权限和会话历史。

## 成员

| bot | 阶段 | 职责 | 关键权限 |
| --- | --- | --- | --- |
| `manager` | 入口/调度 | **rnd 的 coordinator**（收尾写交付物）；只接你的任务，判断该谁做，拆分后分派给其他 bot，汇总回复给出结论与风险 | **只读**：`write_file`/`edit_file` 为 `deny`，不碰代码 |
| `pm` | 需求 | 澄清目标与范围、写 PRD 与验收标准到 `docs/prd/` | 只读代码；只写 `docs/prd/*` |
| `architect` | 架构设计 | 技术选型、模块/接口/数据模型、任务拆分到 `docs/design/` | 只读代码；只写 `docs/design/*` |
| `ui` | **UI/UX 设计** | 界面视觉、布局、配色、层级、动效、交互流程；先开浏览器看现状，改完再回浏览器验证 | 写 `web/*`、`docs/design/ui/*`；Playwright 浏览器工具 |
| `dev` | 开发 | 按方案写代码，小步实现 | 读写代码 + 常用构建命令 |
| `qa` | 测试 | 补测试、跑测试、复现缺陷 | 读写代码 + 常用构建命令 |
| `review` | 评审 | 审 diff，挑问题给修改意见 | 只读 + `git`，**禁止**改代码 |
| `ci` | 集成发布 | 跑 typecheck/lint/test/build，准备发布 | 只读 + 常用构建命令，**禁止**改代码 |

约束设计：`manager`/`review`/`ci` 显式 `write_file`/`edit_file` 为 `deny`，从权限层保证"调度、评审、发布不改代码"；`pm`、`architect`、`ui` 的写权限被通配符限制在各自目录。`bash` 用命令白名单，白名单外落到默认的 `ask`。

## `ui`：能看到真实页面的设计 bot

`ui` 是**界面与交互**设计，不是架构设计。它通过项目级 MCP 服务器 `playwright` 驱动一个真实的 headless Chromium：

- `browser_navigate` / `browser_snapshot` / `browser_find` — 打开页面并读取真实 DOM 与可访问性树
- `browser_evaluate` — 读取计算样式（字号、间距、对比度、断点）
- `browser_click` / `browser_type` / `browser_hover` / `browser_press_key` — 实际走一遍交互流程
- `browser_console_messages` / `browser_network_requests` — 发现前端报错与失败请求
- `browser_take_screenshot` — 存 PNG 给你看
- `browser_resize` — 检查窄屏/断点表现

只有 `ui` 声明了 `"mcp": ["playwright"]`，其他 bot 拿不到这些工具。高风险的两个工具被单独收紧：`browser_file_upload` 为 `ask`，`browser_run_code_unsafe` 为 `deny`。

一次典型的 UI 任务：

```
@ui 帮我看看 web 端的房间页，交互和视觉哪里不顺，然后改好
```

`ui` 会先 `pnpm web:dev`（或直接打开 `my-agent serve` 的地址）→ 浏览器打开 → snapshot 看结构 → 改 `web/` 的样式与组件 → 重新打开验证 → 截图。

## 房间 `rnd`

```json
{
  "name": "rnd",
  "members": ["manager","pm","architect","ui","dev","qa","review","ci"],
  "coordinator": "manager"
}
```

你可以直接对房间说话；`@manager` 让它汇总调度。消息按成员顺序经过每个 bot：`manager → pm → architect → ui → dev → qa → review → ci`，成员用 `room_reply` 发言、不发言即跳过，最多 3 轮。安静后由 coordinator（`manager`）收尾，它这一轮的回复就是交付物，写到 `docs/deliverables/<UTC 时间戳>-<slug>.md`。

- 直接说需求：由全员依次过一遍。
- 只想让某个环节发言：`@ui 把设置页的层级理一下`、`@dev @qa 按这个方案实现并补测试`。
- `@all` 让所有人发言。

## 一次性准备

```bash
pnpm install
pnpm browser:setup    # 下载 Playwright 的 Chromium 到 .my-agent/browsers
```

`browser:setup` 走 `scripts/browser-setup.mjs`，它会从 `@playwright/mcp` 依赖里解析出 Playwright CLI 的路径，所以不需要全局安装。下载目录由 `PLAYWRIGHT_BROWSERS_PATH` 决定；`my-agent.json` 里已把它指向 `.my-agent/browsers`，容器里 `$HOME` 只读时也能工作。

MCP 服务器的环境也做了隔离：`HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` 指向 `.my-agent/browser-home`，浏览器 profile 不污染你自己的目录。`--no-sandbox` 因为在 docker/CI 里没有 user namespace 时需要它；本机跑可以把这一项去掉。

## 已有房间需要迁移

房间一旦有 ledger（`~/.local/share/my-agent/rooms/<workspace-slug>/<room>.json`）就以 ledger 为准，改 `my-agent.json` 不会改一个已经跑过的房间。要让 `my-agent.json` 里新的成员表（8 人，coordinator 为 `manager`）对一个已经跑过的房间生效，执行一次：

```bash
node scripts/room-members.mjs rnd            # 会先写 .bak 备份
node scripts/room-members.mjs rnd --dry-run  # 只看差异
```

它只改 `members`、`coordinator`、`updatedAt`，transcript 原样保留。想彻底重建，也可以换个房间名（例如 `rnd2`）。

## 用法

```bash
my-agent            # TUI，左侧选中 rnd 房间，输入需求
my-agent serve      # Web UI，侧栏里打开 rnd
```

单独驱动一个 bot：

```bash
my-agent team --dispatch manager="把设置页的交互重做一版" --wait-ms 300000
```

## 备注

- bot 都是 `native` 后端，默认 `deepseek-flash`；想换 cli 后端（`pi`/`opencode`/`claude`）时改该 bot 的 `backend`。注意 cli 后端跑自己的工具注册表，`ui` 的浏览器能力只在 native 后端下可用。
- 截图落在工作区根目录（MCP 的 `filename` 相对 cwd）。想集中存放，让 `ui` 传 `.my-agent/screenshots/xxx.png`。
- 截图是给**你**看的：MCP 的 image content 在 `src/mcp/tools.ts` 里只被映射为文本，所以 bot 判断界面靠的是 snapshot、计算样式、控制台与网络日志，而不是像素。
- 房间成员上限是 20（`ROOM_MAX_MEMBERS`，`src/rob/room-limits.ts` 是唯一数字源）；`rnd` 有 8 个成员，离上限还有余量。
- `my-agent.json` 里原有的 `test`/`pi-test`/`opencode`/`dmtest`/`aaa`/`leader` 是早期测试用 bot，与这支流程团队无关，可按需删除。
