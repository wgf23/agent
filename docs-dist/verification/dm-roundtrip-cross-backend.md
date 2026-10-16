# 跨后端 DM 往返（P0-4 切片）

对应：P0-4 ｜ 结论：**3 条正向用例，全绿**。

`test/rob/team-dm-roundtrip.test.ts` 用真实 `Team` 与真实网关，覆盖三个方向：

1. claude rob 发 DM 给 pi rob，pi rob 回信（CLI 收信 + 回信）。
2. pi rob 发 DM 给 claude rob，claude rob 回信（反向）。
3. claude rob 发 DM 给 **native** rob，native rob 收到后经 `send_message` 回信（守护 native 方向）。

每条断言相同的字面量：

```ts
team.readDms() === [
  { from: "alpha", to: "beta", text: "ping", at: expect.any(Number) },
  { from: "beta", to: "alpha", text: "pong", at: expect.any(Number) },
]
statuses.map((s) => s.status) === ["idle", "idle"]
```

native 用例额外断言 native rob 的 provider 收到的入站内容为字面量 `"[from rob:alpha] ping"`。

## 复现

```bash
pnpm exec vitest run test/rob/team-dm-roundtrip.test.ts   # 3 passed
```

## 反向验证

去掉 native rob 的回信（把 `send_message` 的 `to` 改成不存在的目标）后，该用例超时转红；改回即绿。说明观察的是真实投递，不是空断言。
