# 研发全流程 Bot 团队

在 `my-agent.json` 的 `robs` 里定义了一支覆盖研发全流程的团队，并用一个 `rooms` 把它们串成流水线。每个 bot 都是独立 agent，有自己的角色、权限和会话历史。

## 成员

| bot | 阶段 | 职责 | 关键权限 |
| --- | --- | --- | --- |
| `pm` | 需求 | 澄清目标与范围、写 PRD 与验收标准到 `docs/prd/` | 只读代码；只写 `docs/prd/*` |
| `architect` | 设计 | 技术选型、接口/数据设计、任务拆分到 `docs/design/` | 只读代码；只写 `docs/design/*` |
| `dev` | 开发 | 按方案写代码，小步实现 | 读写代码 + 常用构建命令 |
| `qa` | 测试 | 补测试、跑测试、复现缺陷 | 读写代码 + 常用构建命令 |
| `review` | 评审 | 审 diff，挑问题给修改意见 | 只读 + `git`，**禁止**改代码 |
| `ci` | 集成发布 | 跑 typecheck/lint/test/build，准备发布 | 只读 + 常用构建命令，**禁止**改代码 |

约束设计：`review`、`ci` 显式 `write_file`/`edit_file` 为 `deny`，从权限层保证"评审和发布不改代码"；`pm`、`architect` 的写权限被通配符限制在各自的 docs 目录。`bash` 用命令白名单，白名单外的命令落到默认的 `ask`，仍然会弹审批。

## 房间 `rnd`

```json
{ "name": "rnd", "members": ["pm","architect","dev","qa","review","ci"], "coordinator": "pm" }
```

消息按成员顺序轮流经过每个 bot：你发一条需求，`pm → architect → dev → qa → review → ci` 依次发言（成员用 `room_reply` 发言，不发言即跳过），最多 3 轮。安静下来后由 `coordinator`（`pm`）做收尾，它这一轮的回复就是交付物，写到 `docs/deliverables/<UTC 时间戳>-<slug>.md`。

## 用法

```bash
my-agent            # TUI，左侧选中 rnd 房间，输入需求
my-agent serve      # Web UI，侧栏里打开 rnd
```

- 在房间里直接说需求即可，例如"支持 `--image` 参数并补测试"。
- 用 `@dev`、`@qa @review` 指定只让某些成员发言，`@all` 让所有人发言。
- 只想单独驱动一个 bot：TUI 里 `@pm <任务>`，或用 `team` 命令 headless 跑：
  ```bash
  my-agent team --dispatch pm="把这份需求整理成 PRD" --wait-ms 300000
  ```

## 备注

- 这些 bot 是 `native` 后端，默认用 `deepseek-flash`；想换成 cli 后端（`pi`/`opencode`/`claude`）时，把该 bot 的 `backend` 改成 `{ "kind": "cli", "command": "opencode" }` 等。
- 房间一旦生成 ledger 就以 ledger 为准，之后改 `my-agent.json` 的 `members`/`coordinator` 不会改已存在的房间（会提示不一致），要重建请用新的房间名。
- `my-agent.json` 里原有的 `test`/`pi-test`/`opencode`/`dmtest`/`aaa`/`leader` 是早期测试用 bot，与这支流程团队无关，可按需删除。
