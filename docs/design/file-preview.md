# 文件预览设计：rail 内联预览与 OOXML 文档

目标：在 Web 文件 rail 里点一个文件，直接在浏览器中看到内容。文本与代码高亮显示，Markdown 渲染，JSON 格式化，CSV 表格化，图片直接显示；docx / xlsx / pptx 这类二进制文档走服务端零依赖提取。

## 实现状态

已实现并随本分支提交。

- 服务端 `src/serve/unzip.ts`：只读 ZIP 解析，仅用 `node:zlib`。
- 服务端 `src/serve/office.ts`：从 docx / xlsx / pptx 提取文本与表格，带行列与体积上限。
- 服务端路由 `GET /api/files/preview`：解析路径、检查体积、返回结构化预览（`src/serve/server.ts`）。
- 协议 `shared/protocol.ts`：`OfficePreview` 判别联合与 `FilePreviewResponse`。
- 前端 `web/src/preview.ts`：按扩展名分层、CSV/TSV 解析、二进制嗅探、JSON 格式化，纯函数，便于测试。
- 前端 `web/src/highlight.ts`：抽出 highlight.js 封装，Markdown 渲染器与预览共用。
- 前端 `web/src/components/FilePreview.tsx`：预览弹窗；`FileTree.tsx` 点击文件名打开它，原「让 agent 读」功能移到行菜单。
- 测试：`test/serve/office.test.ts`、`test/serve/files-preview-http.test.ts`、`test/web/preview.test.ts`，并在 `test/web/api.test.ts` 补了 `filePreview` 的请求断言。

## 预览分层

客户端先按文件名判断分层，再决定读取方式。

| 分层 | 扩展名 | 机制 | 上限 |
|---|---|---|---|
| image | png jpg jpeg gif webp svg bmp avif ico | `<img src="/api/files/download?path=...">` 直接交给浏览器 | 客户端 20 MiB，超出只给下载 |
| markdown | md markdown mdx | 复用 `Markdown.tsx`，marked 渲染后 DOMPurify 清洗 | 客户端 1 MiB |
| json | json jsonc json5 | `JSON.parse` 后 `JSON.stringify(_, null, 2)`，highlight.js 上色 | 客户端 1 MiB |
| csv | csv tsv | 客户端解析成行列，React 表格渲染 | 客户端 1 MiB；行列 500 × 40 |
| code | 见 `CODE_LANG` 表 | highlight.js 高亮 | 客户端 1 MiB |
| text | 其它未知扩展名 | UTF-8 解码后纯文本，含 NUL 字节则判为二进制 | 客户端 1 MiB |
| office | docx xlsx xlsm pptx | 服务端零依赖提取，见下节 | 服务端 25 MiB（容器），30 万行等 |
| unsupported | zip pdf 音视频字体等 | 不请求，直接提示下载 | 无 |

体积上限用目录列表已经给出的 `FileEntry.size` 判断，所以超限文件根本不会发起请求。未知扩展名会先读字节再用前 8192 字节里是否有 NUL 来嗅探。

## 复用的现有实现

| 能力 | 现有实现 | 预览里的用途 |
|---|---|---|
| 路径约束 | `resolveInWorkspace` / `statPath` | 所有文件路径必须先解析进工作区，越界 400 |
| 字节读取 | `GET /api/files/download` | 文本与图片的字节来源，浏览器 `fetch` 忽略其 `attachment` 头 |
| Markdown | `web/src/components/Markdown.tsx` | md / markdown 直接渲染，沿用 DOMPurify 与复制按钮 |
| 代码高亮 | `web/src/highlight.ts`（原在 Markdown 内） | 代码与 JSON 共用同一个 highlight.js 实例 |
| 弹窗样式 | `.modal` `.modal-backdrop` 等 token | 预览对话框与「移动到」共用 |

## 服务端 OOXML 提取

### 为什么放服务端

docx / xlsx / pptx 都是 ZIP 容器，里面是 XML。放服务端有三个理由。第一，服务端已有路径约束和体积控制，不需要把不可信的压缩包交给浏览器解析。第二，不需要给前端加体积，零依赖路径甚至没有前端解析器。第三，提取结果是纯文本与单元格，只有数据跨边界，渲染仍由 React 转义。

被否掉的两个前端方案见「被否决方案」。

### ZIP 解析（`src/serve/unzip.ts`）

只读，够用即可。定位中央目录（从尾部回扫 EOCD 签名），逐个读成员的方法、压缩后大小、解压后大小与本地头偏移。方法 0（store）直接切片，方法 8（deflate）用 `zlib.inflateRawSync`。拒绝 zip64（`0xffffffff` / `0xffff` 哨兵），因为预览的文件远小于 4 GiB。目录成员跳过，不解析数据描述符之外的结构。

### XML 文本提取（`src/serve/office.ts`）

不引入 XML 解析器，用正则取出已知标签的文本，再解码实体。三类文档各有一套小函数。

- xlsx：读 `xl/workbook.xml` 与 `xl/_rels/workbook.xml.rels` 得到按序的工作表，读 `xl/sharedStrings.xml` 得到共享字符串。单元格的列由 `r` 属性（如 `C7`）决定，稀疏单元格不会错位。`t="s"` 查共享字符串，`t="inlineStr"` 取内联文本，`t="b"` 变 TRUE / FALSE，其余按数值文本。缺 workbook 时回退到 `xl/worksheets/sheet*.xml` 的数字序。
- docx：读 `word/document.xml`，按 `<w:p>` 切段。`w:pStyle` 映射为 h1 至 h6、li、p；文本来自 `<w:t>`，`<w:tab/>` 与 `<w:br/>` 转成制表符与换行。空段丢弃。
- pptx：读 `ppt/slides/slide*.xml`，取 `<a:t>` 文本。首个文本当标题，其余当正文行。这是近似，未按占位符类型判断。

### 路由（`GET /api/files/preview`）

流程与下载路由同构。`statPath` 解析并分类路径，越界 400、缺失 404、目录 400；非 office 扩展名 400；容器大于 25 MiB 返回 413；否则 `readFile` 后交 `previewOffice`，返回 `{ path, preview }`。`ZipReadError` 归为 400 并带上原因。

## 依赖与体积

零新运行时依赖。ZIP 用 `node:zlib`（Node 内置），XML 抽取是本地正则。前端高亮复用已存在的 `highlight.js`，Markdown 复用 `marked` 与 `dompurify`，三者本来就随首屏加载，本特性不增加它们的体积。

考虑过但未采用的解析器，数据来自 npm registry 元数据（`dist.unpackedSize`，仅作量级参考，非打包后体积）。

| 包 | 用途 | 许可证 | 解包体积 |
|---|---|---|---|
| `xlsx`（SheetJS CE） | 读写 xlsx | Apache-2.0 | 约 7.5 MB / 26 文件 |
| `mammoth` | docx 转 HTML | BSD-2-Clause | 约 1.7 MB / 119 文件 |
| `docx-preview` | docx 渲染 | Apache-2.0 | 约 1.0 MB / 12 文件 |
| `jszip` | 通用 ZIP | MIT 或 GPL-3.0-or-later | 约 0.7 MB / 53 文件 |
| `fflate` | 通用 ZIP | MIT | 约 0.8 MB / 17 文件 |
| `pdfjs-dist` | PDF 渲染 | Apache-2.0 | 大，若做 PDF 再评估 |

现有前端依赖的许可证一并记录。`highlight.js` 为 BSD-3-Clause，`marked` 为 MIT，`dompurify` 为 MPL-2.0 或 Apache-2.0，`react` 与 `react-dom` 为 MIT。

### 懒加载

当前零依赖路径没有前端解析器，所以没有懒加载点。若以后为更完整的保真度引入 `mammoth` 或 `docx-preview`，必须用动态 `import()` 在用户点开 docx 时再加载，不能让它们进首屏包。同理 `xlsx` 或 `pdfjs-dist`。准则：重型解析器一律动态导入，并且只在对应分层被点击时加载。

## 安全

- 路径约束。所有读取先过 `statPath`（内部是 `resolveInWorkspace`），`..`、绝对路径与指向工作区外的符号链接都被拒绝。
- 体积上限。整容器 25 MiB（413），单个 ZIP 成员 32 MiB，`inflateRawSync` 还带 `maxOutputLength`，所以「声明小、解压爆炸」的 zip 炸弹在 inflate 时就被拒。声明的解压大小超过上限会在 inflate 之前直接抛错。
- 无 XXE。不引入 XML 解析器，只做正则取文本，实体只解码五个预定义实体与数字引用，任何 DTD 或外部实体都不会被解析。
- 不产生 HTML。服务端只返回文本与单元格数组，docx 里的 `<script>` 只会以文本出现，测试 `returns markup-looking text as text` 固定了这一点。
- 前端转义。表格与文档块都用 React 元素渲染，天然转义。代码与 JSON 用 highlight.js 输出后再过 DOMPurify，和 Markdown 渲染器同一套防线。
- SVG 用 `<img>` 加载，不用内联 `dangerouslySetInnerHTML`，所以 SVG 里的脚本不会执行。
- 只读。预览路由不写盘，不需要 `recursive` 或确认弹窗。

## 已知限制

- pptx 的标题是首段启发式，未解析占位符。
- 不计算公式结果，xlsx 只显示单元格里的缓存值。
- 不渲染图片、图表、批注、样式与公式编辑器。
- 加密或受保护的 OOXML 容器是别的格式，会以 `ZipReadError` 收场并返回 400。
- 不支持 zip64。
- 首屏包仍偏大，构建有一条 chunk 体积警告，与本特性无关；若要修，走 `manualChunks`。

## 被否决方案

| 方案 | 为什么否掉 |
|---|---|
| 前端 `xlsx`（SheetJS）解析 xlsx | 解包体积大且需动态导入；Apache-2.0 可接受，但零依赖服务端路径更省 |
| 前端 `mammoth` 把 docx 转 HTML | 转出的 HTML 要在客户端再清洗一遍，跨边界的不可信 HTML 风险更大；BSD-2-Clause |
| 前端 `docx-preview` | 体积大，样式复杂，仍要处理不可信输入 |
| 通用 ZIP 库（jszip / fflate） | 只为读少量成员，`node:zlib` 已够，不值得加依赖 |
| 新增服务端「原样内联」路由（改 Content-Type 为 inline） | 需要新的 MIME 判定与 `Content-Security-Policy` 考量；复用下载路由做字节来源更小 |
| 内联渲染 SVG | 脚本会执行；`<img>` 已足够显示 |

## 验证

- `pnpm test`：新增 `office.test.ts` 用内存里构造的 zip 覆盖 xlsx 稀疏单元格、行列上限、docx 样式映射与「标记文本仍是文本」、pptx 标题、zip 炸弹与非法 zip；`files-preview-http.test.ts` 覆盖路由的 200/400/404 与损坏容器；`preview.test.ts` 覆盖分层、CSV 引号与上限、二进制嗅探、JSON 格式化。
- `pnpm typecheck`、`pnpm lint`、`pnpm web:build` 通过。

## 未决问题

- 是否把客户端 1 MiB 的文本上限与服务端 25 MiB 的容器上限做成可配置项。
- docx 的表格目前按段落拍平，是否要保留 `<w:tbl>` 结构。
- 是否给 pptx 解析占位符以获得更准的标题。

