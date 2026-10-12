# Skills arena：npm 可安装的 skills

关于如何选择和集成 skills 候选的一页说明。arena 从同一基线提交 `f028cdb` 跑了两个候选。两者都是单提交分支，各带一份 `RATIONALE.md`。

## 基线：candidate 1

基线是 candidate 1（`arena/skills-c1`，提交 `ae293c4`）。跨模型判定给它 20 分对 18 分，并给出三条理由。

- **失败回滚**。`addSkill` 对 npm 前后做前缀 `node_modules` 差异比较，撤销本次调用新增的内容，所以校验失败时已安装集合保持不变。
- **全局测试隔离**。`test/setup.ts` 为每个测试文件把 `MY_AGENT_SKILLS_DIR` 指向临时目录，因此调用 `runAgent` 的既有测试永远不会读到真实的 home 前缀。candidate 2 只在它自己的 skills 测试里设置该覆盖。
- **字面断言**。candidate 1 断言精确值（`toEqual`、精确输出字符串），candidate 2 断言 `toContain`，所以格式化或消息坏掉时前者仍会失败。

## 集成时的漂移

一个无关功能，交互式 API key 设置，在分叉点之后作为 `5eff18b` 落地。它改动了 `src/index.ts`、`README.md`、`PLAN.md` 和 `CHANGELOG.md`。这四个文件里 candidate 1 只改了 `src/index.ts` 和 `README.md`。cherry-pick 只在 `src/index.ts` 冲突；`README.md` 自动合并。

两个功能都保留。`src/index.ts` 保留 `setup` 命令并新增 `skill` 命令。`README.md` 保留 Credentials 章节并新增 Skills 章节。`PLAN.md` 和 `CHANGELOG.md` 来自设置功能，原样保留。

## 移植

移植落在 candidate 1 基线上，提交 `1080860`。

| 移植 | 来源 | 改动 |
| --- | --- | --- |
| a | candidate 2 | npm argv 加固。install 和 uninstall 把标志放在 `--` 之前，把 spec 或包名放在其后，npm 就不会把标志当成包 spec。 |
| b | candidate 2 | 在 `discover.ts` 和 `tool.ts` 里复用 `src/util/paths.ts` 的 `resolveInWorkspace`。删除 `src/skills/paths.ts` 里重复的守卫 `resolveInside` 和 `SkillPathError`，保留 `skillsRoot()`。工具保留它早期的 skill 名模式拒绝。 |
| c | 判定 | 回滚正确性。只撤销本次调用新增的包目录。重新添加一个已存在的包失败时不删除也不卸载任何东西。 |
| d | candidate 2 | 发现韧性。当 `node_modules` 因 `ENOENT` 之外的原因无法读取时，`discoverSkills` 返回 `[]`。可读包里的非法 skill 仍被静默跳过。 |
| e | candidate 2 | 对齐的列表输出。在 `src/cli/skill.ts` 导出纯函数 `formatSkillList(skills)`，列为 name、package、version、description、path。candidate 1 的 add 和 remove 状态消息保留。 |

## 拒绝：candidate 2

candidate 2 不作为基线，只取上面命名的移植。

- **既有测试没有隔离**。它的 skills 测试设置了 `MY_AGENT_SKILLS_DIR`，但一个通过 `runAgent` 到达 `discoverSkills` 的既有测试会读到真实的 home 前缀。
- **重新添加时误报失败**。它通过差异比较前缀 `package.json` 的依赖来识别请求的包。一次不改变任何依赖键的重新添加会报 `did not add a package`，而不是重新校验已经存在的包。
- **校验失败后的传递残留**。它的回滚卸载那一个直接依赖，但被提升进前缀的传递依赖会留下。

## 跨模型判定

candidate 1 得 20 分，candidate 2 得 18 分。判定推荐 candidate 1 作基线，理由是失败回滚、全局测试隔离和字面断言。

## 掉队

无。两个候选都构建成功并报告了完整的命令运行。

## 验证

在移植后的 master 上运行，位于提交 `1080860`。

- `pnpm typecheck` 通过。`tsc --noEmit`，退出码 0。
- `pnpm lint` 通过。`biome check .`，137 个文件，无修改，退出码 0。
- `pnpm test` 通过。51 个测试文件，333 个测试，退出码 0。
- `pnpm build` 通过。`dist/index.js` 171.81 KB，退出码 0。

构建之后接着在 `MY_AGENT_SKILLS_DIR` 下做了一次真实 CLI 验证，记录在集成报告里。非法 fixture 报出它的包名并保持列表不变；合法 fixture 通过 add、list、remove 往返。
