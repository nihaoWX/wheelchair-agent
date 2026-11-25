# 插口（hook）引擎

插口是在 core 事件上挂的**用户脚本层**：事件发生时跑一段操作者自己的 shell 脚本，把结果记下来。
它和 core path 严格分开——**hook 从不包裹、不 gate、不重试 core path**：review 落盘、notice 进队列、
合并后的 `git pull --ff-only`、队列的 rename 式消费永远发生，脚本失败只让自己那一条记录变成失败。

可配置的是**副作用**（`hooks` 设置块、`items`、`labels`），不可取消的是**内建行**（`cancellable: false`）。
唯一读者是 `webui/lib/index.js` 的 `startHookRunner()`；唯一写者是 `wheelchair-agent hook …`。

## 分册

| 想知道 | 读 |
|---|---|
| 三条硬边界、九个事件的含义与负载、内建行（`archiveSession`/`autoMerge`）、PR 身份 | `ARCHITECTURE/hooks/contract.md` |
| `hooks` 设置块的形状、cwd/stdin/env/超时/输出与记录契约、总开关 | `ARCHITECTURE/hooks/execution.md` |
| cursor、队列读取原语、服务侧 runner、spool、八个事件的接线表 | `ARCHITECTURE/hooks/runtime.md` |
| `hook` 子命令、`hook prompt`、「新增」为什么是提示词、边界与实现位置 | `ARCHITECTURE/hooks/surfaces.md` |
| 面板第三段「插口」怎么渲染（只读视图、`hookView`、改名写路径） | `ARCHITECTURE/webui/hooks.md` |

事件表的唯一实现在 `src/shared/hook-events.js`（加事件不用改 Rust：二进制不认识事件名，JS 把
`knownEvents` 与 `sample` 传给 `hooks` 子命令）。
