# 文件预览 Arena 合成记录

对应：右侧文件树预览（代码/md/json/csv/图片 + docx/xlsx/pptx）。三个候选各自独立实现，同一 rubric 打分，取一个 base 再嫁接。

## 候选

| | 分支 | 机制 | head |
|---|---|---|---|
| C1 | `arena/file-preview-c1` | 客户端 office（`DecompressionStream` + 标签扫描） | `9bc9c8f` |
| C2 | `arena/file-preview-c2` | 服务端 office（`node:zlib` + rels 排序） | `d0f4b0a` |
| C3 | `arena/file-preview-c3` | 服务端 office（两路由，内联字节 + JSON） | `5a393d6` |

三者都零新增运行时依赖，都复用 rail / 既有渲染器，都把「让 agent 读」移到行菜单。

## 交叉评审打分（rubric 5 项，1-5）

| 项 | C1 | C2 | C3 |
|---|---|---|---|
| 1 真实预览 code/md/json/csv/image | 5 | 4 | 4 |
| 2 office 机制可信 + 跑通 xlsx/docx | 3 | 5 | 4 |
| 3 安全（消毒 / 路径 / 上限） | 4 | 5 | 5 |
| 4 依赖与体积 + 许可 + 懒加载 | 4 | 5 | 4 |
| 5 集成（rail / 文件 API / Markdown） | 5 | 4 | 4 |
| **合计** | 21 | **23** | 21 |

## 定基：C2

判据是可复现的缺陷，不是口味：

- C1 的 zip 炸弹防护可绕过：只校验声明的 `uncompressedSize`，随后 `DecompressionStream` 无输出上限；实测 40 KB 容器解出 40 MiB。C2/C3 用 `inflateRawSync({maxOutputLength})` 挡住。
- C1 会把一张 sheet 的名字配到另一张的数据上（`firstSheetName` 与 `firstWorksheet` 排序不一致）。
- C3 的 CSV 读取把任意 `"` 当字段起始，未闭合引号会吞掉整份文件；C3 还 eager 展开整个 zip（60 KB docx 含 20 MB 媒体时 RSS 冲到 193 MB），且把扩展名表在两处语言里各维护一份。

C2 的 office 路径经 `workbook.xml.rels` 排序、按需只解需要的部件（`read(name, maxBytes)`）、zip64 与「声明说谎」的炸弹都拒；`OfficePreview` 以内容分档（`sheet`/`doc`/`slides`），比 C3 以请求格式分档更好扩展；整条路径能从 node 测试经生产 `createApi({fetchImpl})` seam 加 HTTP 测试跑通。

## 嫁接进 C2

- 来自 C3：内联字节路由的 `X-Content-Type-Options: nosniff` 与 CSP（本合成只作了 `nosniff`/CSP 的记录，未落路由）、删除/移动后关闭失效预览、`heading|标题` 的标题样式正则（已落）。
- 来自 C1：高亮体积上限（已落：`MAX_HIGHLIGHT_CHARS = 200_000`，超过退回 `escapeHtml`）。
- 修 C2 自身：图片体积上限此前不可达（`FilePreview` 对 `image` 提前返回，`<img>` 无门），已在渲染处按 `MAX_IMAGE_PREVIEW_BYTES` 拦截（已落）。

## 拒绝

- C1 的整条客户端 office 路径（zip 炸弹 + sheet 错配）。
- C3 的两路由拆分与重复扩展名表；C3 的 eager `readZip`；C3 的 `parseCsv`；C3 让 `Markdown.tsx` 导出 `escapeHtml`/`highlight`（C1/C2 抽到 `web/src/highlight.ts` 更干净）。
- C2 对 `package.json` 构建脚本的改动（`pnpm --filter` → `pnpm -C`）：那是本 worktree 符号链接 `node_modules` 的环境绕行，与功能无关，已还原。
- C2 组件里的裸 `fetch`（绕过 `ApiError` 状态码）——记为后续（本次未改）。

## 验证

- `pnpm test`：141 files / 1252 tests 通过。
- `pnpm typecheck` 干净；`pnpm lint` 通过（仅 C2 引入的 3 条 `noDescendingSpecificity` 警告，非错误）。
- 高亮上限单测：`test/web/highlight.test.ts`。

## 遗留

- C2 组件的裸 `fetch` 未改走 api client；图片仍经 download 路由（`attachment`）由浏览器嗅探，若要更严格可借 C3 的内联路由。
- 三处 `formatBytes`（`images.ts` / `format.ts`）未合并。
- office 只抽文本，样式/公式/图片/合并单元格不进。
