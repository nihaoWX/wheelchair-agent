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
wheelchair-agent-core work-plan     # stdin: 一个 JSON 请求；stdout: 一个 envelope
wheelchair-agent-core schema        # 打印请求与响应的 JSON Schema
```

- envelope：`{"ok":true,"data":…}` 或 `{"ok":false,"code":…,"message":…}`；exit 0 / 非零。
- 错误码是稳定的字符串：`invalid_request`（含畸形 JSON）、`plan_failed`、`usage`（exit 2）、`schema_failed`。
- 调用方提交的一切都走 `Result`：`crates/wca-core/src` 里**没有** `unwrap` / `expect` / `panic!`。
  畸形 stdin 给干净的 envelope，不给 backtrace——这条由 `crates/wca-core/tests/cli.rs` 断言。

## 构建与安装

- `bash build/build-core.sh` → `build/artifacts/wheelchair-agent-core-linux-x64`（strip 过，已在 `.gitignore`）。
- `install.sh` 把它拷到 `~/.local/bin/wheelchair-agent-core`（与薄壳同目录），`--check` 用 `cmp` 比对
  checkout 与已装副本。**install.sh 从不跑 cargo**：产物缺失就 FAIL 并打印 `bash build/build-core.sh`。
- `src/shared/work.js` 先找 checkout 里的 `build/artifacts/…`，找不到才用 PATH 上的
  `wheelchair-agent-core`；两者都没有就抛错，**不退回 JS**。
- CI（`.github/workflows/ci.yml`）在 JS 检查之前先 build 一次，再跑 `cargo test --release --workspace`。

## 未定的两件事

1. **分发**：现在冷安装的前置多了一步"先跑 `build-core.sh`"，也就是装的人要有 cargo 和 crates.io。
   这跟"面向大众、`install.sh` 一键安装"冲突，必须在真发布前解决：按 `os`/`arch` 提交预编译产物
   （`dsh` 自己的做法：按平台拆包 + `os`/`cpu` 门禁），或让 `build-core.sh` 在缺产物时下载对应发布件。
2. **平台硬编码**：`src/shared/work.js` 的 `CORE_BINARY` 与 `install.sh` 的 `CORE_ARTIFACT_REL` 都写死了
   `linux-x64`。多平台前要改成按 `process.platform` / `process.arch` 拼名。
