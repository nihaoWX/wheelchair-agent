# 插口：CLI、「新增」提示词、边界与实现位置

> 分册：`ARCHITECTURE/hooks.md` 是插口总览；本文的小节编号在本文件内重新编号。

## 1. CLI

```bash
wheelchair-agent hook events                 # 事件表：id、标题、何时触发、是否可取消、行数
wheelchair-agent hook list                   # 每个事件的内建行与自定义行（顺序、超时、脚本预览）
wheelchair-agent hook add --event <id> --name "<名字>" --script '<sh>' [--timeout <ms>]
                                             # 打印新 id（hook-<slug>-<hex>）
wheelchair-agent hook enable <id>
wheelchair-agent hook disable <id>
wheelchair-agent hook rm <id>
wheelchair-agent hook rename <builtin id> "<标签>"      # 空标签 = 恢复默认；只接受 builtin:*
wheelchair-agent hook test <id> [--event <id>] [--payload <json>]
wheelchair-agent hook log [--tail <n>] [--event <id>]   # 默认 20 行
wheelchair-agent hook prompt <event>         # 可复制给 agent 的中文提示词
```

- 退出码：`0` 成功；`1` 运行期错误（找不到 hook、内建行不可改、设置写入冲突/非法、`hook test` 的脚本
  失败）；`2` argv / 用法错误（缺参数、未知事件、`--payload` 不是 JSON、`--timeout` 超限）。
- 所有写入都走设置存储的 revision 检查（过期 = 409，什么都不写）；没有手改文件的路。
- `hook add` 生成 id、校验事件/名字/脚本/超时，**立刻启用**并打印 id。
- `enable` / `disable` / `rm` 作用在内建行上会明确失败：*the core path owns it*。
- `rename` 只接受 `builtin:*`；自定义行的名字在 `add` 时定，改名 = rm + add。
- `hook test`：用事件的文档示例负载（或 `--payload`），`--event` 可覆盖；打印 exit / signal / duration /
  stdout / stderr；**不写 `hooks.jsonl`、不认领 cursor**（它不是一次真实 occurrence）。显式测试**总是会跑**：
  行被 `disable` 或总开关 `hooks.enabled: false` 时也照跑，只在输出里各加一条 `note:`。
- `hook rename` 的标签形状（≤120 字符、无控制字符）在命令行就校验，非法是用法错误（退出码 2）。
- `hook prompt`：中文、可整段复制。它只从 `EVENTS` 生成，包含事件 id、含义、触发时机、重复性、负载字段、
  `WCA_*`、cwd、超时，以及要写出来的
  `wheelchair-agent hook add --event <id> --name "<名字>" --script '<sh>' [--timeout <ms>]`。
  这正是 stage 3 面板「新增」按钮要显示的文字；面板与 CLI 用同一个生成函数，输出逐字节相同（CLI 不再
  附加 checkout 行）。

### 「新增」是提示词，不是 shell 输入框

操作者的话：*"用户可以新增脚本（点开新增是一段可复制的提示词，其实意思就是让用户叫 agent 改就行）"*。
所以 `hook add` 是给 agent 用的；操作者拿 `hook prompt` 的文本去让 agent 加。stage 2 **不**提供从面板直接写
shell 的路径；stage 3 的面板也只显示这段提示词。

---


## 2. 边界与安全

- **不 import `dsh-superagent`**，不碰 `~/opt/dsh-plugins/dsh-superagent`；唯一跨项目接口是既有的文件队列。
- `src/shared/hooks.js`、`src/shared/hook-events.js` 与 `src/spv/hook-runner.js` 只用 Node builtins，被
  `install.sh` 复制进 preset / webui 包，必须能单独存在（`tests/test-layout.sh` 规则 3）。
- 脚本以**操作者**的权限运行：它和操作者自己的 shell 一样强。所以入口只有设置文件，而设置文件只能通过
  CLI / 面板（revision 检查）写；stage 2 没有"面板直接执行 shell"的通道，stage 3 的面板也只显示提示词。
- 队列读取器只读，不消费；注入器仍然是唯一的消费者，"rename 即已读"的原子性没有被破坏。
- 所有测试都在 `mkdtemp` 沙箱里，`WHEELCHAIR_AGENT_HOME` / `SPV_QUEUE_DIR` / `DSH_SUPERAGENT_STATE_DIR`
  全部指向沙箱；没有网络。


## 3. 实现位置

| 文件 | 职责 |
|---|---|
| `src/shared/hook-events.js` | 事件表 + 内建行（唯一契约；settings 与 hooks 都从它读） |
| `src/shared/hooks.js` | 模型、执行、记录、cursor、队列原语、spool 原语、提示词生成 |
| `src/shared/settings.js` | `hooks` 子块的校验、合并、落盘、HTTP 面（含 `intervalSeconds`） |
| `src/spv/hook.js` | `wheelchair-agent hook ...` 的命令逻辑 |
| `src/spv/hook-runner.js` | service 侧唯一 runner：drain spool + 队列，按 `hooks.intervalSeconds` 调度；执行注入进来的内建效果（含重试与超时） |
| `src/spv/archive-effect.js` | 内建效果 `builtin:archiveSession`：交付后归档 `worker-<ticketId>`（纯 Node，服务由 host 注入） |
| `src/spv/auto-merge-effect.js` | 内建效果 `builtin:autoMerge`：交付后按五道闸门 squash 合并工单 PR（纯 Node；`planOf`/`execFile`/开关由 host 注入，测试用假实现） |
| `webui/lib/index.js` | 在 host 里挂 runner（与 `startInboxWatcher` 同一层，`ctx.effect` 停止）；注入 `effects`（`builtin:archiveSession` 用懒取的 `workspaceRegistry` / `jobs`；`builtin:autoMerge` 用 `resolveSettings().values['merge.autoMerge']` 与 `planWork()`，超时 120s）；给 settings 快照挂只读的 `hookView` |
| `webui/lib/client.js` | 第三个功能段「插口」：事件/行/最近 5 次执行的只读视图；内建行改名走同一个 revision PUT |
| `src/spv/inbox.js` | review / notice / merge 的 core path，之后 fire `inbox.*` |
| `src/spv/dispatch.js` | 任务落进 `pending/` 后写 `spv.dispatch` spool |
| `commands/prepare.sh` | 成功结束时写 `ticket.started` spool（纯 sh、best effort、dry-run 不写） |
| `bin/wheelchair-agent.mjs` | argv → 命令、退出码、`--help` |
| `tests/test-hooks.mjs` / `tests/test-settings.mjs` / `tests/test-inbox*.mjs` / `tests/test-prepare.sh` | 离线证据（含 stage 3 视图、提示词逐字节相等、改名与陈旧 revision） |
