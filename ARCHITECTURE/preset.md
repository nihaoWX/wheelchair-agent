# SPV preset

一个独立于 superagent 的 dsh agent preset：你在终端里和它对话，它把活派给后台的 superagent，worker 的结果会自己回到对话里。

两套东西**严格分开**：

|  | SPV（这里） | superagent（既有） |
|---|---|---|
| 是什么 | dsh agent preset（`dsh-tui` profile 里的一个会话组合） | 另一个 profile 里常驻的后台服务 |
| 谁对话 | 用户 | 无人 |
| 工具集 | 普通 dsh 会话的全套工具 + `spv_*` | `orchestrator_*` |
| 通道 | 只有文件队列 `~/.dsh/state/superagent/spv/` | |

SPV 侧不 import superagent 的任何代码。两侧唯一的接口是队列里的 JSON 文件：SPV 写 `pending/`，superagent 的
`spv` Source 取走并写 `outbox/`，SPV 会话内的注入器（`src/spv/injector.js`）从 `outbox/` 取走并推进对话。

## 装

`install.sh` **只做冷安装**：它要写 preset 目录、`~/.local/bin` 与 superagent profile 的 `node_modules`，
而 superagent 服务或一个活着的 SPV 会话可能正持有这些文件。占用时它会拒绝，不会写一半（见下面的
「冷安装：占用时拒绝」）。

```sh
bash tools/wheelchair-agent/install.sh          # 冷安装 preset、CLI 与兼容命令
bash tools/wheelchair-agent/install.sh --check  # 只读自检，任一不满足 exit 2；运行时也允许
```

装这些东西：

1. `~/.dsh/.agent-presets/spv/` —— 渲染出的 `preset.yml`、`agent.cordis.yml`、`preset-default.patch.yml`、
   `cli.js`、`src/{shared,spv}/`、`commands/`、`prepare.sh`、`spv-launcher.sh` 与 `agentsmd-examples/`。
   这个目录就是「SPV 侧的已安装包」；superagent 侧的 `src/superagent/` **不在**里面（那个 profile 用
   自己的 `node_modules` 软链加载它）。
2. `~/.local/bin/wheelchair-agent` —— 唯一入口（薄壳，把 preset 目录烧进去后 `exec node <preset>/cli.js`）
3. `~/.local/bin/{spv,superagent-service,jobctl}` —— 兼容名，每个都是 `exec wheelchair-agent <子命令> "$@"`

### 冷安装：占用时拒绝

安装前先探测两类运行时占用，复用 `commands/superagent-service.py probe` 而不是另写一份进程查找：

- **superagent 服务**：监听端口（`ss -lptnH 'sport = :<port>'`）+ `/proc/*/cmdline` 里的 `--profile superagent`；
- **活着的 SPV 会话**：`/proc/*/cmdline` 里带 `--patch <preset>/preset-default.patch.yml`。它只认安装器
  启动器起出来的会话（或 dsh/dsh-tui 带同一个 `--patch` 的进程）；用 `/preset` 在无 `--patch` 的会话里切过来、
  或换了 `DSH_HOME` 的会话认不出——宁愿漏报也不凭猜测拒绝。

占用时：

- **不写任何安装目标**（preset 目录、`~/.local/bin`、profile 的 `node_modules` 都不创建、不替换）；
- 打印占用者（服务 pid/端口、SPV 会话 pid）以及停止 / 安装 / 重启的**可照抄命令**；
- 退出码 **3**（`1` 是安装失败，`2` 是 `--check` 失败）；
- 往 SPV 的 `outbox/` 写**一条** `kind: "notice"`（id 由阻断者派生：同一组阻断者重跑只留一条，换了阻断者才是
  新通知），让 SPV 会话知道需要冷安装、被什么挡住、下一步跑什么。队列目录不存在（服务从没跑过）时跳过通知、
  只打印一行，退出码仍是 3。

所以改 preset / CLI 的流程变成：**先停服务、退出 SPV 会话，再 `install.sh`，最后重新启动**。服务运行时硬装一个
半新不旧的 CLI 比拒绝更糟：2026-11-15 服务在跑时 `install.sh` 报 “up to date”，但装着的
`~/.dsh/.agent-presets/spv/cli.js` 是旧的 14943 字节、没有 `inbox` 子命令，第二次运行才修好。

`--check` 始终只读、始终允许；它把占用者作为 `note:` 报出，不拒绝，也不创建任何东西。它和安装共用同一个探测，
所以 `python3` 缺失时按检查失败处理（exit 2），与 `wheelchair-agent service` 的前置一致。

装完会打印面板要用的 prepare 命令：

```sh
wheelchair-agent prepare
```

把它填进面板的 Settings → Execution → Prepare command。**是命令名，不是绝对路径**：面板值存在
superagent 的 sqlite 里，`install.sh` 管不到它，绝对路径会在换 `DSH_HOME` / 换用户名后静默失效。
`install.sh --check` 会读服务进程的 `/proc/<pid>/environ`，确认 `~/.local/bin` 在那个 PATH 里。

`prepare` 负责 clone 项目、按项目类型装受管 `AGENTS.md`、给 `tools/` 项目建私有 GitHub 远端并把工单的
`origin` 指过去；`research/` 永不配远端。可跑证据是 `tests/test-prepare.sh`。

### 受管 `AGENTS.md` 与私有远端的六条约束

`prepare` 会创建外部状态（远端仓库），也会覆盖 `AGENTS.md`，所以它的行为不是可选项：

1. 补齐远端时**只建 PRIVATE**，永不创建公开仓库。
2. 创建远端属于外部状态，必须可追溯：仓库名、可见性、归属都要有确定来源；失败要说清哪一步没成，
   不许"继续往下走"。
3. `research/<name>` 是 local-only：永不给它配远端、永不 push。脚本必须能区分"该有远端"与"不该有"，
   不能对所有缺 remote 的项目一视同仁。
4. 每张工单的工作副本都带一份与项目类型匹配的 `AGENTS.md`（worker 读不到工作区根目录的约定）。
5. 那份 `AGENTS.md` 是受管的：**缺失即补、过期即覆盖**，不做合并——否则旧副本会长期压过新规则。
6. 模板来自**已安装**的 preset（`~/.dsh/.agent-presets/spv/agentsmd-examples/`），不写死开发树路径。

前置：`dsh-tui` 在 `PATH` 上、`node` >= 22、`python3`（服务管理与冷安装探测）。缺了 `install.sh` 会 FAIL
并给获取方式。

## 起

```sh
wheelchair-agent spv    # 在 bioagentforge 根目录下运行（SPV 的 AGENTS.md 从 cwd 读）
spv                     # 同一个东西的兼容名
```

`spv` 等价于：

```sh
DSH_TUI_PRESET=spv dsh-tui --patch ~/.dsh/.agent-presets/spv/preset-default.patch.yml
```

不想用启动器时，在任意 dsh-tui 会话里 `/preset spv` 也能切过去（需要那一次启动带上同一个 `--patch`）。

## 用

SPV 挂的是**普通 dsh 会话的全套工具**再加三个自己的：文件（`read` / `write` / `edit` / `glob` / `grep` /
`str_replace_editor`）、`bash`、`subagent` / `subagent_fork`、`todo_write`、`web_search`、`goal`、
`ask_user_question`、后台作业、skills、plan mode、`/compact`。写文件与跑命令都能用，但**交付**仍然只有一条路：
改代码并需要 PR 的活走 `spv_dispatch`，派给 worker；`subagent` 用于不落盘、不出 PR 的研究与查询。
这个分工**只写在 `spv_dispatch` 的工具描述里**，不靠少给工具来约束，也**不写 persona**：SPV 的系统提示词
与普通 dsh 会话完全一致（操作者 2026-11-18 定案，`tests/test-preset.mjs` 守着这条）。

会话里让 agent 干活即它自己会调两个 spv 工具：

| 工具 | 参数 | 行为 |
|---|---|---|
| `spv_dispatch` | `project`（`tools/<name>` 或 `research/<name>`）、`task`、`thread?`（默认 `main`） | 写 `pending/`，立刻返回 `{id, thread, project}`；worker 的答复稍后自己回到该 thread |
| `spv_notify` | `title`、Markdown `body`、`thread?`（默认 `main`） | 往操作者的审查收件箱写一封 `spv_message` 决策信并返回 `{id, thread}`；不派 worker、不等待答复 |
| `spv_status` | `thread?` | 非阻塞：`pending/` 里没被取走的任务 + 已到未读的消息 |

`spv_notify` 不派活：它把 SPV 在无人看管时自己做出的决定写成一封 `spv_message` 信，放进操作者的审查收件箱
（`wheelchair-agent` 面板）。操作者之后在面板里**通过**或**质疑**；质疑会作为一条 `notice` 回到这封信的
thread，让 SPV 回顾当时的判断。

任务文件里的 `actor` 固定是 `operator`，**不是** `spv_dispatch` 的参数 —— 见 `src/spv/dispatch.js` 里
`ACTOR` 的注释。

### 结果怎么回来

**结果不是工具调出来的：模型没有任何「读结果」的动作，也没有超时。** 结果由 `src/spv/injector.js` 在后台推回来：

- 插件每个 tick 扫一次 `outbox/`，把**挂载之后**才出现的 `reply` / `notice` 各注入成一条新的 user 消息，
  所以它出现在当前这条对话里，模型与用户都看得到；
- 注入前先用 `consumeMessage` 把消息 rename 进 `outbox/read/`。只有真正搬走文件的那次调用拿到 `id`，被别的
  读者抢先的调用拿到 `undefined` 并跳过；同一个 `id` 被重发（`outbox/read/` 里已有同名副本）时只消费、
  不再注入——所以一条结果只注入一次；
- `reply` 是结果（worker 完成了），`notice` 是 worker 停了或需要决策，两种都会注入；
- **没有超时**：插件挂着就一直等，只有会话关闭（插件卸载）才停，模型不需要、也无法轮询；
- 正文超过 12000 字符会截断，注入文本末尾给出 `outbox/read/` 里那条消息的完整文件路径；
- 挂载前就在 `outbox/` 里的旧结果**不会**被注入（否则新会话会重放一堆积压），它们仍留在磁盘上，
  `spv_status` 能看到。

同样的两个子命令在命令行上也有，供手动调试与脚本使用（`dispatch` / `status` 直接 import
`src/spv/*.js`，不 spawn 子进程，所以队列格式只有一份实现）：

```sh
wheelchair-agent dispatch --project tools/foo --task "..." --thread t1
wheelchair-agent status [--thread t1]
wheelchair-agent inbox add --title "决定" --body "正文 / @文件" [--thread t1]
wheelchair-agent where [--json] # 只读列出数据根、preset、四个 wrapper、webui 包、checkout、队列、work root、日志与面板 URL
wheelchair-agent check          # 运行时健康：服务 / preset / 面板 prepare 值 / prepare dry run
wheelchair-agent work gc --dry-run   # 回收可重建的 ticket 克隆；挂载时同一实现自动跑一次
wheelchair-agent work restored <ticket>  # 从 work-reclaimed.jsonl 打印重建命令
wheelchair-agent restart-all --dry-run   # 重启计划：服务 pid、SPV 链、会话租约持有者、checkout、日志与每一步命令
wheelchair-agent restart-all             # 停服务 → 停 SPV 链 → 冷安装 → 起服务 → 本终端重开 TUI
wheelchair-agent session release --dry-run          # 默认 resume.txt 的会话（否则 workspace 最新）：列出内核 fd 持有者
wheelchair-agent session release --session <id>     # 释放卡住的会话租约（TERM → 等待 → KILL；服务持有时拒绝）
```

`work gc` 的门禁与记录格式见 `ARCHITECTURE/work-gc.md`。

### 重启整套部署

`/restart-wheelchair-agent` 是这条命令的会话内入口：它只做守卫检查、arm 一个 detached orchestrator，
然后告诉你会话即将结束。真正干活的 `wheelchair-agent spv` 终端**不会关**：它 tail
`<root>/logs/restart-all.log`（默认 `~/.wheelchair-agent/logs/restart-all.log`）、逐行打印重启步骤（去掉时间戳；`restart-all:` 开头的内部行不进终端），完成后
在**同一终端**重新拉起 TUI，并用 `~/.dsh-tui/resume.txt` 里的 session id（唯一来源；trim 后必须是 UUID）
`--resume` 回到**同一个 SPV 对话**。操作者第一次启动的参数保持原样，但**重启时的重新拉起会先丢掉旧的**
`--resume`/`-c`/`--continue`（旧 id 会进错会话，裸 `-c` 在 resume.txt 不可用时会直接退出），一律以
resume.txt 为准。文件缺失/不可读/内容不是 id 时只打印一行说明，然后开新会话（不会卡死）；dsh-tui 拒绝
resume 时再打印一行，去掉 `--resume` 重试一次。tmux session `dsh-spv` 只是**兜底**：那个终端已经没了
（关掉，或 CLI 随 TUI 一起退出）时，编排器等一小段时间拿不到 claim 就退回 tmux，兜底同样带 `--resume`；
没有 tmux 时 claim 成功照样不报错，没人 claim 才失败退出。兜底文件出现**不算成功**：只有日志里的
`restart complete (exit 0)` 才算，tmux 没起来会按失败退出。首次升级后的第一个旧会话没有 supervising
`wheelchair-agent spv`，只能从 tmux 回来；之后重新开一个 `wheelchair-agent spv` 才有原地返回。
`/update`、`/restart`、`/backend` 交接会结束 supervising CLI，要再开一次 `wheelchair-agent spv`；
不要给 `wheelchair-agent spv` 传 `--patch`，否则 CLI 自己进 kill chain，叙述者就没了。重启顺序固定为
**服务停止 → SPV 链 SIGTERM/等待/SIGKILL →
`install.sh` 冷安装 → 服务启动 → 本终端重开 TUI**；这个顺序是 `install.sh` 的冷安装守卫唯一接受的
（服务或活着的 SPV 会话占用时它会拒绝，且半安装的服务比停着的服务更糟）。它只接受 `--force`：打断
正在跑的 worker 与排队的 ticket（会先打印打断了什么）。安装失败或服务起不来时只打印原因、日志路径和
手工修复命令，不 relaunch。

kill set 不只按 `--patch` 认进程：还会扫 `/proc/<pid>/fd`，把**内核**认定的会话租约持有者
（`<session dir>/session.lock` / `session.v4.jsonl.zstd` 的打开 fd）一并算进去；链杀完之后等待这些 fd
关闭（`WHEELCHAIR_RESTART_LEASE_MS`，默认 15s），打印 `restart: waiting for pid <pid> to release the
session…`。等不到就**不带 `--resume`** 开新会话，并打印 `restart: the previous session is still mounted
by pid <pid>; starting a fresh session`，所以不会再撞上 dsh-tui 的 "mounted by another TUI terminal" 而掉进
safe-mode。服务停掉之后、链杀之前，如果 `tmux has-session -t =dsh-spv` 成功还会先
`tmux kill-session -t =dsh-spv` 清掉上次兜底留下的陈旧会话（失败只警告；CLI 自己在 `dsh-spv` 里时绝不杀）。
手工处理卡住的租约用 `wheelchair-agent session release [--session <id>] [--dry-run]`：默认取
`~/.dsh-tui/resume.txt` 里的会话（与 restart-all 同样跨项目解析）；resume.txt 有 id 但找不到目录时直接失败，
不会改挑别的会话；只有 resume.txt 缺失/无效/不可读时才退回当前 workspace 最新的会话。
`--dry-run` 列出 `pid <pid>  <cmdline>` 与目录，并标记不会发的持有者（服务/本进程/祖先），不加时按
TERM → 等待 → KILL 释放。持有者只有本进程/祖先链时拒绝；任何持有者是 superagent 服务时整体拒绝
（`--dry-run` 会标记 `(superagent service; not released)`）——服务不是本命令该停的，跳过它又会留下锁；
跳过的本进程/祖先在其余持有者释放后仍持有租约时报告 `FAIL` 并退出 1，不谎报 `released`。
每一步连同命令与退出码写进 `<root>/logs/restart-all.log`（默认
`~/.wheelchair-agent/logs/restart-all.log`）。详见 `ARCHITECTURE/restart/order.md`（顺序）与 `restart/operations.md`（日志）。

## 标准工具从哪来

`agent.cordis.yml` 里的标准行照抄 dsh-tui 的 `liangshen` preset（同一个 dsh 版本的参考组合），连
`disabled: !!js` 条件与 `isolate` realm 一起抄——那些条件按平台、按已安装的包决定某一行挂不挂，写错会让
preset mount 失败，而失败只表现为 "never started"。

刻意没有抄的四个 preset 本地插件（`tool-bootstrap.mjs` / `instruction-hint.mjs` / `skill-search.mjs` /
`custom-bash.mjs`）：它们是 dsh-tui 包里的 `.mjs` 文件，不是 dsh 包。要挂就得 vendor **6 个**文件进本仓库——
这 4 个加 `compaction-epoch.mjs` 与 `session-events.mjs`（`tool-bootstrap.mjs` 引 `compaction-epoch.mjs`，
`instruction-hint.mjs` 引两者，`compaction-epoch.mjs` 又引 `session-events.mjs`）。
而且前两个与 SPV 的既定行为冲突：`tool-bootstrap` 把首轮工具表压成 `bash` + `str_replace_editor`（首轮就没有
`spv_dispatch`），`instruction-hint` 替换掉完整的 AGENTS.md 注入。skill 用 dsh 包
（`skill-filesystem` + `tool-skill`），不用 `skill-search`。

## 模块解析（改这个 preset 前必读）

`agent.cordis.yml` 里 `spv-tools` 行的 name 是 `@SPV_PLUGIN@`，安装时替换成
`file://<安装目录>/src/spv/tools.js`。**不能**换成 `wheelchair-agent/spv-tools`：

- preset 的声明来自 dsh profile 的 patch 层，那一层的模块解析基址是 profile 目录；
- `@deepseek-ai/*` 解析得到（它们在 dsh 的安装树里，有解析器兜住），但 `wheelchair-agent` 不在，
  会 `MODULE_NOT_FOUND`；
- 失败表现是 `spv-tools (...): never started`，只有这一行，没有根因。

同一个原因，`preset-default.patch.yml` 里的 `plugins:` 是从 `agent.cordis.yml` 直接内联生成的，而不是用
`@deepseek-ai/cordis-plugin-include` 指过去 —— 在本机测过的 dsh 0.2.1-rc.3 + dsh-tui 0.19.0 上，
preset 声明里的 include 行不挂载子行，也不报错。

改了 `preset/`、`src/`、`commands/` 或 `bin/` 里的东西，要**先停服务、退出 SPV 会话，再重跑 `install.sh`**
才会生效：占用时它会拒绝（exit 3）而不是写一半。

---

## 配置现状（superagent profile）

| 项 | 值 |
|---|---|
| GitHub Source | `nihaoWX/bioagentforge`，CLI `/home/nihao/.local/bin/gh`，60s 轮询 |
| spv Source | `<stateDir>/spv/` 文件队列，2s 轮询，健康条目 `spv` |
| Policy allowed | github=`nihaoWX`；spv=`operator`（写死在 `src/spv/dispatch.js`，不接受参数） |
| accept mode | `observe`（只影响 inferred 候选；explicit 请求始终直接接单） |
| 模型路由 | `commandcode` / `deepseek/deepseek-v4-pro`（profile 的 `agent-default-model`） |
| executor.directory | `/home/nihao/.dsh/state/superagent/work` |
| executor.maxWorkers | 2 |
| executor.prepare | `wheelchair-agent prepare`（**命令名，不是绝对路径**；见 `ARCHITECTURE/cli.md`） |
| 面板 | `http://127.0.0.1:3082/?token=<日志里的 token>` |

`prepare` 项目选择：项目名随任务走（`spv_dispatch` 的 `project` 参数 → Trigger 的 `project` →
`DSH_SUPERAGENT_SPV_PROJECT`）。`/home/nihao/bioagentforge/.superagent-project` 只作非 spv 任务的兜底；
两者都没有时 Ticket 会在 prepare 阶段失败（设计如此）。
