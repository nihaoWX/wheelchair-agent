# Rust 核心（`crates/wca-core` → `wheelchair-agent-core`）

为什么有它：这个仓库用 Rust 的**严格编译器**防回归。语言本身不给好处（没有性能诉求），编译期检查才是目的。
所以一个模块搬过去时**只能有一份实现**——没有 JavaScript 兜底，没有"Rust 不行就退回 JS"的开关。

## 边界：独立进程，不是 Node addon

跑在 dsh 进程**里面**的三样东西永远留 JS：插件注册与工具面、把消息推进活着的 SPV 会话的注入器、
面板的 HTTP 路由与浏览器 bundle。其余逻辑都搬到二进制里，JS 只留调用壳。

选独立进程而不是 `.node`（napi-rs 也完全可行，loader 只约束入口是一次 ESM `import()`）的理由：

1. **panic 的爆炸半径**：`.node` 里的一次越界会让 dsh 服务或 SPV 会话整个 abort；二进制里只是这一条命令失败。
2. **边界是显式契约**：JSON 进、JSON 出，`schemars` 生成 schema，JS 侧用 `src/shared/schema.js` 校验，
   比 FFI 的值转换更容易在 CI 里单独测。
3. **分发只有一个文件**：不跟 Node-API / glibc 版本耦合。
4. **可独立测试**：`cargo test` + shell e2e，和这个项目"离线脚本即证据"的文化一致。

实测代价可忽略：极小的原生二进制 spawn ≈ 0.7–1.0 ms，而项目的轮询节奏是 1–60 秒。

## 契约

```
wheelchair-agent-core work-plan     # 工单目录的规划与回收判定
wheelchair-agent-core queue-op      # pending/done/outbox 的全部原语（列目录、读、消费、隔离、写）
wheelchair-agent-core schema-check  # 求值一个序列化后的校验器
wheelchair-agent-core settings      # 设置的键表/默认值/合并/校验/保存（`filled` 只补一次）
wheelchair-agent-core hooks         # 插口的数据面：负载/事件 id/超时/cwd/env/记录/游标/正文截断
wheelchair-agent-core schema        # 打印各子命令的请求与响应 JSON Schema
```

- envelope：`{"ok":true,"data":…}` 或 `{"ok":false,"code":…,"message":…}`；exit 0 / 非零。
- 错误码是稳定的字符串：`invalid_request`（含畸形 JSON）、`plan_failed`、`schema_error`、`usage`（exit 2）、
  `schema_failed`、`SETTINGS_INVALID`（非法值）、`SETTINGS_CONFLICT`（缺/过期 revision）、
  `UNKNOWN_EVENT`（插口事件表里没有这个 id）。
- 调用方提交的一切都走 `Result`：`crates/wca-core/src` 的**非测试代码**里没有 `unwrap` / `expect` / `panic!`
  （只有 `#[cfg(test)] mod tests` 里用作断言）。畸形 stdin 给干净的 envelope，不给 backtrace——这条由
  `crates/wca-core/tests/cli.rs` 断言。

## 已经搬过去的模块

| JS 模块 | 子命令 | parity 门（零改动才是通过） |
|---|---|---|
| `src/shared/work.js` | `work-plan` | `tests/test-work.mjs` |
| `src/shared/queue.js` | `queue-op` | `tests/test-hooks.mjs`、`test-inbox.mjs`、`test-settings.mjs`、`test-home.mjs` |
| `src/shared/schema.js` | `schema-check` | 同上（四个套件都靠 schema 的错误文案） |
| `src/shared/settings.js` | `settings` | `tests/test-settings.mjs`（含错误文案与 `filled` 只补一次）+ 面板/注入器读设置的路径 |
| `src/shared/hooks.js`（数据面） | `hooks` | `tests/test-hooks.mjs`、`test-inbox-refresh.mjs`、`test-settings.mjs`、`test-deployments.mjs` |

JS 侧只剩调用壳，签名不变：`dirsOf` 仍同步，异步队列helper 仍返回 `undefined`，
`text`/`integer`/`records` 仍返回校验函数，`object()` 仍返回 `{parse,safeParse}`，`SchemaError` 仍是 JS class
（`instanceof` 不受影响）。**唯一的进程桥**是 `queue.js` 里的 `runCore`（`spawnSync`，5 分钟超时、16 MiB 上限、
envelope 解析、缺产物时提示 `bash build/build-core.sh`）——放在 `queue.js` 是因为 `install.sh` 与 webui 夹具只拷
`queue.js` 这一个文件；`work.js` 与 `schema.js` 复用它。

`settings.js` 搬过去时（`#47`）保留了文件与 HTTP 面（`createSettingsHandler` 仍是 JS：路由、413/415、409 这些是
webui 的事），只把**数据模型**交给二进制：键表与默认值、`filled`、合并优先级、校验、`revision` 语义。Node 侧
`settingsOp = request => runCore(['settings'], JSON.stringify(request))` 是唯一入口。判据是我自己跑的对比：
`defaultValues()`、`resolveSettings()` 对一份缺键 `settings.json` 的结果、写回后的文件字节、以及 stale-revision
与非法值的错误文案，改动前后**逐字相同**。

`hooks.js` 搬过去时（`#54`）只搬**数据面**：payload 采样、事件 id 派生、超时解析、`hookCwd`/`hookEnv`、
`hooks.jsonl` 追加与读取、游标的读写与 `0644` 原子写、队列正文的 12000 code point 截断（`texts` op）。
**执行面留在 Node**：`spawn`、流式 stdout/stderr、`KILL_GRACE_MS` 强杀、每次运行的超时；游标的
**锁与 claim 协议**也留在 Node（它协调进程），只调用搬过去的读写原语。事件表本身（九个事件与示例负载）
仍在 `src/shared/hook-events.js`：二进制不认识事件名，JS 把 `knownEvents` 与 `sample` 一起传进去，
所以加事件不用改 Rust。唯一有意的差异：坏游标文件时 V8 与 serde 的解析措辞不同，外层形状
（`the hook cursor … is not valid JSON (…); replaying.`）一致，测试断言的是形状。

搬过去之后要记得的三件事（都在 PR #33 里写明了）：

1. `pendingNames` 对同 mtime 的名字按字节序排，旧 JS 是 `localeCompare`——写队列的是十六进制 id，两者顺序一致。
2. outbox 由 `serde_json` 美化输出，大数可能写成指数形式（`1.2345678901234568e+20`）；解析回来是同一个数。
3. `object()` / `records({extra})` 现在需要从 `schema.js` 读校验器描述（要序列化给二进制）；当前唯一传自定义
   reader 的调用方是 `work.js`，它已改为直接校验自己的 envelope。

## 构建与安装

- `bash build/build-core.sh` → `build/artifacts/wheelchair-agent-core-linux-x64`（strip 过，已在 `.gitignore`）。
- `install.sh` 把它拷到 `~/.local/bin/wheelchair-agent-core`（与薄壳同目录），`--check` 用 `cmp` 比对
  checkout 与已装副本。**install.sh 从不跑 cargo**：产物缺失就 FAIL 并打印 `bash build/build-core.sh`。
- `src/shared/queue.js` 的 `runCore` 先找 checkout 里的 `build/artifacts/…`，找不到才用 PATH 上的
  `wheelchair-agent-core`；两者都没有就抛错，**不退回 JS**（`work.js` 与 `schema.js` 经它调用）。
- CI（`.github/workflows/ci.yml`）在 JS 检查之前先 build 一次，再跑 `cargo test --release --workspace`。

## 未定的两件事

1. **分发**：现在冷安装的前置多了一步"先跑 `build-core.sh`"，也就是装的人要有 cargo 和 crates.io。
   这跟"面向大众、`install.sh` 一键安装"冲突，必须在真发布前解决：按 `os`/`arch` 提交预编译产物
   （`dsh` 自己的做法：按平台拆包 + `os`/`cpu` 门禁），或让 `build-core.sh` 在缺产物时下载对应发布件。
2. **平台硬编码**：`src/shared/queue.js` 的 `CORE_BINARY` 与 `install.sh` 的 `CORE_ARTIFACT_REL` 都写死了
   `linux-x64`。多平台前要改成按 `process.platform` / `process.arch` 拼名。
