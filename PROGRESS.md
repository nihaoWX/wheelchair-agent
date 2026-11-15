# Current State

**可用**：SPV 会话与 superagent 服务都已跑通并端到端验证。派活链路
`spv_dispatch` → 文件队列 → superagent Ticket → worker（项目 clone 内执行）→ `outbox`；结果由会话内的
后台注入器（`src/spv/injector.js`）消费后作为一条新消息推进对话，没有 `spv_result`、也没有超时。

- **SPV 会话**：`spv` 命令启动（会自动拉起后端），preset `spv`，cwd = `bioagentforge`。
  工具集 = **普通 dsh 会话的全套标准工具**（文件 / shell / subagent / web / todo / goal / plan-mode /
  skills）**外加** `spv_dispatch` / `spv_status` 与自动投递结果的注入器，斜杠命令 `/spv-cron`。
  `subagent` 用于不需要 PR 的调研；要交付 PR 的代码活仍走 `spv_dispatch`（分工写在 persona 里）。
- **superagent**：常驻服务 `:3082`，`runtime / spv / github` 三处 `ready`，`setup.problem=null`。

**入口**：`wheelchair-agent` 是唯一命令入口（`spv` / `prepare` / `service` / `jobctl` / `dispatch` /
`status` / `inbox` / `check`），`spv`、`superagent-service`、`jobctl` 保留为它的兼容名。
`src/` 已按 `shared/` `superagent/` `spv/` 三分，三条边界规则由 `tests/test-layout.sh` 机械断言。

**审查收件箱 / `wheelchair-agent` 功能宿主**：`webui/` 是独立 dsh client 包 `wheelchair-agent-webui`
（superagent profile 左侧栏一行 `wheelchair-agent`）；核心只有一份 `src/spv/inbox.js`，CLI 与面板共用。
面板是 `main` slot 里的**原生 React 功能宿主**（不是 iframe）：导航列功能，收件箱渲染在带边框的功能面板里
（标题、说明、筛选/刷新工具栏）；审查决定只有 `approve`（通过，不派任务）与 `issue`（有问题，派
`inbox-<pr>` 任务），状态由最新 review 派生，旧 `question`/`fix` 读取时映射成 `issue`，筛选默认待审。
PR 正文由 `lib/client.js` 自带的 Markdown → React 渲染器展开渲染，控件与配色走 host token。
`wheelchair-agent inbox` 现在只打印「面板在 dsh web 里」的指引；`wheelchair-agent inbox watch` 轮询
工具仓的 `gh pr list` 写 `~/.dsh/state/superagent/inbox/`。
Client bundle 由 `dsh-client-hmr` 热更新，不需要为改页面重启服务；Host 侧的新路由/新校验和删除旧的
`/wheelchair-inbox/page` 要等下一次正常重启。

**CI**：`.github/workflows/ci.yml` 在 push 到 `main` 和所有 PR 上跑 `npm run check`、
`bash tests/test-layout.sh`、`sh tests/test-prepare.sh`（无 secret、无安装步）。`main` 分支保护要求
`ci` 检查通过，所以 `gh pr merge --auto` 现在真的会等 CI，不再立刻合并。

# Completed

- **功能宿主 + 原生 React 面板**（2026-11-15，PR #10，分支 `agent/webui-native`）：删除 iframe、
  `pageHtml()`、`/wheelchair-inbox/page` 与独立页；`webui/lib/client.js` 在 `main` slot 渲染功能宿主，
  收件箱是带边框的功能面板（标题/说明/筛选/刷新/行列表）；审查模型改为 `approve`（不派任务）/`issue`
  （派任务），状态由最新 review 派生并兼容旧 `question`/`fix`，筛选默认待审、四档计数；PR 正文由自带的
  Markdown → React 渲染器展开渲染（loose list、深层嵌套上限、图片 alt 链接、三重强调等已覆盖）；只
  require `react` / `react/jsx-runtime`，不 require primitives；样式全走 host token，浅/深色实测。
  `inbox` CLI 改为打印面板位置，`inbox watch` 保留。`install.sh` / `--check`、`npm run check`、
  layout 4/4、prepare 77/77 全绿；approve/issue 的 review 与队列行为用隔离服务验证，:3082 面板实测
  （client-hmr 热更新）并把 pending/issue/approved/筛选/正文截图放进 `webui/docs/`。
- **dsh 锁 `0.2.1-rc.3`**：superagent 的 `engines.dsh` 不满足 `0.2.2-rc.1`；`dsh-tui@0.19.0`
  兼容该版本，两 profile 共用同一全局 dsh。见 `docs/setup/dsh-commandcode.md`。
- **superagent 落地**：clone 到 `tools/dsh-superagent/` 构建；profile `superagent`（stateDir、
  端口 3082、模型 provider 走 commandcode）。`dsh plugin add` 不写 `bundles`，需手动补。
- **GitHub Source**：`nihaoWX/bioagentforge`，CLI `~/.local/bin/gh`，60s 轮询。
- **`spv` Source 插件**（`src/superagent/watch.js` + `src/superagent/spv.js`）：文件队列 pending→done（rename 即消费
  标记，无 cursor）+ outbox；Trigger 满足 explicit 三条件。
- **SPV preset**（`preset/` → `~/.dsh/.agent-presets/spv/`）：普通 dsh 会话的全套标准工具 +
  `spv` 工具（`spv_dispatch` / `spv_status` / 注入器 / `/spv-cron`）。标准行逐字照抄 dsh-tui 的
  liangshen preset；不 vendor 它的本地 `.mjs`（`tool-bootstrap` 等），理由见
  `ARCHITECTURE/decisions.md`。
- **compaction 组**（`compaction-basic` + `command-compact` + `tool-result-pruner`）：TUI 原先
  告警「本预设既无压缩也不剪枝工具结果」。加上后 `/compact` 可用、达水位自动压缩，超长工具输出
  按 8192 字符截断（留头 4096 / 尾 1024）。剪枝器必须与 `compaction-basic` 同 realm（后者用
  `ctx.get('toolResultPrune')` 读它）；`token-meter` 刻意留在 host plane，否则浏览器的上下文
  计量投影会随 preset mount/unmount 来去。
- **SPV 工具**（`src/spv/{dispatch,outbox,paths,health,tools}.js`）：`spv_dispatch` / `spv_status`。
  `actor` 写死 `operator`，不接受参数。`spv_dispatch` 用 `exec.agent` 记住本会话的 agent，
  `spv_status` 非阻塞地列 pending 与未读消息。
  `spv_dispatch` 派活前探健康端点——队列目录在服务停止后仍然存在，只查目录会让任务写进没人读的地方。
- **`superagent-service.py`**：服务启停，不依赖进程名。原先上游脚本用 `ps -o ucomm=` 取进程名，
  WSL2 上 node 报 `MainThread`，于是 `status` 报 `pids: []`、`restart` 说「已在运行」却不重启、
  `stop` 停不掉。改为用监听套接字（`ss -lptnH 'sport = :<port>'`）+ `/proc/<pid>/cmdline` 扫
  `--profile`。日志固定写 `$DSH_HOME/.artifacts/<profile>.log`。`open` 子命令从日志取当前 token
  并调浏览器（WSL 下走 Windows 的 `Start-Process`）。
- **`jobctl`**：长任务交给 systemd user manager 持有。`submit` 用 `ExecStopPost` 让 systemd 在
  unit 停下时写一条任务进 spv 队列，所以下一阶段的触发器是作业自己的结束事件。
- **`/spv-cron`**：每小时递简报的斜杠命令。
- **`install.sh`**：装 preset + `wheelchair-agent` CLI 薄壳 + `spv` / `superagent-service` / `jobctl`
  三个兼容名，白名单拷贝、原子替换、幂等、`--check` 只读自检（含**服务进程**的 PATH 校验）。
- **`tools/` 拆分 21 个独立仓库**：10 个 `git subtree split` 保留历史（tree 哈希逐一比对），
  9 个新建，2 个原有。零失败、零文件丢失。
- **端到端验证**：`spv_dispatch` 投递 → ack → worker 在项目 clone 内执行 → reply "已完成：…"。
- **防冒充验证**：superagent 源码与其 `cordis.patch.yml` 中均无 `spv_*`；两个 superagent preset
  都不含 `spv-tools`。
- **install 验收**：首次装、重跑幂等（`up to date`）、改源后 `--check` = exit 2、还原后 = exit 0、
  已装目录无开发侧文件。
- **交付目标随项目走**（2026-11-14，PR #1 待合并）：`install.sh` 把 `commands/prepare.sh` 与两份
  `AGENTS.md` 模板装进 preset 目录；`prepare.sh` 做 clone → 受管 `AGENTS.md`（缺则加、旧则覆盖）
  → `tools/` 私有远端与工单 `origin`；`research/` 永不配远端。`tests/test-prepare.sh` 77 条断言全过。
- **HARNESS 按架构拆分**（2026-11-14）：`ARCHITECTURE/` 从空目录变成三份分册
  （`decisions.md` / `layout.md` / `cli.md`），`ARCHITECTURE.md` 收缩为概览 + 索引。
- **CLI 化 + 目录重组**（2026-11-14，PR #2）：`bin/wheelchair-agent.mjs` 十个入口；`src/` 三分
  `shared/` `superagent/` `spv/`；`dsh/` → `preset/`、`scripts/` → `commands/` + `build/` + `tests/`；
  删 `index.js` 与两个 Python 队列脚本（队列格式从两份实现变一份）；`install.sh` 装 CLI 薄壳并读
  `/proc/<pid>/environ` 验证服务进程的 PATH；`tests/test-layout.sh` 机械断言三条边界规则。
- **最小 CI + `main` 分支保护**（2026-11-14，PR #5）：`.github/workflows/ci.yml` 的 `ci` job 在
  push 到 `main` 与所有 PR 上跑 `npm run check`、`tests/test-layout.sh`、`tests/test-prepare.sh`
  （无 secret、无安装步）；`main` 要求 `ci` 通过。负向 PR 实测 `--auto` 卡住不合，正常 PR 实测等
  CI 变绿后才由 auto-merge 合入。
- **结果自动注入**（2026-11-14，PR #4）：删除阻塞式 `spv_result`（工具与 `wheelchair-agent result`
  子命令一并删），新增 `src/spv/injector.js`：`ctx.effect` 持有 1s 轮询，任意 thread 新出现的
  `reply` / `notice` 先用 `consumeMessage` 原子消费、再 `agent.followup` 注入会话；没有超时，
  成功与失败都注入。agent 引用来自 `spv_dispatch` 的 `exec.agent`。挂载前的旧结果不注入
  （`spv_status` 仍可见），避免新会话重放积压。`tests/test-injector.mjs` 覆盖基线跳过、
  并发读者只注入一次、同 id 重投不重注入、截断、stop 等在途行为。6 项验收全过：
  `install.sh` / `--check` exit 0；CLI 无 `result`；工具表只剩两个；**真实 SPV 会话派真实工单、
  派完不调任何工具，reply 由注入器消费并作为 user 消息进入会话**（`outbox/` → `outbox/read/`）；
  `node --check` 与三个测试套件全绿。
- **审查收件箱 / `wheelchair-agent` UI 主页**（2026-11-14，PR #8 `agent/webui-inbox`）：`webui/`
  独立包（手写预构建 bundle、`dsh.client`、paired slots）、`src/spv/inbox.js` 核心（item 存储、
  `gh pr list` 轮询、评论→`inbox-<pr>` 任务、跨进程 item 锁）、`inbox` / `inbox watch` CLI、
  `commands/open-url.py` 复用 `open_command()`（2026-11-15 随独立页一起删除）、`install.sh` 的 profile
  包安装与加载器行。面板是 `wheelchair-agent` UI 主页，收件箱是第一个 `SECTIONS` 区块；页面骨架不随区块增加而改。
- **SPV preset 纯增量**（2026-11-14，分支 `agent/spv-standard-tools`）：`preset/agent.cordis.yml` 补齐
  liangshen 的全套标准工具行（`tool-fs-search`、`bootstrap-filesystem`、`tool-jobs`、`tool-goal`、
  `planning`、`delegation`（含 `subagent`）、`tool-ask-user`、`tool-todo`、`tool-web`），`tool-fs` 不再
  只读，persona 写明「subagent 做调研、要交付 PR 的活走 `spv_dispatch`」；并补回 skill 两行
  （`skill-filesystem` + `tool-skill`，内容来自从未进过 `main` 的 PR #3 commit `6f38eef`）。行数
  `^- id:` / `^    - id:` 13 → 37；`install.sh` / `--check` exit 0，`dsh --dump-config` 里新行都落在
  `preset-spv` 块内，三个测试套件与 `npm run check` 全绿。
- **dispatch 可选 `preset`**（2026-11-15，PR #11）：`spv_dispatch` 与 `wheelchair-agent dispatch --preset <id>`
  把 dsh agent preset id 写进任务记录顶层 `preset`，经 `triggerOf()` spread 成 `trigger.meta.preset`，由
  superagent 按工单选 worker preset；省略/空串不写该字段。`checkPreset` 只校验形状
  （`^[a-z0-9][a-z0-9-]*$`），不校验存在性。persona 规定 dsh 插件 / dsh web UI / 面板类任务用 `cordis`
  （创造模式），其余用默认。

# In Progress

- **功能宿主 + approve/issue 面板**（PR #10，分支 `agent/webui-native`）：实现、安装、pending/issues/
  approved/筛选的浏览器实测、approve/issue 的隔离 review/队列验证与 CI 完成；等人工评审/合并。重启服务后
  Host 侧的 approve/issue 才在 :3082 生效。见 `ARCHITECTURE/decisions.md` 的「UI 主页改为原生 React 页面」。
- **SPV preset 纯增量**（PR #9，分支 `agent/spv-standard-tools`）：实现、安装与全套验证完成，CI 已过，
  等合并。见 `ARCHITECTURE/decisions.md` 的「SPV preset：普通 dsh 会话 + `spv_*`」。

# Known Issues

- **运行中的 superagent Host 仍是旧代码**：client bundle 已通过 `dsh-client-hmr` 热更新，所以新功能宿主、
  筛选、新状态徽章在 :3082 可见；但 `appendReview` 的 `approve`/`issue` 校验与 Host 路由要等下一次重启才
  生效（重启会杀掉执行中的 worker）。重启前在面板点「通过 / 有问题」会得到 400；review/队列行为已用隔离
  服务验证，UI 的 POST 载荷用拦截验证。下一次正常重启后生效。
- **运行中的服务仍注册着旧的 `/wheelchair-inbox/page` 路由**：Host 代码已从 checkout 删除并装进
  profile，但服务进程没有重启。新面板不依赖它；下一次正常重启后该路由消失。
- **共享 preset 会被并发 worker 的 `install.sh` 覆盖**（2026-11-14 22:55 实测）：另一个 worktree 把
  `~/.dsh/.agent-presets/spv/` 换成不含 inbox 的版本，`wheelchair-agent inbox` 暂时消失。webui 包已
  自包含（core 文件拷进 profile 包，不依赖 preset），但 CLI 仍来自 preset；从本 checkout 重跑
  `bash install.sh` 即恢复。
- **收件箱里 `nihaoWX-wheelchair-agent-1` 有一条端到端测试评论**（22:40）并派生了 ticket
  `ae0c851…`（thread `inbox-1`，worker 回复“收到。”）。这是验证留下的真实数据，不是缺陷。
- **探针仓 `nihaoWX/zzz-prepare-probe` 未删**（空、私有）：`gh repo delete` 需要 `delete_repo` scope，
  `gh auth refresh` 要操作者在浏览器里走 device code。
- **`docs/PITFALLS/` 里没有待处理报告**：R1/R2 已消费入账（`R1-F1` / `R2-F1`，裁决见 `R3-F1` /
  `R3-F2`），报告按流程删掉了。原文随时可取回：
  `git show 7dae586:docs/PITFALLS/wheelchair-agent-建议-仓库随项目走.md`。
- **主会话固化第一次的 model 路由**：`initializeRoleModel` 不覆盖已有 `model/selection`。换 provider
  后需删 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应
  `session_projcache`。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，superagent 加载失败。需手动降回并带
  `--allow-scripts`。
- **worker 的目录约束靠自觉**：prompt 未限制它只能在 ticket 目录内改动，冒烟测试时它曾
  `find /home/nihao` 找到真实项目路径。
- **压缩时机仍未解决**：需要「已用 20% + 小阶段完成」的判断，要模型介入。
- **`spv` Source 的 `scope()` 未实现**：默认接收自己产生的全部 Trigger，够用于 explicit。
- **注入器只投递「挂载之后」的结果**：会话启动时已在 `outbox/` 里的旧 reply/notice 不注入、不消费
  （否则新会话重放积压）；`spv_status` 能看到它们，但没有工具把它们推进对话。若两个 SPV 会话同时
  在线，两边注入器会争同一条新消息：`consumeMessage` 的 rename 只有一个成功，失败的一方不注入，
  所以不会重复；但哪个会话拿到结果是先到先得——仍按「一次只开一个入口会话」使用。
- **额度共享**：Eval + worker 都走 GOAT，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口；`maxWorkers=2`。
- 每个拆出的子仓库用 `.git/info/exclude` 复制忽略规则，不改项目内 `.gitignore`。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 既有未提交修改，未触碰。
- **`~/.dsh/profiles/dsh-tui/node_modules/wheelchair-agent` 是 11-12 的真实目录副本**（不是软链，
  只有 4 个文件），无任何 yml 引用它。仓库外，由 SPV 处理。

# Next Steps

1. **合并 PR #9**（SPV preset 纯增量，`agent/spv-standard-tools`）；合并后重启 SPV 会话即生效。
2. **重启一次 superagent 服务**（`wheelchair-agent service restart`），确认 :3082 左侧栏出现
   `wheelchair-agent` 并打开面板（PR #8 已合并）。
3. **面板的 prepare 值已改成 `wheelchair-agent prepare`**（2026-11-14，经管理 API 保存，revision 8）。
   换机器或换 `DSH_HOME` 后重跑 `wheelchair-agent check` 确认它仍然正确。
4. 给 `tools/` 下缺远端的那 15 个项目建私有 GitHub 仓库（操作者自己的事，不是 agent 的）。
5. 收缩 worker 的目录约束（prompt 层或项目 `AGENTS.md`）。
6. 视消耗决定是否给 worker 换更便宜的模型。
7. 稳定后再考虑 `accept mode` 从 `observe` → `auto`。

日常命令：

```bash
wheelchair-agent service start     # 起后端（幂等；已在跑则直接报告）
wheelchair-agent service status    # exit 0 正常 / 1 未跑或异常 / 2 组件报错 / 3 等 setup
wheelchair-agent service restart   # 改过 spv Source 或 provider 配置后
wheelchair-agent service open      # 在浏览器打开带 token 的面板（token 每次启动都变，别复制旧的）
wheelchair-agent spv               # 起 SPV 会话（会自动拉起后端）
wheelchair-agent check             # 运行时健康：服务 / preset / 面板 prepare 值 / prepare dry run
```

`spv`、`superagent-service`、`jobctl` 仍然可用：它们是 `wheelchair-agent <子命令>` 的兼容名。

**面板的 token 每次启动都变**，且 `dsh web` 没有固定 token 的开关。裸 `url:` 打开只会得到
`dsh web authentication required`。用 `superagent-service open`，或从 `status` 的 `panel:` 行取当前地址。

改 `provider/`、`src/`、`preset/`、`commands/`、`bin/` 之后：重跑 `bash install.sh`（幂等）；
改 `dsh-superagent/` 之后：`pnpm build` + `wheelchair-agent service restart`。

# 长任务

worker 的回合结束后，它留下的 shell job 最多再跑 30 分钟就被杀（`src/executor/dsh.ts` 的
`BACKGROUND_LIMIT_MS`），所以长时间分析不能留在 worker 会话里。

`jobctl` 把作业交给 systemd 的 user manager 持有：

```bash
jobctl submit --name md-001 --project research/xxx --thread md-001 \
              --next "读 results/md.log，分析稳定性并写报告" -- ./run_md.sh
jobctl status [unit...]
jobctl log md-001
jobctl verify --ticket <id>     # 机械证伪「worker 说它提交了」
jobctl cancel md-001
```

**下一阶段的触发器是作业自己的结束事件**，不是 worker 的自觉、不是全局 goal 状态、也不是定时轮询：
`ExecStopPost` 由 systemd 在 unit 停下时执行，写一条任务到 spv 队列。整个交接没有任何 agent 参与，
所以 worker 忘记、会话关闭、agent 重启都不影响它。

`jobctl` 自己记 `~/.local/state/jobctl/ledger.jsonl`，因为 `--collect` 会让结束的 unit 从 systemd
消失；`verify` 同时查 systemd（机械事实）与账本（跨越 collect）。

## `/spv-cron`

每小时给 SPV 递一份简报（斜杠命令，模型与 worker 都碰不到）：

```
/spv-cron              # 开启，默认 60 分钟
/spv-cron every 30     # 改频率（5–1440）
/spv-cron status
/spv-cron off
```

两档简报：
- **无异常** → 轻推「推进用户任务」，不报警
- **有异常** → 点名具体的失败/停住的 unit，要求派子 agent 用 `jobctl status` / `log` 检查

因此「worker 压根没把作业挂上去」这种情况，顶多一小时内会被发现。

定时器由插件自己持有，不用 `dsh-schedule`——后者需要 Web 组合的 Session controller，文档明说不能
在仅 SDK/headless 下单独挂载，而 SPV 跑在 dsh-tui 下。**代价**：会话关掉巡检就停（可以接受，
因为没有会话就没人接收简报）。
