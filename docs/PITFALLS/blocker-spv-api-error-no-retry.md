# SPV 会话遇到上游 Command Code API error 直接停下，不像 cmd 那样自动重试

## 现象

在 SPV（`spv` 启动的 dsh-tui 会话）里，遇到上游 Command Code 的 API 报错时，轮次直接结束并
报错，不会自动重试。同样的错误在 Command Code CLI 里会被自动重试。

观察者（用户）判断：worker 侧不会有这个问题，因为 worker 的运行形态更像 goal，会持续运行。

## 复现步骤

1. `spv` 启动 SPV 会话。
2. 在 SPV 里发一条需要模型回答的消息，且此刻上游 API 返回可重试类错误
   （429 限流、5xx 服务端错误、响应为空、连接超时）。
3. 观察：SPV 的轮次直接以错误结束，没有重试迹象。

## 已查证的事实（供消费者参考，不是结论）

- `@deepseek-ai/dsh-llm-retry` **已挂载**在 SPV preset 的组合里（`--dump-config` 可见 `- id: llm-retry`，
  且未被 disabled）。
- 该插件的重试边界是 **agent 轮次**：它监听 `agent/request-error`，只有 `policy !== undefined` 时才重试。
- `@mars-sea/dsh-commandcode-provider` **实现了** `providerRetryPolicy()`，返回
  `mode: "normal"`、`maxRetries: 1000`、可重试码 `EMPTY_RESPONSE / RATE_LIMIT / THROTTLED / SERVER /
  TIMEOUT / TRANSPORT`，退避 500ms 起、上限 15 分钟。
- 因此策略是存在的，链路也在。也就是说：**不是"没接上重试"**，而更可能是
  **实际报错的 code 不在这份白名单里**，或 **错误发生在 agent 轮次之外**。
- provider 内部同时出现两个相近的码：`RATE_LIMIT`（已在白名单）与 `RATE_LIMITED`（不在）。
- 对照：superagent 的 worker 侧另有自己的重试（`src/executor/dsh.ts` 的 `TRANSIENT_TRIES = 3`、
  15s 退避，`transient()` 认 408/429/5xx 与 ECONNRESET 等），这解释为何 worker 不受影响。

## 建议方向（不指定实现）

目标：SPV 在遇到**可重试**的上游错误时不应直接结束轮次。

可能的方向，按侵入性从低到高：

1. 让 provider 的可重试码覆盖它实际会产生的全部瞬时错误（例如 `RATE_LIMITED` 是否应归一到 `RATE_LIMIT`）。
2. 在 SPV 的 profile 层把 `retryPolicy` 调到 `always` 模式，让任何模型请求失败都重试到成功或取消。
   代价：永久性失败（无效 key、配额耗尽）也会一直重试，需要确认这个取舍可接受。
3. 若错误确实发生在 agent 轮次之外（例如 `ctx.llm.stream()` 的直接消费方），说明该路径本身
   **没有重试边界**，需要在那个消费方补，而不是调策略。

建议先确认实际报错的 `code` 属于哪一类，再决定走哪条——否则可能只是在调一个本就在工作的策略。
