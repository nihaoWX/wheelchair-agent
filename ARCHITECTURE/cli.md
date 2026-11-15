# CLI 契约（2026-11-14 定案，已实现）

`wheelchair-agent` 是操作者与 worker 的**唯一命令入口**。`install.sh` 只负责把它装进电脑，没有别的功能。

## 为什么要有 CLI

现在 `install.sh` 装完就消失，用户没有"这个工具是什么"的入口。`install.sh` 装出四个互不相识的命令
（`spv`、`superagent-service`、`jobctl`，以及面板里那个绝对路径的 `prepare.sh`），用户得记住四个名字
和它们各自在哪。

## 一个核心 + 两个适配器

```
        ┌──────────────┐
        │  src/ 核心库  │  ← 纯函数，不 import dsh，不 process.exit
        └──────┬───────┘
       ┌───────┴────────┐
   ┌───▼────┐      ┌───▼─────────┐
   │  CLI   │      │ dsh 插件 ×3 │
   └────────┘      └─────────────┘
```

**插件和 CLI 不能互相调用，只能共享代码。** 如果逻辑在 CLI 里，插件想用就得 `spawn` 一个子进程——
多一个进程、多一个 PATH 依赖、结构化返回值变成 stderr 文本、错误没法带类型。逻辑在库里，两边都干净。

`process.exit` 只出现在 `bin/`，JSON Schema 与 render 只出现在插件入口。

## 子命令

| 命令 | 做什么 | 实现 |
|---|---|---|
| `wheelchair-agent spv [dsh-tui 参数...]` | 拉起后端（幂等）后启动 SPV 会话，其余参数透传给 `dsh-tui` | `exec sh preset/spv-launcher.sh "$@"` |
| `wheelchair-agent prepare` | 面板的 prepare 命令：clone 项目 → 受管 `AGENTS.md` → `tools/` 私有远端 | `exec sh commands/prepare.sh "$@"` |
| `wheelchair-agent service <start\|stop\|restart\|status\|open>` | 服务启停与面板 | `exec python3 commands/superagent-service.py "$@"` |
| `wheelchair-agent jobctl <submit\|status\|log\|verify\|cancel>` | 长任务交给 systemd | `exec python3 commands/jobctl.py "$@"` |
| `wheelchair-agent dispatch --project <p> --task <t> [--thread <n>] [--preset <id>]` | 往队列写一个任务 | `import src/spv/dispatch.js` |
| `wheelchair-agent status [--thread <n>]` | 非阻塞看队列 | `import src/spv/outbox.js` |
| `wheelchair-agent check` | **运行时**健康：服务在跑吗、preset 能加载吗、`prepare` 在假环境里能跑通吗 | 见下 |
| `wheelchair-agent --help` / `--version` | 用法与版本 | — |

**没有 `result` 子命令**：worker 的 `reply` / `notice` 由 SPV 会话里的后台注入器
（`src/spv/injector.js`）消费并作为一条新消息推进对话；CLI 只负责派活与看队列，不读结果。

`install.sh --check` 是**另一件事**：装进去的东西 == checkout。两个 check 不重叠，都保留。

实现位置：`bin/wheelchair-agent.mjs`（argv 解析 + `process.exit`），`check` 的四项在
`src/spv/check.js`（纯函数，返回结构化结果，不结束进程）。`dispatch` / `status` 直接 import
`src/spv/{dispatch,outbox}.js`；`spv` / `prepare` / `service` / `jobctl` 用 `exec` 换进程。

## `prepare` 怎么拿到项目路径

面板里存的是 `wheelchair-agent prepare`（**命令名，不是绝对路径**）。superagent 执行它时：

- cwd = 工单目录的父目录（`~/.dsh/state/superagent/work`）
- env = 工单执行环境变量，其中 `DSH_SUPERAGENT_DIR`（工单目录）与 `DSH_SUPERAGENT_SPV_PROJECT`
  （`tools/<name>` 或 `research/<name>`）就是项目路径的来源
- `PATH` 从服务进程继承，`~/.local/bin` 在其中（已核对 `/proc/<pid>/environ`）

所以 `prepare` **不需要**位置参数。同时接受显式覆盖，供手动调试与测试：

```
wheelchair-agent prepare --project tools/foo --dir /tmp/ticket-1
```

两者都给时显式参数优先。`commands/prepare.sh` 已经支持 `SPV_PROJECTS_ROOT`、`SPV_PREPARE_DRY_RUN`、
`SPV_PREPARE_TEMPLATES`、`SPV_PREPARE_LOG` 四个环境变量，CLI 只做透传，不重新解释。

## 为什么面板值从绝对路径改成命令名

现在面板里是 `sh /home/nihao/.dsh/.agent-presets/spv/prepare.sh`。这是**机器相关的状态，写进了
superagent 的 sqlite**，而 `install.sh` 管不到它——它只 `printf` 一行让操作者手粘。后果：

- 换 `DSH_HOME`、换用户名、换 preset 目录 → 面板值静默失效，**每个工单都在 prepare 阶段失败**
- 重装不会修好它，因为重装只是又打印一遍
- `docs/delivery-target.md` 里那句"已通过管理 API 保存"是 worker 当时手动存的一次性动作，不是
  `install.sh` 的行为

绝对路径本来没必要：`PATH` 是继承的。改成命令名后，面板值变成机器无关的常量，设一次就够。

失败模式也变好了：路径失效是"文件不存在"，含糊；命令名失效是 `wheelchair-agent: command not found`，
一眼看出是 PATH 问题。

**`install.sh` 必须验证服务进程的 PATH，不是 `$PATH`。** 两者不是一回事：面板命令由 superagent 服务
执行。做法是读 `/proc/<pid>/environ`（pid 从 `superagent-service status` 或监听套接字取），
检查 `BIN_DIR` 在里面。服务没跑时跳过并 `note` 一句，不要 fail——装的时候服务可能没起。

## `check` 检查什么

| 项 | 判据 |
|---|---|
| 服务在跑 | `superagent-service status` exit 0 |
| preset 能被 dsh 加载 | `~/.dsh/.agent-presets/spv/` 里 `PRESET_FILES` 列出的文件齐全且 `agent.cordis.yml` 的 `file://` URL 指向存在的文件 |
| 面板 prepare 值正确 | 读 `orchestrator.sqlite` 的 `settings-version:<N>`，`executor.prepare` 应为 `wheelchair-agent prepare` |
| `prepare` 能跑 | `SPV_PREPARE_DRY_RUN=1` 跑一次，exit 0 |

最后一项是**只读**的：`SPV_PREPARE_DRY_RUN=1` 不建仓库、不改远端、不写日志。

## 保留独立命令名

`spv`、`superagent-service`、`jobctl` 继续作为独立命令存在（薄 wrapper，`exec wheelchair-agent <子命令> "$@"`）。
理由：worker 的 prompt、`AGENTS.md`、`PROGRESS.md`、`docs/` 里都是按名字引用它们的，改名要同步改一堆
文档，收益只是"少三个文件"。CLI 里的子命令是**规范形式**，独立名字是兼容层。

## 语言：node

队列格式曾经有两份实现（`src/shared/queue.js` 和 `scripts/spv_send.py`），这是个真隐患——两份实现必须
永远保持字节兼容。CLI 用 node 直接 import `src/shared/queue.js`，那两个 Python 脚本已删除，
**实现从两份变一份**。

代价是 CLI 要 `spawn` python 跑 `jobctl`/`superagent-service`、`exec` sh 跑 `prepare.sh`。这不是缺点：
CLI 本来就是门面，门面后面挂异构工具是正常的。
