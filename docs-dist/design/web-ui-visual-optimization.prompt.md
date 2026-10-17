# 任务提示词：自己截图 → 自评 → 优化 my-agent Web UI 的视觉与交互

> 用法：把下面「=== 提示词开始 ===」到「=== 提示词结束 ===」之间的内容整段复制给任意编码 agent（Cursor / Claude Code / Codex / Aider / 别的 harness）。
> 它自带：环境约束、装浏览器脚本、mock 后端、截图 harness、评审 rubric、回归门槛、交付物清单。

=== 提示词开始 ===

## 你是谁

你是一个同时具备「前端工程 + 视觉设计 + QA」能力的编码 agent。你要在本地仓库 `/home/heiwa/my-agent` 里，**自己启动 Web UI、自己用 headless 浏览器截图、自己看图/量指标做评审、自己改代码、再用新截图自证**。全程闭环，不要等人喂图，也不要只看代码就下结论——**结论必须来自真实渲染的页面**。

## 目标

对 `my-agent serve` 的本地 Web 客户端做一轮**端到端视觉与交互优化**：

1. 用真实 headless Chromium 截出当前 UI 的全套状态（深/浅色、悬停、流式、审批、广场、设置、创建对话、未配置、窄屏、空态）。
2. 基于「像素 + DOM 度量 +（若有）视觉理解」做评审，产出**可复现的问题清单**。
3. 修改 `web/src/**` 与 `web/src/styles.css`，逐项修掉问题。
4. 用同一套 harness 重截，做**改前/改后对照**，逐条给出证据。
5. 保证不破坏现有测试、类型检查、lint 与构建。

## 仓库事实（先读，别猜）

- 技术栈：TypeScript + React 19 + Vite 的 Web 前端（`web/`），Fastify 后端（`src/serve/`）。Node ≥ 20（当前 v24），pnpm 12。
- 前端源码：`web/src/App.tsx`、`web/src/styles.css`（约 3.4k 行，唯一主题源）、`web/src/components/*.tsx`、状态在 `web/src/state.ts` / `web/src/useHub.ts`。
- 设计历史与既定取舍：**必读** `docs/design/web-client.md`（含上一轮截图验收方式、悬停态验证技巧、已知取舍），变更记录看 `CHANGELOG.md`。
- 启动方式：
  - 生产式：`pnpm build` 后 `pnpm serve`（或 `node dist/index.js serve`），默认 `http://127.0.0.1:4317`，静态资源取 `web/dist`。
  - 热更新式（推荐调样式时用）：终端 A `pnpm dev serve`；终端 B `pnpm web:dev`（Vite，默认 `http://localhost:5173`，`/api` 代理到 4317）。
- 无 key 也能起：`my-agent serve` 在没有 API key 时照样启动，但输入框禁用、偏「未配置」态（这本身就是要截的状态之一）。
- 服务只绑 `127.0.0.1`、无鉴权，别绑 `0.0.0.0`。

## 环境硬约束（很关键，先自检）

- **根文件系统 `/` 是只读的**（`ro,nosuid,nodev`）。只有工作区 `/home/heiwa/my-agent` 可写。
  - 因此：`apt install`、写 `~/.config`、写 `/tmp`、`/var/tmp`、`/run` **全部失败**；`~/.cache`、`~/.local/share/pnpm` 也**不可写**。
  - 所有临时目录 / 浏览器缓存 / npm 缓存 **必须落在工作区内**：例如 `$PWD/.tooling`、`$PWD/.cache`，并 export `TMPDIR`、`npm_config_cache`、`PUPPETEER_CACHE_DIR` / `PLAYWRIGHT_BROWSERS_PATH` 指向它们。
  - 例：`mkdir -p .tooling .cache && export TMPDIR=$PWD/.tooling npm_config_cache=$PWD/.cache PUPPETEER_CACHE_DIR=$PWD/.cache`
- **pnpm 装新包会失败**（默认 store 在只读分区，报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK / Read-only file system`）。要在工作区内造 store，或在工作区子目录里用 `npm`：
  - 优先：`cd .tooling && npm init -y && npm i puppeteer`（记得加 `--no-package-lock` 可选）。若 npm 在 pnpm workspace 根下报 `Cannot read properties of null (reading 'matches')`，就**把工具装到工作区内的独立子目录**（如 `.tooling/`）再 `node .tooling/shot.mjs` 运行，别在仓库根跑 npm。
  - 备选：`PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache npx -y playwright@latest install --with-deps chromium`（`--with-deps` 需要 root，失败就只装浏览器本体；系统依赖多半已具备）。
  - 再备选：`puppeteer-core` + `@sparticuz/chromium`（历史上的做法，见 `docs/design/web-client.md`）。
  - 如果实在装不上任何浏览器：退化为**纯 DOM/像素评审**——用 jsdom/`linkedom` 渲染不了真样式，不可取；此时至少用后端直接产的 JSON DOM 快照 + 静态分析（颜色对比度、间距 token、`styles.css` 里的魔法数字）出结论，并**明确标注该轮没有真实渲染证据**，不要假装看过图。
- 结束时**清理**你造的所有临时目录（`.tooling`、`.cache` 等），别把几百 MB 浏览器留在仓库里；`git status` 只能剩你有意修改的源码/文档。

## 步骤 1 · 起一个「能渲染出所有状态」的后端

必须让页面出现：真实流式回复、工具卡、reasoning 折叠、审批弹窗、Bot 广场、设置、创建对话、图片 chip、空态、未配置态。

- 推荐做法：写一个**本地 mock 的 OpenAI 兼容 SSE 服务**（`POST /v1/chat/completions`，`text/event-stream`，分块吐 `delta.content` / `delta.reasoning_content` / `tool_calls`），把它当 provider：
  - `baseURL` 写进工作区项目配置文件（见 `src/config/resolve.ts` 的 `providerOptionsSchema`、`src/config/project-file.ts`），形如 `{"provider":{"baseURL":"http://127.0.0.1:4399/v1","apiKeyEnv":"MOCK_KEY","model":"mock"}}`；
  - key 走环境变量：`MOCK_KEY=test`。
  - 这样走的是**真实流式代码路径**，比前端打桩更可信。
- mock 服务器要能按脚本吐不同内容：长代码块 + 表格 + 列表（测 Markdown 渲染/横向滚动）、超长 tool 输出（测折叠）、reasoning（测思考折叠）、危险工具调用（测审批弹窗）、刻意慢速流（测光标/停止键）。
- 别忘了截图期间**允许 mock 工具调用通过**（例如给该会话开 allow-all），否则审批会卡住后续状态。

## 步骤 2 · 截图 harness（写脚本，别手工）

新建 `scripts/shots.mjs`（或 `scripts/visual-review.mjs`），要求：

- **视口**：桌面 `1440×900`、宽屏 `1600×1000`、窄屏 `390×844`（移动）与 `640×900`（断点边界）。`deviceScaleFactor: 2`。
- **主题**：浅色 + 深色各扫一遍（页面读的主题来源见 `state.ts`/`useHub.ts`，通常有 localStorage / `prefers-color-scheme`，harness 里显式设置，别靠系统默认）。
- **悬停态**：headless 默认报告 `hover: none`，会把「只在悬停出现」的元素强制显示，导致截图假象。启动 Chromium 时加：
  `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`
  然后用 CDP `Input.dispatchMouseEvent`（`mouseMoved`）派发**真实鼠标移动**到目标元素上，等一帧再截。要分别截：无悬停、消息悬停（复制按钮）、代码块悬停（复制）、侧栏行悬停。
- **元素级截图**：`elementHandle.screenshot()` 截单个消息/工具卡/弹窗，便于逐组件点评。
- **度量导出**：每个状态同时 dump 一份 JSON：`document.body.scrollWidth vs clientWidth`（横向溢出）、每个关键元素 `getBoundingClientRect()`、`getComputedStyle` 的 `color/background/fontSize/lineHeight/padding`、可点击元素的命中框尺寸（`<44×44` 的标出来）、`document.activeElement` 与 Tab 顺序、`prefers-reduced-motion` 下的表现。
- **稳定截图**：`await page.evaluate(() => document.fonts.ready)`，禁用动画（注入 `*{animation:none!important;transition:none!important}`，但**流式光标那组要单独截不禁用的版本**），用 `waitForSelector` 而不是 `sleep`。
- **产物**：`screenshots/web/`（当前设计就是放这里；如果它已被 gitignore 或你刚清空过，先跟用户确认再决定是否纳入版本库）。命名带序号与状态：`01-chat-light.png`、`04-streaming-dark.png`、`20-narrow-390-dark.png`…，并保留一份 `screenshots/web/before/` 与 `after/` 做对照。

## 步骤 3 · 评审 rubric（逐项打分，写下证据）

对每个截图按下面维度找问题，**每条都要有「状态 + 元素 + 现象 + 证据（截图路径/度量值）」**：

- **布局与层级**：信息层级是否清晰（谁是主谁是辅）、栅格是否对齐、留白是否有节奏（间距是否来自一组 token 而非随手魔法数）、出现无意义的双滚动条或横向溢出。
- **排版**：正文字号/行高/字重/字距（正文建议 15–16px、行高 1.6–1.75）、行宽（中文 30–45 字/行）、标题与正文对比、代码字体与正文是否区分、截断省略是否合理。
- **色彩与对比**：文本对比度 ≥ 4.5:1（大字/次要文本 ≥ 3:1）、深色模式是否真的做了（不是把浅色反相）、状态色（成功/警告/危险/进行中）是否一致且语义正确、禁用态是否明显。
- **交互反馈**：hover/active/focus-visible 是否都有、focus ring 是否可见且不丑、按钮/输入/行/卡片的命中区与光标、点击后是否有即时反馈（加载/禁用/骨架）、危险操作是否有二次确认。
- **状态完整性**：空态（无会话/无 bot/无搜索结果/无记忆）、加载态（首 token 前、文件树展开、上传中）、错误态（断连、致命错误、发送被拒）、边界态（超长文本/超长文件名/500 条会话/无权限）。**「没设计空态和错误态」是最常见的问题，重点看。**
- **可访问性**：Tab 顺序是否合理、Esc 关闭弹窗、弹窗是否锁焦点并在关闭后归还、图标按钮是否有 `aria-label`、是否尊重 `prefers-reduced-motion`、颜色之外是否还有非颜色信号。
- **一致性**：同一语义的组件（按钮/输入/卡片/弹窗/标签）在不同面板里是否长得一样；圆角/阴影/边框/间距是否复用同一组值。
- **响应式**：`≤640px` 侧栏隐藏后主区是否可用、触控目标是否够大、横向滚动是否只在代码块/表格这类该滚的地方出现。
- **性能观感**：首屏是否白闪、长列表是否卡、流式追加是否抖动（布局抖动 = 大问题，注意 tool 卡/代码块增长时是否把已读内容顶走）。
- **现实缺陷**：顺手验证一两个交互真缺陷（历史例子：headless 下 `navigator.clipboard` 在非安全上下文拒绝 → `web/src/clipboard.ts` 降级到 `execCommand("copy")`）。这类「真 bug」优先修，比纯审美更值。

## 步骤 4 · 改代码

- 改 `web/src/**` 与 `web/src/styles.css`。**优先做系统性改动**（建立/收敛 spacing、radius、font、color 的 token 变量），而不是到处打补丁。
- 遵守既有约定：不要改协议（`shared/protocol.ts`）、不要改后端行为，除非该问题本身就是后端引起且你能证明。
- 每项改动要能对应到场步骤 3 的某条问题。
- 保留既有功能与快捷键语义（`docs/design/web-client.md`、`README.md` 有约定，如 Esc 取消、悬停复制、`@` 补全、图片 chip 等）。

## 步骤 5 · 回归门槛（必须全绿，贴出输出）

```
pnpm test                  # 全量单测
pnpm typecheck             # tsc --noEmit
pnpm lint                  # biome check .
pnpm build                 # tsup + postbuild + web build（web 内含 tsc --noEmit && vite build）
```

任何一项红了就修到绿；不允许「顺手」跳过或注释测试。

## 交付物

1. `screenshots/web/before/**` 与 `screenshots/web/after/**`：同一批状态、同一视口的对照图。
2. 一份评审报告 `docs-dist/verification/web-ui-visual-review.md`（或按仓库既有目录约定放置），含：状态矩阵（覆盖了哪些状态）、**逐条问题 + 证据 + 修法 + 改后证据**、未修项与原因、剩余风险。
3. 代码改动：`web/src/**`、`web/src/styles.css`（必要时 `web/src/components/*`）。
4. 若修了真 bug，按仓库习惯在 `CHANGELOG.md` 加一行。
5. 结束时打印：`git status --short`（应只含你有意的改动）、四条回归命令的输出摘要、截图文件清单。

## 自证要求（验收点）

- 任何「已修复」的声明，必须同时给出**改前截图 + 改后截图 +（关键处）度量值**。没有证据的断言视为没做。
- 报告里要明确区分：**已用真实渲染验证** vs **仅静态分析** vs **未验证**。
- 如果某个优化会破坏既有取舍（例如为美观增加体积、改动交互语义），**写清代价并给出理由**，别偷偷改。

## 反模式（别做）

- 只读代码就宣称"UI 没问题"，或凭想象写 UI 代码不截图。
- 用 `sleep` 代替等待、截到半渲染的页面还当成 bug。
- 在 headless 里忽略 `hover: none` 导致悬停元素全显，据此"修复"根本不存在的问题。
- 把临时目录、浏览器二进制、node_modules 提交进去。
- 为了让测试过而删/改测试。
- 一次性大重构把 diff 冲到无法 review；应该**分批、可对照**。

先做步骤 0 的环境自检并把结论写出来（哪些能装、哪些不能），再往下走。开始吧。

=== 提示词结束 ===
