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
wheelchair-agent-core work-plan     # 回收计划（ticket 1）
wheelchair-agent-core queue-op      # 队列原语：layout / ensure-dirs / pending-names / read-task /
                                    #   consume-task / quarantine-task / write-message（ticket 2）
wheelchair-agent-core schema-check  # 评估 src/shared/schema.js 的一个 validator（ticket 2）
wheelchair-agent-core schema        # 打印所有请求/响应的 JSON Schema
```

- envelope：`{"ok":true,"data":…}` 或 `{"ok":false,"code":…,"message":…}`；exit 0 / 非零。
- 错误码是稳定的字符串：`invalid_request`（含畸形 JSON）、`plan_failed`、`queue_failed`、`schema_error`、
  `invalid_json`、`usage`（exit 2）、`schema_failed`；队列的 fs 错误直接用 errno 名（`ENOENT` 等）当 code，
  message 保持 Node 的形状。
- 调用方提交的一切都走 `Result`：`crates/wca-core/src` 里**没有** `unwrap` / `expect` / `panic!`。
  畸形 stdin 给干净的 envelope，不给 backtrace——这条由 `crates/wca-core/tests/cli.rs` 对每个子命令断言。

## 已搬入的模块

- **ticket 1 — `work-plan`**：`planWork()` 的全部判定（gate 顺序、reason 文案、record 字段、keep/keepDays/
  blockedReason）。parity 门是 `tests/test-work.mjs` 零改动 + `work gc --dry-run` 与迁移前逐字一致。
- **ticket 2 — `queue-op` / `schema-check`**：`src/shared/queue.js` 与 `src/shared/schema.js` 的导出变成薄壳。
  - `queue-op` 的 `layout` 返回四目录；`ensure-dirs` 只建 root/pending/done/outbox（read 归 reader）；
    `pending-names` 缺目录读空、过滤点文件与非 `.json`、按 mtime 升序；`read-task` 返回 payload；
    `consume-task` / `quarantine-task` 用与旧实现相同的目标名和原子 `rename`，EXDEV/EPERM 时 unlink 源文件；
    `write-message` 用 id 安全名、pretty JSON、0644、临时文件再 rename。
  - `schema-check` 接收序列化的 validator 描述（text / integer / records / object）与一个 value，返回
    `{defined,value}` 或与旧 `SchemaError` 逐字相同的 message（含 `object()` 的 `key: …` 前缀与 `safeParse`）。
  - `schema` bundle 保留 ticket 1 的顶层 `request` / `response` 键，新增 `queue` 与 `schemaCheck` 两组。
  - 桥接函数 `runCore` 放在 `queue.js`：`install.sh` 与 `tests/test-settings.mjs` 的 webui 夹具都复制
    `queue.js` 而不复制额外 helper，parity 门又不允许改测试；`work.js` / `schema.js` 复用这个导出。
  - binary 发现顺序：模块旁的 `build/artifacts/…` → `process.cwd()/build/artifacts/…`（复制出来的
    `src/` 树/夹具）→ PATH 上的 `wheelchair-agent-core`；都没有就抛错并打印 `bash build/build-core.sh`。
  - Rust 测试：`tests/queue.rs` / `tests/schema.rs` + `tests/cli.rs` 对两个新子命令的畸形 stdin 断言。
  - 已知取舍：`pending-names` 的 mtime 相同项用字节序（真实 task 文件名是十六进制 id）；畸形 task 的
    `readTask` 仍抛 `SyntaxError` 但 message 来自 serde（`pollQueue` 只计数/隔离，不展示）；
    `object()` / `records({extra})` 的 reader 必须是 schema.js 自己的 validator（自定义 reader 的
    `work.js` 已改为自己校验 envelope）。

## 构建与安装

- `bash build/build-core.sh` → `build/artifacts/wheelchair-agent-core-linux-x64`（strip 过，已在 `.gitignore`）。
- `install.sh` 把它拷到 `~/.local/bin/wheelchair-agent-core`（与薄壳同目录），`--check` 用 `cmp` 比对
  checkout 与已装副本。**install.sh 从不跑 cargo**：产物缺失就 FAIL 并打印 `bash build/build-core.sh`。
- JS 侧（桥接在 `src/shared/queue.js`）先找 checkout 里的 `build/artifacts/…`，再找
  `process.cwd()/build/artifacts/…`（复制树/测试夹具），最后用 PATH 上的 `wheelchair-agent-core`；
  都没有就抛错，**不退回 JS**。
- CI（`.github/workflows/ci.yml`）在 JS 检查之前先 build 一次，再跑 `cargo test --release --workspace`。

## 未定的两件事

1. **分发**：现在冷安装的前置多了一步"先跑 `build-core.sh`"，也就是装的人要有 cargo 和 crates.io。
   这跟"面向大众、`install.sh` 一键安装"冲突，必须在真发布前解决：按 `os`/`arch` 提交预编译产物
   （`dsh` 自己的做法：按平台拆包 + `os`/`cpu` 门禁），或让 `build-core.sh` 在缺产物时下载对应发布件。
2. **平台硬编码**：`src/shared/queue.js` 的 `CORE_ARTIFACT` 与 `install.sh` 的 `CORE_ARTIFACT_REL` 都写死了
   `linux-x64`。多平台前要改成按 `process.platform` / `process.arch` 拼名。
