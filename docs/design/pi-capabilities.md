# pi 能力验证（@mariozechner/pi-coding-agent 0.73.0）

本文件记录 G1 到 G7 相关能力的真实验证，不是从文档推断。安装路径：

```text
/root/.local/share/mise/installs/node/24.21.0/lib/node_modules/@mariozechner/pi-coding-agent
```

`pi --version` 输出 `0.73.0`。使用 `deepseek` provider 和 `deepseek-v4-flash` 模型，密钥来自 `DEEPSEEK_API_KEY`。

## G1：角色提示（已用真实 pi 验证）

`--help` 列出 `--append-system-prompt <text>`，可以重复使用。命令：

```bash
pi -p --provider deepseek --model deepseek-v4-flash --no-session --no-tools \
  --append-system-prompt "You are a strict reviewer. Always begin your reply with the word REVIEW:" \
  "What is the capital of France?"
```

观察到的输出，退出码 0：

```text
REVIEW: The capital of France is Paris.
```

结论：角色改变回答，回答以 `REVIEW:` 开头。角色必须作为单个 argv 传入，不能拼接进 shell 字符串。我们的后端把角色作为 `--append-system-prompt` 的单独 argv 传入，见 `src/rob/cli-backend.ts`。

## G2：流式事件（已用真实 pi 验证）

同一条命令加 `--mode json`，prompt 为「Count from 1 to 5」。stdout 每行一个 JSON。`message_update` 的形状：

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"1","partial":{...}},"message":{...}}
```

- `assistantMessageEvent.type` 依次是 `text_start`、`text_delta`、`text_end`。
- 只有 `text_delta` 带 `delta` 字段，就是这一段的新增文本。
- `text_start.partial` 已经包含第一段文本，所以只能用 `text_delta.delta` 增量，不能用 `partial`。
- `message_end.message.content` 里的文本等于所有 `delta` 拼起来的结果。
- `message_end.message.usage` 提供 `input`、`output`、`cacheRead`。

`--mode json` 的事件类型汇总（同一次运行）：`session`、`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`text_start`/`text_delta`/`text_end`（嵌在 message_update 里）、`turn_end`、`agent_end`。

## G3：模型错误（已用真实 pi 验证）

用不存在的模型名触发：

```bash
pi -p --mode json --provider deepseek --model definitely-not-a-real-model --no-session --no-tools "hi"
```

退出码是 **0**，stderr 只有一条警告：

```text
Warning: Model "definitely-not-a-real-model" not found for provider "deepseek". Using custom model id.
```

stdout 的 assistant 消息带 `stopReason` 和 `errorMessage`：

```json
{"type":"message_end","message":{"role":"assistant","content":[],"...":"...","usage":{...},"stopReason":"error","errorMessage":"400 The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed definitely-not-a-real-model. (request_id: ...)"}}
```

结论：错误字段名是 `errorMessage`，且进程仍以 0 退出。`content` 为空，所以旧代码会退化成空回答。我们现在在 `message_end` 看到 `stopReason` 为 `"error"` 或 `"aborted"` 时返回错误结果并发出 `error` 事件。

## RPC 模式与中途插话（G5，已用真实 pi 验证）

`--mode rpc` 是常驻 JSONL 协议：命令写 stdin，事件和 `response` 写 stdout，见 pi 包内 `docs/rpc.md` 与 `dist/modes/rpc/rpc-types.d.ts`。

- 送入一条消息：`{"type":"prompt","message":"..."}`。
- 回合进行中送入：必须带投递模式。`{"type":"prompt","message":"...","streamingBehavior":"steer"}`，或者 `{"type":"steer","message":"..."}`。文档说明 `steer` 在当前 assistant 回合执行完工具调用之后、下一次 LLM 调用之前投递。
- 事件用 `agent_start` / `message_*` / `tool_execution_*` / `agent_end`，形状与 `--mode json` 相同，另有 `response` 和 `queue_update`。

真实验证：启动 `pi --mode rpc --tools bash`，发送 prompt「Run the bash command `sleep 5` and then say DONE」，在 `tool_execution_start` 时发送 steer：

```text
RESPONSE {"type":"response","command":"prompt","success":true}
[ASSISTANT_END stop=toolUse]
[TOOL_START bash {"command":"sleep 5","timeout":10}]
[SENDING STEER NOW]
QUEUE_UPDATE {"type":"queue_update","steering":["Stop what you are doing and reply with exactly: STEERED"],"followUp":[]}
RESPONSE {"type":"response","command":"steer","success":true}
QUEUE_UPDATE {"type":"queue_update","steering":[],"followUp":[]}
STEERED
[ASSISTANT_END stop=stop]
```

结论：第二条消息可以在回合进行中送入，pi 返回 `success:true`，并在工具结束后处理它，回答变成 `STEERED`。会话续接：`--session-dir <dir> --continue` 在 rpc 模式下跨进程续接（第一轮回答 `OK`，第二轮回答 `777`）。

### 空闲时的 steer 会丢失（真实验证，R4.3 修复）

真实验证：`pi --mode rpc --no-tools --no-session`，先发 prompt「Reply with exactly: FIRST」，等到 `agent_end` 之后再发 `{"type":"steer","message":"SECOND"}`：

```text
{"type":"response","command":"prompt","success":true}
ASSISTANT "FIRST"
{"type":"agent_end",...}
SENDING IDLE STEER
{"type":"queue_update","steering":["SECOND"],"followUp":[]}
{"type":"response","command":"steer","success":true}
CLOSING STDIN
EXIT 0
```

结论：`agent_end` 之后 pi 已空闲。此时 steer 仍返回 `success:true`，消息进入 `queue_update.steering`，但不会开启新回合；进程退出时消息还留在队列里，永远不会投递。此前 cli 后端忽略 steer 响应，而轮询器已经从 rob 收件箱取走该消息，于是消息静默丢失。

修复（`src/rob/cli-backend.ts`）：

- 用 `turnActive` 跟踪回合：发送 `prompt` 后为真，收到 `agent_end` 后为假。轮询器只在 `turnActive` 为真时 drain 收件箱，空闲时不碰，交给 rob 自己的循环在下一轮取走。
- 收到 `agent_end` 时，若最新的 `queue_update.steering` 非空，说明这些 steer 未投递：按原顺序用空行拼接成一条 `prompt`，在同一进程内重发，回合继续；仅在 steering 为空时才结束回合。
- steer 响应 `success:false` 视为未投递，消息重新进入待投递列表，由同一路径重发。
- 已取走却既未投递也未进入过 steering 队列的消息视为丢失：回合以 `ok:false` 结束，错误信息带上丢失条数，绝不静默报告成功。

## 扩展：拦截工具调用（G7，已用真实 pi 验证）

扩展用 `-e <file>` 加载，默认导出 `(pi) => {...}`。安装包内的 API 定义在：

- `dist/core/extensions/types.d.ts`：`on("tool_call", ...)` 与 `registerTool(...)`。
- `docs/extensions.md`：`tool_call` 在 `tool_execution_start` 之后、工具执行之前触发，**可以阻塞**，返回 `{ block: true, reason?: string }` 就阻止工具。
- 同文件的 Mode Behavior 表：交互模式有完整 TUI；`--mode rpc` 把 UI 请求转成 JSON 协议；`--mode json` 和 `-p` 下 UI 方法是 no-op。

验证用的扩展在 `tool_call` 里对 bash 调用 `ctx.ui.confirm(...)`。RPC 模式下 `ctx.ui.confirm` 会向 stdout 发 `extension_ui_request` 并阻塞，直到客户端用 `extension_ui_response` 回复。观察到：

```text
TOOL_START bash {"command":"echo FORBID"}
UI_REQUEST {"type":"extension_ui_request","id":"...","method":"confirm","title":"Permission","message":"Allow bash: echo FORBID?"}
[REPLIED confirmed:false]
TOOL_END bash isError= true {"content":[{"type":"text","text":"Denied by host"}],"details":{}}
```

把回复改成 `confirmed:true`：

```text
[REPLIED confirmed:true]
TOOL_END bash isError= false {"content":[{"type":"text","text":"FORBID\n"}],"details":{}}
```

结论：API 支持阻塞，允许和拒绝两条路径都生效。注意 `ctx.ui.confirm` 只在 `--mode rpc` 下可用；在 `--mode json`/`-p` 下是 no-op，等于拒绝。安装包还自带 `examples/extensions/permission-gate.ts`，用同一 `tool_call` 钩子做危险命令确认。

## 扩展回调到我们的进程（G6，机制已用真实 pi 验证；R6 已实现，见 `src/rob/gateway/`）

扩展工具可以在 `execute` 里用 Node 内建模块连回我们的进程。最简单的可用机制是 Unix domain socket：

- 我们的进程监听一个 socket，把路径通过 spawn 的 env 传给 pi。
- 扩展工具 `net.connect(path)`，写一行 JSON 请求，等一行 JSON 回复，把回复作为工具结果返回。

真实验证：监听 `/tmp/opencode/pi-probe/peer.sock`，pi 用 `-e ext-peer.mjs` 调用 `peer_ping`。观察到：

```text
HOST LISTENING /tmp/opencode/pi-probe/peer.sock
HOST RECEIVED {"tool":"peer_ping","args":{"text":"HELLO"}}
TOOL_END {"content":[{"type":"text","text":"{\"ok\":true,\"echoed\":\"HELLO\"}"}],"details":{}}
```

代价：需要一条常驻监听通道、一次请求-响应往返、并把 socket 路径传进子进程；请求和回复要自己定协议。基于文件的轮询（扩展写请求文件，我们的进程写回复文件）也能工作，但引入轮询延迟和文件生命周期管理，比 socket 慢。两条路都要自己处理并发和清理。

## 结论对照

| 缺口 | 机制 | 状态 |
|---|---|---|
| G1 | `--append-system-prompt`，单个 argv | 已实现并验证 |
| G2 | `message_update.assistantMessageEvent.delta` | 已实现并验证 |
| G3 | `message_end.stopReason` + `errorMessage`，退出码 0 | 已实现并验证 |
| G4 | 子 agent 的 `usage` 事件累加到 rob | 已实现并验证 |
| G5 | `--mode rpc` + `steer`，空闲 steer 补投递，未投递计数失败 | 已实现并验证 |
| G6 | 扩展工具 + Unix socket 回调 | 机制已验证；R6 已实现（pi） |
| G7 | `tool_call` 钩子 + `ctx.ui.confirm` 阻塞 | 已实现并验证 |
