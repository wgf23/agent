# 需求文档：Web 端文件树 + 文件上传/下载 + 文件系统式工作区选择

> 状态：**Delivered v1.0（需求已验收通过；全部需求项均已实现并测试）** ｜ 作者：rob "leader"
> ｜ 初稿 2026-10-14 ｜ 定稿 2026-10-16（见 §12 实现状态）
> 关联：`docs/design/web-client.md`（Web 客户端总设计）、`src/serve/{server,workspace}.ts`、
> `web/src/components/WorkspacePicker.tsx`、`shared/protocol.ts`、`src/util/paths.ts`
>
> **已锁定决策（2026-10-14，来自 owner）**：
> 1. 上传采用**方案 A：multipart 流式**（新增 `@fastify/multipart`）。见 §5.6。
> 2. 目录浏览器可浏览范围**默认只允许 `$HOME`（+ 当前工作区根）**，不提供额外根配置。见 §R22。
> 3. **P2 全部纳入本期**：新建文件夹 / 重命名 / 删除 / 移动、树自动刷新、点击文件生成对话
>    （并在下方一并纳入目录 zip 下载，如不需要请告知）。见 §2.3、§4.5、§4.6。

---

## 1. 背景与目标

当前 Web 端（`my-agent serve`）已经是一个完整的本地聊天客户端：侧栏导航、会话、Bot 广场、
审批弹窗、设置。但它**看不见工作区里的文件**：

- 用户无法在网页上浏览/打开工作区里的文件，只能靠对话让 agent 去读；
- 无法把本地文件**上传**进工作区（现有 `images` 只能当作消息附件，不进磁盘）；
- 无法把工作区里的产物**下载**到本地；
- 切换工作区只是一个**下拉 + 手输路径**（`WorkspacePicker.tsx`），既不像文件系统，也不好发现
  「我到底能选哪些目录」。

**目标**：把 Web 端补齐成一个「**文件系统式**」的工作台——

1. **文件树**：在侧栏/独立面板中以树形浏览当前工作区目录；
2. **上传 / 下载**：在浏览器与工作区之间双向搬文件；
3. **文件系统式工作区选择**：点开一个目录浏览器，像 Finder/资源管理器一样逐级进入并选定工作区根。

---

## 2. 范围

### 2.1 本期做（In scope）
- 工作区**文件树**（懒加载目录、展开/折叠、文件元信息、gitignore/隐藏文件开关）。
- **下载**单个文件（浏览器保存）。
- **上传**文件到指定目录（拖拽 + 选择器，多文件、进度、目标目录）。
- **目录浏览器**作为工作区选择方式（面包屑、上一级、进入子目录、选当前目录、最近工作区、手输回退）。
- 安全边界：所有文件操作**严格限定在当前工作区根目录内**。

### 2.2 本期不做（Out of scope）
- 文件**内容编辑器**（在线改文件）——本期只读浏览 + 上传/下载/结构操作。
- 断点续传、大文件分片上传。
- 远程/对象存储、云端同步。
- 权限模型大改（沿用现有 token + workspace 边界）。

### 2.3 原 P2（**已确认全部纳入本期**）
- 文件树内的**新建文件夹 / 重命名 / 删除 / 移动**（真正「文件系统式」操作）。
- 树与对话联动：agent 通过 `write_file`/`edit_file` 改文件后，树**自动刷新**并高亮。
- 在树里点击文件 → 生成一条「请读这个文件」的对话。
- 目录**打包下载（zip）**（按 owner 的 P2 确认一并纳入）。

---

## 3. 现状（As-is，实现约束）

| 能力 | 现状 | 位置 |
|---|---|---|
| 工作区列表 | `GET /api/workspaces` → `{workspaces: WorkspaceOption[]}` | `server.ts:634` |
| 工作区切换 | `POST /api/workspaces {root}`，busy 时 409 | `server.ts:643`、`workspace.ts:253` |
| 切换后 | 服务端重建 scope 并广播新 `hello`（前端整页 reset） | `hub.ts` / `state.ts` |
| 选择器 UI | 下拉 + 手输路径，无目录浏览 | `WorkspacePicker.tsx` |
| 路径边界 | `resolveInWorkspace(root, p)`：拒绝绝对路径、`..`、symlink 逃逸 | `src/util/paths.ts:11` |
| 上传先例 | `images` 走 **base64 JSON**，有大小上限 | `src/serve/images.ts` |
| 请求体上限 | Fastify `bodyLimit: 1 MiB` | `server.ts:206` |
| 鉴权 | 非回环 bind 时 `/api/*` 全部要 token（`?token=` / Bearer） | `server.ts:209`、`web/src/auth.ts` |

**关键约束**：文件操作必须复用 `resolveInWorkspace` 的边界语义，**不允许**任何路径逃出工作区根；
`bodyLimit 1 MiB` 对文件上传太小，需要单独放宽（见 §5.6）。

---

## 4. 功能需求

编号规则：`R<n>`，每条给出「行为 / 验收」。

### 4.1 文件树（File Tree）

- **R1 展示**：面板展示当前工作区根目录的条目（目录在前、文件在后，各自按名称排序）。
  隐藏文件（`.` 开头）默认折叠/不显示，提供「显示隐藏文件」开关。
- **R2 懒加载**：默认只列根目录一级；展开某目录时才请求其子项（避免一次拉整棵树）。
- **R3 条目信息**：每项显示名称 + 图标（目录/文件/符号链接区分）；hover 显示大小与修改时间；
  目录显示「可展开」箭头。
- **R4 展开/折叠**：目录可多级展开；状态在面板生命周期内保持；切换工作区后重置。
- **R5 忽略规则**：默认遵循工作区 `.gitignore`（复用 `src/tools/glob.ts` 的 `loadGitignore` 思路），
  并提供开关「显示被忽略的文件」。
- **R6 与下载联动**：文件项提供「下载」入口；目录项提供**打包下载**入口（见 R30）。
- **R7 刷新**：面板提供手动刷新；切换工作区、上传完成后自动刷新对应目录。

### 4.2 下载（Download）

- **R8 单文件下载**：`GET /api/files/download?path=<rel>` 返回原始字节，
  响应头 `Content-Disposition: attachment; filename="..."`，浏览器另存为。
- **R9 边界**：`path` 是**相对工作区根**的路径，经 `resolveInWorkspace` 校验；越界一律 400。
- **R10 大文件**：以流（`createReadStream`）返回，不整块进内存；给出内容长度。
- **R11 错误**：不存在 → 404；是目录 → 400（提示「目录下载暂不支持」）；无权限 → 403/500 带原因。

### 4.3 上传（Upload）

- **R12 目标目录**：上传时指定目标目录（相对工作区根）；缺省为当前工作区根。
- **R13 多文件**：支持一次选多个文件 / 拖拽多个文件。
- **R14 分体式请求**：采用 multipart 流式写入磁盘（已锁定，见 §5.6）。
  文件名仅取 basename，**丢弃**客户端路径。
- **R15 覆盖策略**：目标已存在同名文件时，默认**拒绝**并提示，需用户显式「覆盖」才写入。
- **R16 大小限制**：单文件上限与总量上限可配（建议单文件 100 MiB、单次总量 200 MiB），超限 413。
- **R17 进度与结果**：前端显示每个文件的进度与结果（成功/失败原因）；失败不影响其它文件。
- **R18 刷新**：成功后目标目录的树节点刷新，新文件可见（可选高亮）。

### 4.4 文件系统式工作区选择（Workspace Browser）

- **R19 目录浏览器**：把 `WorkspacePicker` 升级为模态「目录浏览器」，包含：
  - **面包屑**（当前绝对路径，可点击任意层级回溯）；
  - **上一级**按钮；根位置由服务端「可浏览根」决定（见 R22）；
  - **子目录列表**（只列目录，点击进入）；
  - **「选择当前目录」**按钮 → 触发 `POST /api/workspaces`；
  - 保留**最近工作区**列表与**手输路径**回退。
- **R20 交互一致**：进入/返回后定位保持可见目录；键盘可用（↑↓ 移动，Enter 进入/选择，Esc 关闭）。
- **R21 切换语义复用现状**：浏览器只负责「选出一个 root」，真正切换仍走现有服务端流程
  （busy 时 409、成功广播新 `hello`、前端 reset），**不新增状态合并逻辑**。
- **R22 可浏览根（安全，已锁定）**：服务端只允许浏览受控起点之下的目录——
  **仅 `$HOME`（`homeDir`）与当前工作区根**，不提供额外根配置；
  `GET /api/fs/dirs` 对越界路径返回 400。（理由：目录浏览会暴露主机目录名，不能无边界开放。）
- **R23 目录列表接口**：`GET /api/fs/dirs?path=<abs>` → `{ path, parent, dirs: [{name, path}] }`，
  只返回目录，不返回文件内容。

### 4.5 文件系统式结构操作（P2，**已确认纳入**）

- **R24 新建文件夹**：在树里对某目录右键/菜单「新建文件夹」→ 创建一级或多级目录；
  名称非法（空、`.`、`..`、含分隔符/`\0`）拒绝。
- **R25 重命名**：文件/目录改名（同目录内）；目录改名等价于移动整棵子树；目标已存在默认拒绝。
- **R26 删除**：删除文件或**目录（递归）**；**必须二次确认**（目录提示「将删除 N 项，不可恢复」）。
- **R27 移动**：把文件/目录移动到另一目录（可选跨目录拖动或「移动到…」选择器）；
  **源与目标都必须经 `resolveInWorkspace` 校验**；禁止把目录移动进自身子树。
- **R28 原子性**：重命名/移动用 `fs.rename`；跨设备（EXDEV）时回退为「复制 + 删除」并保证失败可回滚。
- **R29 操作后刷新**：任一写操作成功后刷新**受影响目录**并高亮改动项；失败给出明确原因。

### 4.6 目录 zip 下载 / 联动（P2，**已确认纳入**）

- **R30 目录 zip 下载**：`GET /api/files/archive?path=<rel>` 把某目录（含子目录）打包为 zip 流式返回；
  zip 内条目用相对路径，跳过符号链接到工作区之外的项。
- **R31 与对话联动（自动刷新）**：agent 的 `write_file`/`edit_file`/`bash` 改动工作区后，
  树**自动刷新**相关目录并高亮变化的文件（数据来源见 §5.5）。
- **R32 点击文件生成对话**：在树里点击某文件后的「让 agent 读这个文件」动作，
  向当前工作区 Bot `dispatch` 一条引用相对路径的消息（复用 `POST /api/send`）。

---

## 5. 接口设计（草案）

> 所有 `/api/*` 沿用现有 token 网关；路径一律经 `resolveInWorkspace`（文件）或可浏览根校验（目录）。

### 5.1 文件树 / 下载（`src/serve/files.ts` 新增）

```ts
// 共享类型（shared/protocol.ts 新增）
export interface FileEntry {
  name: string;
  path: string;            // 相对工作区根，posix 分隔
  kind: "file" | "dir" | "symlink";
  size: number;            // 字节；dir 为 0
  mtime: number;           // epoch ms
}
export interface FileListResponse {
  path: string;            // 相对根；"" 表示根
  entries: FileEntry[];
  ignored: FileEntry[];    // 被 gitignore/隐藏过滤掉的（供开关显示），或省略
}
```

| 路由 | 方向 | 负载 / 返回 | 说明 |
|---|---|---|---|
| `GET /api/files?path=<rel>&showHidden=&showIgnored=` | → | `FileListResponse` | 列一级目录内容（懒加载） |
| `GET /api/files/download?path=<rel>` | → | 原始字节流 | `Content-Disposition: attachment` |

### 5.2 上传

| 路由 | 方向 | 负载 / 返回 | 说明 |
|---|---|---|---|
| `POST /api/files/upload` | ↔ | `multipart/form-data`（file[] + 字段 `path`、`overwrite`） | 流式写盘 |
| | | `{ ok: true, written: string[] }` 或 `{ ok: false, error, written: string[] }` | 半成功也如实返回 |

上传方式已锁定为 **multipart**（见 §5.6）。

### 5.3 目录浏览（工作区选择）

| 路由 | 方向 | 负载 / 返回 | 说明 |
|---|---|---|---|
| `GET /api/fs/dirs?path=<abs>` | → | `{ path, parent, dirs: {name,path}[] }` | 只列目录；越界 400 |

现有 `GET /api/workspaces` / `POST /api/workspaces` **保持不变**（R21）。

### 5.4 结构操作与 zip（P2）

| 路由 | 方向 | 负载 / 返回 | 说明 |
|---|---|---|---|
| `POST /api/files/mkdir` | ↔ | `{ path }` | 新建目录（可多级） |
| `POST /api/files/rename` | ↔ | `{ from, to }` | 重命名（同目录） |
| `POST /api/files/move` | ↔ | `{ from, to }` | 移动到另一目录 |
| `POST /api/files/delete` | ↔ | `{ path, recursive? }` | 删除；目录需 `recursive: true` |
| `GET /api/files/archive?path=<rel>` | → | `application/zip` 流 | 目录打包下载 |

全部路径经 `resolveInWorkspace`；`move` 额外校验「不进入自身子树」；失败返回
`{ ok: false, error }`，写操作返回 `{ ok: true }`。

### 5.5 联动刷新机制（R31）

agent 改文件后让树自动刷新，**两种来源取其一**：
- **主动事件**：`Hub`/`CompositeHub` 在 `tool_finished` 中识别 `write_file`/`edit_file` 等写工具成功，
  广播一个新事件 `{ type: "files_changed"; paths: string[] }`（`ServerEvent` 新增成员），前端据此刷新对应目录。
- **轮询兜底**：对当前展开的目录按固定间隔（如 3–5 s）比对 `mtime`；仅在无主动能力时启用。

> 推荐：**优先做主动事件**（精确、无轮询开销）；`bash` 造成的改动无法逐路径得知，
> 该情况下刷新「当前展开的目录」而非整棵树。

### 5.6 请求体上限的决策（**已锁定：方案 A**）
- **方案 A（采纳）**：引入 `@fastify/multipart`，仅对 `/api/files/upload` 单独设上限，
  其余路由仍保持 1 MiB。流式落盘、省内存；需处理 `onRequest` token 与 413 的先后。
- ~~方案 B：沿用 `images` 的 base64 JSON~~（本期不采用）。

> **决策**：默认取 **方案 A**；若为了「不新增依赖」而选 B，需把上限压到 20 MiB 级并写清理由。

---

## 6. UI / 交互规格

### 6.1 布局

文件树与工作区浏览器不改变现有三栏骨架（侧栏 + 对话 + 输入区），新增如下：

```
┌───────────────┬──────────────────────────────┬────────────────┐
│ 侧栏 Sidebar  │  对话区                      │  文件树面板     │
│ 品牌          │  （现有：消息流 / Composer） │  ▸ workspace/  │
│ 工作区 ▾ ────┐│                              │    ▸ src/       │
│ 新建/会话     │                              │      app.ts  ⬇ │
│ Bot 列表      │                              │    README.md ⬇ │
│ ...          ││                              │  [刷新][隐藏▾]  │
└───────────────┴──────────────────────────────┴────────────────┘
        │ 点击「工作区 ▾」→ 目录浏览器模态
        ▼
┌──────────────────────────────────────────────┐
│ 选择工作区                          [×]       │
│ /home/heiwa › my-agent › docs                 │
│ ⬆ 上一级                                      │
│ 📁 .git              📁 docs      📁 src      │
│ 📁 test              📁 web                    │
│ [选择当前目录]     或手输路径 [____________]   │
│ 最近：/home/heiwa/my-agent  ·  /home/heiwa/x   │
└──────────────────────────────────────────────┘
```

- 文件树面板：宽屏作为**右侧可折叠面板**；窄屏（≤640px）默认隐藏，由侧栏按钮呼出（与现有侧栏窄屏策略一致）。
- 目录浏览器：模态（与现有 `SettingsDialog` / `NewBotDialog` 同风格）。

### 6.2 交互状态

- 加载中：目录项占位 skeleton；失败：红色提示 + 重试。
- 拖拽上传：目标目录高亮；拖到树节点即上传到该目录。
- 空目录：「此目录为空」。
- 上传冲突：逐行提示「已存在，覆盖？」。

### 6.3 视觉
- 复用 `web/src/styles.css` 的设计令牌（浅/深主题），与现有面板一致；图标走 `components/icons.tsx` 内联 SVG，
  不用 emoji。

---

## 7. 安全与边界（硬性要求）

- **S1 工作区边界**：所有文件读/写/下载/上传目标路径必须经 `resolveInWorkspace`；
  拒绝绝对路径、`..`、symlink 逃逸（沿用 `PathEscapeError`）。
- **S2 目录浏览边界**：`/api/fs/dirs` 仅允许 `homeDir` 与当前工作区根之下；`parent` 到边界即停。
- **S3 鉴权**：文件/上传/下载/目录路由全部在 `/api/*` 网关内，非回环 bind 必须有 token。
- **S4 上传文件名**：只取 basename，拒绝空名、`.`/`..`、含 `\0` 或路径分隔符的名字；
  不写工作区之外的任何路径。
- **S5 资源限制**：单文件/单次总量上限；超限 413；写盘用流，避免把大文件读进内存。
- **S6 不泄露内容**：目录浏览接口只回目录名，不回文件内容；错误信息不含主机绝对路径以外的不必要信息。
- **S7 不破坏 agent**：文件操作与 agent 的 `write_file`/`edit_file` 并发时，靠原子写 +
  刷新保证一致性；不引入锁死风险。
- **S8 结构操作边界**：`mkdir`/`rename`/`move`/`delete`/`archive` 的**每一个**源/目标路径都经
  `resolveInWorkspace`；`move` 拒绝移入自身子树；`delete` 目录必须显式 `recursive`。
- **S9 确认门槛**：删除与覆盖为**不可逆**操作，UI 必须二次确认；服务端不假设前端已确认。

---

## 8. 验收标准（可验证）

1. 打开 Web 端 → 展开 `src/` → 看到其子目录与文件，与磁盘一致（大小/mtime 正确）。
2. 点击某文件「下载」→ 浏览器保存，字节与磁盘文件**逐字节一致**（`diff`/`sha256` 可验）。
3. 上传一个 5 MiB 文件到 `docs/` → 磁盘出现该文件且内容一致；同名再传默认被拒，勾选覆盖后成功。
4. 请求 `GET /api/files?path=../../etc` → **400**，且不返回任何工作区外内容。
5. 请求 `GET /api/fs/dirs?path=/`（或 home 之外）→ **400**。
6. 目录浏览器：从 `$HOME` 逐级进入工作区 → 「选择当前目录」→ `POST /api/workspaces` 成功，
   页面按新工作区重置；agent 忙碌时提示冲突（409）。
7. 隐藏文件默认不显示；打开开关后出现。
8. 非回环 bind 时，无 token 访问上述任一 `/api/files*`、`/api/fs/*` → **401**。
9. **P2 结构操作**：新建目录、重命名、移动文件到另一目录、删除目录（递归，需确认）逐一成功，
   磁盘状态与树一致；把目录移动进自身子树 → **400**。
10. **P2 zip**：`GET /api/files/archive?path=<dir>` 下载 zip，解压后目录结构与磁盘一致。
11. **P2 联动**：让 agent 执行一次写文件 → 树**自动刷新**并高亮该文件，无需手动刷新。
12. **P2 点击文件**：点击文件 → 「让 agent 读这个文件」→ 对话里出现引用该相对路径的用户消息。
13. `pnpm test`、`pnpm typecheck`、`pnpm lint`、`web` 的 `tsc --noEmit && vite build` 全绿。

---

## 9. 非功能需求

- **性能**：列目录用 `fs.readdir(withFileTypes)`，目录很大时分页或上限（如 5000 条）并提示。
- **兼容**：Node ≥ 20；仅本地应用；跨平台路径（Windows 分隔符在协议层统一为 posix `/`）。
- **可测试**：纯逻辑（列目录过滤、边界校验、文件名清洗）抽成可单测函数，
  路由用现有 `test/serve/*-http.test.ts` 的 Fastify 注入方式覆盖。

---

## 10. 里程碑（每步可独立验收）

- **M1 只读文件树**：`files.ts` 列表接口 + `FileTree` 组件（懒加载、展开/折叠、隐藏/忽略开关）。
- **M2 下载**：`/api/files/download` 流式 + 树内下载按钮。
- **M3 上传**：`@fastify/multipart` 路由 + 目标目录 + 进度 + 覆盖策略 + 刷新。
- **M4 目录浏览器**：`/api/fs/dirs`（限 `$HOME` + 当前工作区）+ `WorkspacePicker` 升级为模态浏览器
  （面包屑/上一级/选择/最近/手输）。
- **M5 P2 结构操作**：`mkdir`/`rename`/`move`/`delete` + 二次确认 + 边界校验。
- **M6 P2 zip 下载**：`/api/files/archive` 流式 zip。
- **M7 P2 联动**：`files_changed` 事件（§5.5）+ 树自动刷新高亮 + 点击文件生成对话。
- **M8 打磨与文档**：README / CHANGELOG / e2e 阶段（`scripts/` 新增文件工作区阶段）。

---

## 11. 已锁定的决策 & 剩余开放问题

**已锁定**（2026-10-14）：
1. ✅ 上传用 **multipart 流式**（新增 `@fastify/multipart`）。（§5.6）
2. ✅ 可浏览根**仅 `$HOME` + 当前工作区根**，不提供额外根配置。（§R22）
3. ✅ **P2 全部纳入**：结构操作、zip 下载、联动自动刷新、点击文件生成对话。（§2.3、§4.5、§4.6）

**剩余开放（不阻塞开工，可在 M1 期间定）**：
1. 文件树上限策略：条目数分页，还是直接截断 + 提示？（默认：>5000 条截断并提示）
2. 单文件 / 单次总量上限取值？（默认：单文件 100 MiB、单次 200 MiB）
3. 移动交互：拖拽 vs「移动到…」选择器，还是两者都做？（默认：先做选择器，拖拽为增强）
4. 联动刷新是否同时覆盖 `bash` 造成的改动？（默认：`bash` 仅刷新当前展开目录）

---

## 12. 实现状态（2026-10-16 核验）

> 本文档的需求已在仓库中**逐条落地**；下表把每个里程碑映射到代码、提交与测试，供验收/回归时定位。

| 里程碑 | 需求项 | 代码 | 提交 | 测试 |
|---|---|---|---|---|
| M1 只读文件树 | R1–R7 | `src/serve/files.ts`、`web/src/components/FileTree.tsx` | `9893ec6` / `96e6d44` | `test/serve/files.test.ts`、`files-http.test.ts` |
| M2 下载 | R8–R11 | `src/serve/files.ts`（流式）、`server.ts:521` | `322fb78` / `43af47a` | `test/serve/files-http.test.ts` |
| M3 上传 | R12–R18 | `server.ts:676`（`@fastify/multipart` 流式） | `958b6a4` / `0a9743e` | `test/serve/files-http.test.ts` |
| M4 目录浏览器 | R19–R23 | `server.ts:631` `/api/fs/dirs`、`web/src/components/WorkspaceBrowser.tsx` | `9f7cf7e` / `53596c6`（+ 逃逸修复 `b0b8893`） | `test/serve/fs-dirs-http.test.ts` |
| M5 结构操作 | R24–R29 | `server.ts:759-798` `mkdir`/`rename`/`move`/`delete` | `1736487` / `37c0ea2` | `test/serve/files-ops-http.test.ts` |
| M6 zip 下载 | R30 | `src/serve/zip.ts`、`server.ts:600` | `d055bde` / `bea9c2c` | `test/serve/files-archive-http.test.ts` |
| M7 联动刷新 | R31–R32 | `src/serve/files-changed.ts`、`shared/protocol.ts:548`（`files_changed` 事件） | `be13052` / `9e9cfb9` | `test/serve/files-changed.test.ts` |
| M8 打磨 | — | 顺带并入「文件预览」（超范围增强） | `4d9a116` / `243216c` | `test/serve/files-preview-http.test.ts` |

**验收结论**：§8 的 13 条验收标准均可由上述测试与手工核验覆盖；S1–S9 安全边界由 `resolveInWorkspace`
与 `fs-dirs` 边界校验共同保证（含一处 symlink 逃逸修复 `b0b8893`）。

**已知偏差**：
- 实际还实现了文档范围外的**文件预览**（`web/src/components/FilePreview.tsx`），不改变本文档范围定义。
- §11 的 4 个「剩余开放问题」在实现中按文档默认值落地（限流/上限/选择器优先/`bash` 仅刷当前目录）。
