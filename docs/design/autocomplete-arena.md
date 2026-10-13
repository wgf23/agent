# Autocomplete arena：底部栏自动补全

## 实现状态

- 基线：candidate 1（分支 `arena/autocomplete-c1`，提交 `e76483f`）。cherry-pick 到 master 的提交是 `709e595`（`arena: bottom bar redesign (candidate 1)`）。
- 移植：candidate 2 的两个组件抽取，加判定期新增，提交 `5354a32`（`refactor: autocomplete grafts from arena synthesis`）。
- 跨模型判定：candidate 1 得 19 分，candidate 2 得 15 分，判定推荐 candidate 1 作为基线。

分支分叉点是 `f028cdb`。

## 基线：candidate 1

判定把 candidate 1 选作基线，理由是：

- **匹配来自实时输入文本**。`src/tui/suggestions.ts` 的纯函数从当前输入派生匹配列表，所以一次快速输入前缀加一次 Enter 也能补全成命令，而不是把前缀当消息提交。
- **Esc 优先级正确**。菜单打开时 Esc 只关菜单，菜单关闭时才取消正在流式输出的回合。
- **权限对话框关闭菜单**。`permission` action 把 `menu` 置为 `MENU_CLOSED`。
- **团队边框会变青色**。有 rob 工作时 `PromptInput` 的回合边框变青，等待审批时变黄。

## 集成时的漂移

分叉点之后，master 落入了两个与 arena 无关的功能：

- 交互式 API key 设置（`src/tui/index.tsx` 向导、`src/config/**`、`src/cli/setup.ts`）。
- npm 可安装 skills（`src/skills/**`、`src/tools/registry.ts`、`src/agent/system-prompt.ts`、`src/cli/skill.ts`）。

candidate 只改了 `src/tui/**` 和 `test/tui/**`。master 在这些路径里只改了 `src/tui/index.tsx`（设置向导），而 candidate 没有碰它，所以 cherry-pick 干净落地，两个功能都保留：`src/tui/index.tsx` 仍是设置向导版本，candidate 的底部栏改动叠加在其余文件上。

## 移植

移植落在 candidate 1 基线上，提交 `5354a32`。

| 移植 | 来源 | 改动 |
| --- | --- | --- |
| a | candidate 2 | 共享 `SuggestionMenu` 组件。按 candidate 1 的 `Suggestion`/`MenuState` 形状改写，`PromptInput` 用它替换内联菜单标记。保留 candidate 1 的选中样式和 `paddingX`，只做渲染抽取。 |
| b | candidate 2 | 共享 `StatusRow` 组件。`StatusBar` 和 `TeamStatusBar` 都改成在同一个单行 `wrap="truncate"` 行上拼 segment。各自显示的数据不变。 |
| c | 判定期新增 | 确定性 accept。`menu_accept` 是 reducer action，携带实时输入文本，用 reducer 自己的 `menu.index` 加纯匹配函数算出补全值。快速输入下 `"/he"` 加 Enter 补成 `"/help "`；Down 紧跟 Enter 接受移动后的行。 |
| d | candidate 2 | reducer 级菜单测试。按 candidate 1 的状态形状改写：打开、移动、接受，以及在 Esc、权限对话框、历史召回时关闭。 |
| e | 判定期新增 | 团队补全。团队模式实际处理的命令是 `/help`、`/dm`、`/sub`、`/quit`（见 `src/tui/team/App.tsx` 的 `runCommand`），只补全这四个，`@` 仍补全 rob 名字。 |
| f | 判定期新增 | 团队状态行。团队状态暴露 `robStatus === "working"`，共享行在有 rob 工作时显示 spinner。 |

### 移植 c 的机制

`menu_move` 和 `menu_accept` 都接收组件传入的实时文本。React 把同一次同步输入里的 dispatch 按顺序排队，reducer 依次用上一个 action 的结果处理下一个，所以 Down 的 `menu_move` 先更新 `menu.index`，紧跟的 `menu_accept` 读到的是移动后的 index。输入文本随 action 传入，不依赖已经提交的 `state.input`，因此 `set_input` 还没提交时匹配依然成立。组件另外用同一个纯函数 `acceptMenu` 把补全值镜像进本地 ref，让同一 tick 内第二次 Enter 已经看到补全后的行并提交。

## 拒绝：candidate 2

只取上面命名的移植，candidate 2 不作为基线。判定记录的真实缺陷：

- **快速输入下 Enter 可能提交而不是补全**。它的 `onMenuAccept` 读 reducer 里已提交的菜单项，提交滞后于击键，于是快速输入的前缀会被当成消息提交。
- **权限对话框打开时菜单还在**。它没有在 `permission` action 里关闭菜单。
- **团队边框从不变青色**。它的团队行没有流式状态。

## 跨模型判定

candidate 1 得 19 分，candidate 2 得 15 分。判定推荐 candidate 1 作基线，理由是实时文本匹配、正确的 Esc 优先级、权限对话框关闭菜单，以及团队边框的流式状态。

## 验证

### cherry-pick 后，提交 `709e595`

- `pnpm typecheck` 通过。`tsc --noEmit`，退出码 0。
- `pnpm lint` 通过。`biome check .`，140 个文件，无修改，退出码 0。
- `pnpm test` 通过。53 个测试文件，351 个测试，退出码 0。
- `pnpm build` 通过。`dist/index.js` 177.89 KB，退出码 0。

### 移植后，提交 `5354a32`

- `pnpm typecheck` 通过。`tsc --noEmit`，退出码 0。
- `pnpm lint` 通过。`biome check .`，142 个文件，无修改，退出码 0。
- `pnpm test` 通过。53 个测试文件，364 个测试，退出码 0。
- `pnpm build` 通过。`dist/index.js` 180.05 KB，退出码 0。

### 真实 TUI（PTY）

在仓库根目录设置真实 `DEEPSEEK_API_KEY` 启动 `node dist/index.js`，用 PTY 驱动捕获画面。圆角边框输入框、其下的状态行、`/` 后的菜单、`/he` 加 Enter 补成 `/help `、第二次 Enter 打出帮助、`/quit` 退出码 0，全部捕获成功。逐帧记录在集成报告里。

## 不确定

- **团队 elapsed 跳过**。团队状态没有每个 rob 的开始时间戳（`TeamRobState` 继承 `TranscriptState`，不含 `runStartedAt`），所以共享行只加了 spinner，没有 elapsed。
- **命令提交后输入不清空**。执行 slash 命令走 `runCommand`，不经过清空输入的 `submit` action，所以命令文本留在输入框里（这是 master 既有行为，不是本次引入）。PTY 验证里用退格清空后输入 `/quit`。
