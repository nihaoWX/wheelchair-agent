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
| `wheelchair-agent spv [dsh-tui 参数...]` | 整台机器**唯一**的 SPV 会话：把其余参数透传给 `dsh-tui`，**一份后端都不启动**（`#59` 起：派单时才按需拉起目标部署）。**没有部署选择器**（`--project`/`--all` 报 UsageError）——会话不属于任何部署，派单按任务的 `project` 路由、回信靠注册表聚合；启动前清掉继承来的 `SPV_QUEUE_DIR`/`DSH_SUPERAGENT_STATE_DIR`。注册表缺失只打一行指路 note，不阻断启动 | `runSpvSession` 把 `preset/spv-launcher.sh` 当受监督子进程跑（`src/spv/restart-ux.js`） |
| `wheelchair-agent prepare` | 面板的 prepare 命令：clone 项目 → 受管 `AGENTS.md` → `tools/` 私有远端 | `exec sh commands/prepare.sh "$@"` |
| `wheelchair-agent service <start\|stop\|restart\|status\|open> [--all]` | 目标由**所在目录**决定：cwd 落在 `<PROJECTS_ROOT>/<project>` 之下（含子目录，最长匹配）就动那份注册部署，`SPV_QUEUE_DIR`（启动器拉起的 shell）作第二兜底；推不出就 exit 2 并列出注册表 + `--all` 指路。**`--project` 已删（`#59`）：部署就是你所处的项目 checkout**，要动别处的那份用 `--all`（全部）或 `restart-all --project <p>`。裸 `status` 不需要推断——先打面板行，再逐份列出所有注册部署。`open` 只开**独立面板**（不属于任何部署，不接受 `--all`） | `import src/spv/deployment.js` → `commands/superagent-service.py` |
| `wheelchair-agent panel [start\|stop\|status\|sync] [--port <n>] [--detach]` | 独立面板本体：**一份自己的 dsh 实例**，插件集**镜像**来源 profile（设置 `panel.profileFrom`，默认 `superagent`）——bundles 按原序复制，仅去掉 `dsh-superagent`（那会再开一份 orchestrator/Sources）；dsh 装不认识的包从来源 profile 的 `node_modules` 软链，并在 `panel-bundles.json` 记账以便只回收自己建的链接。`sync` 幂等重建（`synced: N bundle(s), M link(s)`）：除 bundles 外，还把来源 profile 的 `cordis.patch.yml` 顶层行原样镜像进面板自己的 patch——跳过 `dsh-superagent`、`webserver` 和 `insert` 里的 `wheelchair-agent/*`，管理行 `wheelchair-webui`（首）与 `ui-settings-general`（末）由面板自己持有，`apiKey`/`token`/`password` 这类字面秘密不复制并打 note；来源 patch 缺失/读不了时只留两行管理行并打 note。`start` 前自动 sync（来源 profile 消失时保留现有 bundles/patch 并打 note，不影响启动），`status` 先打 `plugins:`/`config:`/`drift:` 再打 port/pid/带 token 的 url/`check: http <code>`/state 并说明没有 orchestrator 可报。`127.0.0.1` + 默认 **3080**（`panel.port` 可改），overlay 是 `preset/panel.patch.yml`；**不含**收件箱轮询/自动合并/冷安装提醒（那些在每份部署的 dsh 插件里）。`--detach` 常驻（tmux `wca-panel`，stateDir `<data root>/panel`）。**`service stop/start --all` 把它算进这一圈**（`#62`：停最后、起最后、失败不改部署退出码），并认得 `#58` 之前 `cli.js panel --foreground` 的旧宿主（只 `SIGINT`、有界等待、不 `SIGKILL`；`install.sh` 装完与 `--check` 也会打印它的 pid 与 `kill -INT` 指路） | `src/spv/panel-instance.js` + `src/spv/panel-profile.js` + `commands/superagent-service.py --mode panel`；`install.sh` 建/刷新 `$DSH_HOME/profiles/wheelchair-agent/`（`#65` 之前叫 `panel`，装一次即自动搬过去） |
| `wheelchair-agent jobctl <submit\|status\|log\|verify\|cancel>` | 长任务交给 systemd | `exec python3 commands/jobctl.py "$@"` |
| `wheelchair-agent dispatch --project <p> --task <t> [--thread <n>] [--preset <id>]` | 先确保该部署的实例在跑（同 `service start` 的 argv，幂等），**成功之后**才往队列写任务（`#59`）；启动失败则不写任何文件 | `import src/spv/dispatch.js` |
| `wheelchair-agent status [--thread <n>]` | 非阻塞看队列 | `import src/spv/outbox.js` |
| `wheelchair-agent inbox` | 打印收件箱在哪里与面板 URL（独立面板 `127.0.0.1:3080/`）；不起任何页面 | — |
| `wheelchair-agent inbox watch [--once] [--interval <秒>]` | 轮询 `tools/*` 的 `gh pr list`，把 PR 写进收件箱 | `import src/spv/inbox.js` |
| `wheelchair-agent work <gc\|restored>` | 回收可重建的票目录；`restored <ticket>` 打印重建命令 | `import src/shared/work.js` |
| `wheelchair-agent restart-all --project <p> \| --all [--dry-run] [--force] [--no-install] [--detach]` | `--project`：只停/起那一份实例并 resume 它的会话，**不装**（`/restart-wheelchair-agent` 的实现）；`--all`：逐份停 → 等会话租约 → 装一次 → 逐份起 → 同终端 `--resume` 拉回会话（`/restart-wheelchair-agent --all`） | `import src/spv/deployment-restart.js` / `src/spv/restart.js` |
| `wheelchair-agent deployment <list\|add\|remove\|migrate\|setup>` | 项目 → 部署注册表：路由、实例 overlay、端口分配、可选 `repository`（`--repo` 或从项目 checkout 的 GitHub origin 推断）；`--spv <root>` 同时把 worker 绑进那个 spv 项目（省略时只在唯一祖先可推断时自动）；`setup --project <p>` 走该实例的面板 API 把 `source:github` 指到自己的仓库；`add` 拒绝另一个项目名认领同一份 checkout（`realpath` 判等，报现有 slug 与端口；同一项目重复 add 幂等）；`remove` 删最后一条要 `--force`，并同步解绑 spv 项目；`migrate` 认领旧安装 | `import src/spv/deployment.js` / `deployment-setup.js` |
| `wheelchair-agent spv-project <list\|add\|remove>` | spv 根 → orchestrator 项目的绑定（`<data root>/spv-projects.json`；`--orchestrator`，旧 `--worker` 等价）：spv 根不能是已登记 worker 项目、两个根不能嵌套、worker 必须在根之下、一个 worker 只绑一个 spv；`remove` 还绑着 worker 时要 `--force`。只用于展示与规划，**不参与派单** | `import src/spv/spv-project.js`（模型在 `src/shared/spv-projects.js`） |
| `wheelchair-agent session release [--session <id>] [--dry-run]` | 释放占着 `session.lock` 的残留进程 | `import src/spv/session.js` |
| `wheelchair-agent hook <events\|list\|add\|enable\|disable\|rm\|rename\|test\|log\|prompt>` | 插口表与脚本的读写；`prompt <事件>` 打印可复制的"叫 agent 加一条"提示词 | `import src/spv/hook.js` |
| `wheelchair-agent where [--json]` | 这套安装把东西装到哪了（数据根、preset、wrapper、队列、日志） | `import src/shared/home.js` |
| `wheelchair-agent check` | **运行时**健康：服务在跑吗、preset 能加载吗、`prepare` 在假环境里能跑通吗 | 见下 |
| `wheelchair-agent --help` / `--version` | 用法与版本 | — |

**没有 `result` 子命令**：worker 的 `reply` / `notice` 由 SPV 会话里的后台注入器
（`src/spv/injector.js`）消费并作为一条新消息推进对话；CLI 只负责派活与看队列，不读结果。

`install.sh --check` 是**另一件事**：装进去的东西 == checkout。两个 check 不重叠，都保留。

实现位置：`bin/wheelchair-agent.mjs`（argv 解析 + `process.exit`），`check` 的四项在
`src/spv/check.js`（纯函数，返回结构化结果，不结束进程）。`dispatch` / `status` 直接 import
`src/spv/{dispatch,outbox}.js`；`prepare` / `jobctl` 用 `exec` 换进程（TUI 要独占终端）；`service`
用 `spawnSync` 等 python 跑完再打提示；`spv` 由 `runSpvSession` 把启动器当受监督子进程拉起，以便
崩溃后按标记重启。

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
- 当时那句"已通过管理 API 保存"是 worker 手动存的一次性动作，不是
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

`spv`、`superagent-service`、`jobctl` 继续作为独立命令存在。`superagent-service` / `jobctl` 是薄
wrapper（`exec wheelchair-agent <子命令> "$@"`）；`spv` 装的是**渲染过的启动器本身**
（`render_launcher` 把 `@SPV_HOME@` 换成 preset 目录），因为 `runSpvSession` 要直接 exec 它、它也要能在
没有部署身份时起一个会话。

由此有一个已知缺口：直接敲 `spv`（而不是 `wheelchair-agent spv`）时环境里没有 `SPV_QUEUE_DIR`，
`service status`/`start` 无法反查该会话属于哪份部署，启动器只能如实报告"不知道属于哪份部署"并提示
改用 `wheelchair-agent spv --project <p>`。`wheelchair-agent spv` 那条路会把身份导出，裸调用照常工作。

理由：worker 的 prompt、`AGENTS.md`、`PROGRESS.md`、`docs/` 里都是按名字引用它们的，改名要同步改一堆
文档，收益只是"少三个文件"。CLI 里的子命令是**规范形式**，独立名字是兼容层。

## 语言：node

队列格式曾经有两份实现（`src/shared/queue.js` 和 `scripts/spv_send.py`），这是个真隐患——两份实现必须
永远保持字节兼容。CLI 用 node 直接 import `src/shared/queue.js`，那两个 Python 脚本已删除，
**实现从两份变一份**。

代价是 CLI 要 `spawn` python 跑 `jobctl`/`superagent-service`、`exec` sh 跑 `prepare.sh`。这不是缺点：
CLI 本来就是门面，门面后面挂异构工具是正常的。
