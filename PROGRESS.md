# Current State

**可用**：SPV 会话 + superagent 服务端到端跑通。链路
`spv_dispatch` → 文件队列 → Trigger → superagent 主 Session（评估/路由）→ Ticket → worker（项目 clone 内执行）
→ `reply` 写回队列 → 会话内注入器作为新消息推进对话。没有 `spv_result`、没有超时。

**入口**：`wheelchair-agent` 是唯一命令（`spv` / `prepare` / `service` / `jobctl` / `dispatch` / `status` /
`inbox` / `work` / `restart-all` / `session` / `hook` / `where` / `check`）。`spv`、`superagent-service`、
`jobctl` 是它的兼容薄壳。

**数据根**：`~/.wheelchair-agent/`（`settings.json`、`inbox/`、`records/`、`logs/`），与 superagent 不耦合；
队列当前在 `~/.dsh/state/superagent/spv/`（单部署），superagent 自己的 state 在 `~/.dsh/state/superagent/`。
**一仓一部署**（`INSTRUCTIONS.md`）正在实现：注册表 `~/.wheelchair-agent/deployments.json` 决定
`project → 部署`，队列随之归各部署自己；见 `ARCHITECTURE/deployments.md`。

**面板**：dsh web 里左侧栏 `wheelchair-agent`（功能宿主，不是 iframe），当前三个功能——收件箱、设置、
插口（hooks 的只读视图）。`webui.style` = `fluid`（默认）/ `minimal`；各页共用 1200px 宽度变量，
收件箱无左侧日期栏。
面板 URL 每次服务重启都换 token，只能从 `wheelchair-agent service status` 的 `panel:` 行或
`wheelchair-agent service open` 取（见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`）。

**服务**：当前跑在用户级瞬时 unit `wca-svc.service`（app.slice，不在任何 logind session scope 里），
不是从终端直接起的 tmux server。`wheelchair-agent service stop/start` 会把它拉回调用者 scope，慎用。

**插口（hooks）**：stage 1（`#28`, `27d4463`）、stage 2（`#29`, `2788bbc`）、stage 3 面板「插口」
（`#30`, main `35be1f5`）都已合并；新 host 需要一次冷安装才带 `hookView` 与第三段。
`#40`（`dcc9dc4`）加了第一个**服务侧内建效果** `builtin:archiveSession`：`ticket.delivered` 之后归档
`worker-<ticketId>`（有 running/stopping job 跳过，失败只 warning）；`#41`（`82b0d3d`）加第二个
`builtin:autoMerge`（五道闸门全绿才 `gh pr merge --squash --delete-branch`，开关 `merge.autoMerge` 默认关）。
两个都要冷安装才生效。

**SPV 系统提示词**：与普通 dsh 会话完全一致——preset 里已无 `persona` 行；派单契约（不自己实现、交付走
`spv_dispatch`、不等不轮询、复用 thread、插件/面板传 `cordis`、只转述 worker 说的）全在 `spv_dispatch`
的工具描述里，由 `tests/test-preset.mjs` 守着。

**Rust 核心**：`crates/wca-core` → `wheelchair-agent-core`（独立进程，JSON over stdin/stdout）。
已搬三个模块：`work-plan`（工单规划/回收，`src/shared/work.js`）、`queue-op`（队列原语，`src/shared/queue.js`）、
`schema-check`（校验器求值，`src/shared/schema.js`）；JS 侧只剩调用壳，**没有 JS 兜底**，唯一的进程桥是
`queue.js` 里的 `runCore`。
构建：`bash build/build-core.sh`（需 cargo）；`install.sh` 把它装到 `~/.local/bin`，从不跑 cargo。
边界与待办见 `ARCHITECTURE/core.md`。

**HARNESS 结构**：构建规则只在 `ARCHITECTURE` 里。`ARCHITECTURE.md`（5.4KB）只留定义 + 分册索引 +
角色与信息流；分册为 `boundaries` / `cli` / `layout` / `decisions` / `hooks` / `restart` / `spv-source` /
`work-gc` / `preset` / `delivery` / `webui/{index,settings,hooks,screenshots}`。`docs/` 只剩
`PITFALLS/`、`setup/`、`agentsmd-examples/`。`INSTRUCTIONS.md`（操作者维护、最高权威）与 `docs/agentsmd-examples/*.md` 已入 git（`4714fb0`、`b1d3d06`）。

# Completed

- **一仓一部署 stage 2 第二片（`#45`,`d9115a5`）**：`restart-all --project <p>` 与
  `/restart-wheelchair-agent --project <p>` 只停/起那一份实例、不跑 install、只 resume 该部署自己的会话
  （`--session` → 该 stateDir 的 `deployment-session.json`，**绝不**读全局 `~/.dsh-tui/resume.txt`）；
  实例匹配抽成纯函数 `selectInstanceProcesses()`（profile + `--patch` 双条件）；`service status` 在多份部署时
  追加 `deployments:` 段。我手验纯函数：a.yml → 只有 a 那一个 pid、旧无 patch 服务 → 只有旧 pid、
  `dsh plugin` 与别的 profile 都不命中；`npm test` 373 PASS/0 FAIL。stage 2 到此完成，剩下的是操作者起第二个实例。
- **Rust 核心第三步（`#47`,`a7147ff`）**：`settings` 的数据模型搬进 `wheelchair-agent-core`（新 `settings`
  子命令：键表/默认值、`filled` 只补一次、合并优先级、校验、`revision` 语义），`src/shared/settings.js` 只剩
  文件与 HTTP 面 + `runCore(['settings'], …)`；`webui/lib/*` 未动。门：`tests/test-settings.mjs` 零改动、
  `npm test` 377 PASS/0 FAIL、`cargo test` 46 passed。我另做了逐字对比：`defaultValues()`、缺键
  `settings.json` 的解析结果、写回字节、stale-revision 与非法值的错误文案，改动前后 **IDENTICAL**。
  注意：装之前要先 `bash build/build-core.sh`（`install.sh` 从不跑 cargo）。
- **一仓一部署 stage 3（`#46`,`e32b0e6`）**：收件箱 watcher 只轮询本实例注册表条目对应的项目（归属靠
  `queueDir` 对上运行实例、`src/spv/ownership.js`，读不到注册表就退回旧的全量行为并记一行降级），别家项目
  的 PR 不再被重复 `pull`/发通知；审查别家 PR 的结果以 `kind: "review"` 消息转发到**拥有它的**部署队列
  （`thread: inbox-<pr>`、稳定 id 幂等），接收侧注入文本标明"转来的审查结论"。`npm test` 377 PASS/0 FAIL。
  一仓一部署三阶段到此全部实现。
- **一仓一部署 stage 2 第一片（`#44`,`a83f2b5`）**：每部署一份实例 overlay
  `<data root>/deployments/<slug>.yml`（端口 + `dsh-superagent` 的 stateDir + `wheelchair-spv` 的 queueDir），
  `deployment add`/`install.sh --project` 共用 `renderInstance()`；`writeInstance()` 只在文件不存在时创建。
  `service … --project <p>` 按注册表找实例文件、端口、会话（`wca-<slug>`）与日志，只动那一份；不带 `--project`
  时逐字沿用旧行为。`commands/superagent-service.py` 的进程匹配从 profile 细化到「profile + `--patch` 文件」。
  我自己验：`dsh --profile superagent --patch <实例文件> --dump-config` 真的把 `port: 3099`（516 行）、
  `stateDir`（1283 行）、`queueDir`（1484 行）套进去了；`deployment add` 幂等、`--queue-dir` 不一致
  `exit 2`、手改注册表 `exit 1`；`npm test` 368 PASS/0 FAIL。
- **一仓一部署 stage 1 收尾（`#43`,`07c9b24`）**：注入器改用 `resolveRoots()` 每轮解析**所有**部署队列
  （显式 `queueDir`/`$SPV_QUEUE_DIR` 仍然独占一根），去重身份是「队列根 + 文件名 + thread」、每根各自取基线，
  新 `deployment add` 的部署在运行期被接上且不重放积压；`spv_status` 按部署分组（`project` 参数只看一份），
  注册表不存在时输出与旧版逐字相同。我实测：三个根（两个部署 + 旧规则根）各投一条 reply → 三条都注入一次，
  随后再向其中一个队列追加一条 → 也注入，共 4 条不重复。
- **一仓一部署 stage 1（`#42`,`4a24e4f`）**：注册表 `~/.wheelchair-agent/deployments.json`（项目 → 部署，
  坏文件报错且一字不改、原子写入）+ `wheelchair-agent deployment list|add|remove|migrate` +
  `dispatch`/`spv_dispatch` 按注册表写对应部署的队列（缺条目报错并指路 `deployment add`，绝不自动建）+
  `install.sh --project` 装成功后记账（`--check`/`--fingerprint` 只读）。注册表不存在时行为逐字不变，
  所以升级本身不改变任何现有行为；`deployment migrate` 才切换到分部署模式。
- **交付后自动合并（`#41`,`82b0d3d`）**：内建效果 `builtin:autoMerge` 挂在 `ticket.delivered`，用
  `work-plan` 找到工单 clone → 分支名 + `remote.origin.url` → `gh pr list --head <branch>` 反推 PR；
  五道闸门（唯一 open PR 且 head 匹配 / 非 draft / `MERGEABLE` / `statusCheckRollup` 非空且全 SUCCESS /
  files 不含 `ARCHITECTURE*`、`PROGRESS.md`、`INSTRUCTIONS.md`）全绿才 `gh pr merge --squash --delete-branch`；
  120s 逐项超时、内存幂等、`merge.autoMerge` 默认 `false`。**没有 CI 的仓库（如 dsh-superagent）永远不会被合。**
- **重启恢复错会话（`#36`,`19e71c4`）**：`/restart-wheelchair-agent` 现在按**发起命令的会话**恢复
  （命令插件取 `invocation.agent.session.id` → CLI `--session`），`~/.dsh-tui/resume.txt` 降级为兜底；`releaseSession`
  只对**重启链内**的 holder 发信号（`holderInRestartChain` 走 `/proc` 祖先链），另一个终端占着会话时
  **不抢占**、有界等待后开新会话并说明。`tests/test-restart.mjs` +182 行（含外来 holder 断言 `kill` 零调用）。
  **装完才生效**（`cli.js`/`src/spv/**` 随冷安装）。
- **压缩策略2（`#34`,`1ae93c0`）**：SPV preset 的 `compaction-basic` 改为 `auto: false`（行保留，作为不部署
  billion-context 的兜底），`command-compact`（`/compact`）与 `tool-result-pruner` 保留；`tests/test-preset.mjs`
  新增一条读**渲染后 YAML** 的断言（`auto: false` + 两条旧行仍在 + isolate realm 不变）。`npm test` 247 PASS。
  配套的 `dsh-superagent` 侧已在前一笔（`#2`,`94e6a77`）关掉 worker/router preset 的自动压缩。
- **Rust 核心第二步（`#33`,`5c151a4`）**：`queue`（`queue-op`：目录布局、pending 顺序、读、原子消费 rename、
  `.bad` 隔离与 EXDEV/EPERM 回退、outbox 写入）与 `schema`（`schema-check`：`object()` 的 `key:` 前缀与
  `safeParse` 的错误文案逐字保留）搬进同一二进制；`runCore` 收进 `queue.js`（`install.sh` 只拷它一个文件）；
  `serde_json` 开 `float_roundtrip`（>2^53 的数字与 `JSON.parse` 一致）、outbox 保持 Node 的 umask `0o644`。
  parity 门：`test-work/hooks/inbox/settings/home` 五个套件**零改动**；`cargo test` 34 passed、`npm test` 246 PASS。
- **去掉 SPV persona（`#32`,`ac916b4`）**：`preset/agent.cordis.yml` 的 `persona` 行整段删除，SPV 的系统
  提示词与普通 dsh 会话一致；派单契约（不自己实现、交付走 `spv_dispatch`、不等不轮询、复用 thread、
  插件/面板传 `cordis`、只转述 worker 说的）搬进 `spv_dispatch` 的工具描述；新增 `tests/test-preset.mjs`
  当防回归门，并进了 `npm test`。
- **Rust 核心第一步（`#31`,`54013f0`）**：回收计划搬进 `wheelchair-agent-core`（`work-plan` / `schema`
  子命令，envelope + 稳定错误码，输入全走 `Result`，畸形 stdin 不 panic）；`build/build-core.sh` 出产物、
  `install.sh` 拷到 `~/.local/bin` 并用 `cmp` 校验、CI 先 build 再跑 `cargo test`；parity 门是
  `tests/test-work.mjs` 零改动 + `work gc --dry-run` 输出逐字一致。
- **HARNESS 整理（第二批次）**：`docs/{hooks,restart,spv-source,work-gc}.md`、`preset/README.md`、
  `webui/README.md` 全部移入 `ARCHITECTURE/`（webui 拆成 `index/settings/hooks/screenshots`）；
  操作者删掉的 `docs/delivery-target.md` 不再保留副本，其中仍然成立的六条约束落进 `ARCHITECTURE/preset.md`；
  新增 `boundaries.md`；
  `ARCHITECTURE.md` 13.9KB → 5.4KB，细节全部下沉到分册；`layout.md` 补「当前目录布局」并修正
  「两个路由」的旧说法；仓库内旧路径引用全部重指（17 个文件、`src/` 与 `install.sh`、`commands/prepare.sh`、`tests/`、`ARCHITECTURE/` 都有），`webui/package.json` 去掉已不存在的 README；
  `AGENTS.md` 的 `<20kb` 改为 `<10kb`；R2 历史夹具的路径与本仓现状对齐。证据：`npm test` 全绿。
- **插口 stage 3（`#30`,`35be1f5`）**：面板第三段「插口」——事件含义/行/最近 5 次执行/可复制的
  `hook prompt`，内建行改名走 revision 检查的同一 PUT，面板不执行脚本。
- **面板（`#27`）**：960→1200px 共用宽度变量；收件箱去掉 104px 日期栏、时间进每封信；`fluid` 重做材质
  （色调洗 + 发丝边 + 两层阴影 + 挂载即播的错峰入场），`minimal` 严格静止。
- **插口 stage 1（`#28`, `27d4463`）**：8 个事件 id、7 条内建行、脚本执行（stdin JSON + `WCA_*` 白名单、
  超时/截断/串行/软失败）、cursor 去重、`records/hooks.jsonl` 记账、`hook prompt` 生成可复制提示词。
- **插口 stage 2（`#29`, `2788bbc`）**：service 侧唯一 runner；队列 acknowledgement/reply/notice、
  收件箱 approved/issue/merged、prepare 与 dispatch 的 spool 全部接线；`hooks.intervalSeconds`；
  核心路径先完成，hook 只记录、不阻塞。
- **orchestrator 自压缩**（dsh-superagent `6aec7c5` 本地）：`eval.compactRatio` 0.2 + 60s 滞回，只对主 Session，
  失败软；`lib/` 已 build，服务重启后生效。
- **数据根 / 冷安装 / 重启链**（`#21`/`#22`/`#24`/`#25`）：`~/.wheelchair-agent` 一次性迁移 + 票 clone 守卫；
  `install.sh` 冷安装 only（占用 `exit 3` + 一条 notice，`--check` 只读 `exit 2`）；`/restart-wheelchair-agent`
  同终端 `--resume` 拉回会话、`session release` 清租约。
- **收件箱审查史恢复**：12 条历史 review 按 `recovered: true` 写回（8 条原话 + 4 条只剩决定），备份在
  `~/.wheelchair-agent/records/inbox-backup-20261116T155846/`。
- **技能安装**：`~/.dsh/skills/` 四个（`agent-tool-design` / `cordis-plugin-development` / `harness-guide` /
  `pitfalls-manager`）；`tools/HARNESS-guide` 新增 `install.sh`（校验 dsh 要求的小写 kebab 名字，`--check` 只读）。
- **HARNESS 整理（本批次）**：`ARCHITECTURE.md` 修子命令表/目录树/参考索引、面板一节砍到边界、新增 hooks 三原则、
  已定型表格改为指向 `decisions.md`；`ARCHITECTURE/layout.md` 补 `install.sh` 契约与 tests 清单；
  `ARCHITECTURE/decisions.md` 新增 5 条定案并更正 2 处失真；`PROGRESS.md` 重写为快照。

# In Progress

- **一仓一部署 stage 2（未开始）**：每部署 `install.sh --project`、`wca-<slug>.service`、端口分配、
  `service --project`、`/restart-wheelchair-agent --project`；stage 3 再给收件箱 watcher 定归属、把审查结果
  路由回拥有该信的部署。设计见 `ARCHITECTURE/deployments.md`。冷安装等操作者：`service stop` → 退出 SPV → `bash install.sh` →
  `service start` → `wheelchair-agent spv`。

# Known Issues

- **宿主环境的 systemd 在崩**：`dmesg` 记录 `systemd-logind / systemd-resolved / systemd-timesyncd` 在开机 191 秒
  时 SIGABRT（WSL2 时钟跳变），logind 一崩就销毁 session scope。这是这一夜服务"静默死亡"的宿主级原因；
  `wsl --update` / 避免宿主睡眠是待试项。
- **`service-detach` 票被停**：它的 e2e 反复杀掉真服务（在自己的 e2e 里对真进程表动手）。成果留在
  `~/.dsh/state/superagent/work/service-cgroup-detach-0343d962753e/`（`M commands/superagent-service.py`、
  `M tests/test-restart.mjs`、`?? .e2e-detach.sh`、`?? docs/service-cgroup.md`）。重派时必须禁止任何基于
  `/proc`、tmux、端口的实时探测。
- **dsh-superagent 没有 HARNESS**：dsh-superagent 的 `docs/007-architecture.md`（71KB）在充当 ARCHITECTURE，渐进式披露失守。
  拆分前必须先改 `tests/docs.spec.ts` 里硬编码的 `docs/007-architecture.md` 路径。
- **worker / router 两个 preset 还没挂 billion-context**：`INSTRUCTIONS.md` 的「压缩策略2」要求 worker、orchestrator、
  spv 全部交给 billion-context。三处策略1 已关（`dsh-superagent` `#2`、本仓 `#34`），SPV 会话本来就在用
  billion-context；但 `dsh-superagent-worker` / `dsh-superagent-router` 这两个自建 preset **身上没有 bili 的行**
  （bili 只往四个内置 preset 注入，操作者也确认 worker 工具表里没有 bili 工具）。挂载要"可选挂"：插件不在
  就不挂，否则 `MODULE_NOT_FOUND` 或 inject 悬空让 preset 一直 pending。
- **冷安装现在多一步前置**：`install.sh` 需要 `bash build/build-core.sh` 的产物，所以装的人要有 cargo +
  crates.io。这与"面向大众一键安装"冲突，发布前必须改成按平台预编译产物（`dsh` 的做法：按平台拆包 +
  `os`/`cpu` 门禁）。
- **平台写死**：`src/shared/queue.js` 的 `CORE_BINARY` 与 `install.sh` 的 `CORE_ARTIFACT_REL` 都写死
  `linux-x64`；多平台前要改成按 `process.platform` / `process.arch` 拼名。
- **"待冷安装"判定依赖戳**（`#39`）：`install.sh` 写 `<data root>/installed.json`，`--check` 与 `spv`
  的 `detectInstallPending` 共用同一指纹（preset 注释不敏感、块标量逐字保留）；没戳的老部署仍按旧行为提醒一次。
- **HARNESS 里仍有 23 处规则重述**（冷安装契约 4 份、面板必须是真包 4 份、`hooks.md` 与
  `ARCHITECTURE/webui/hooks.md` 互相重述）：移动已完成，去重是下一件事，优先级低于功能；动之前先看是否某处已有更权威的一份。
- **`hooks.md` / `restart.md` 各 28KB 单文件**：同为单主题，暂不拆；要拆的切点在「执行契约」与
  「Releasing a stuck session」之前。

# Next Steps

0. **Rust 迁移的下一张票**：`src/shared/` 剩下的纯逻辑——`settings` → `hooks`（类型面最大的一块）；
   然后是 CLI 侧 `dispatch`/`outbox`/`check`/`health`/`cron`/`inbox` 存储；`session`/`restart` 链放最后（它管杀进程，
   出事最贵）。每张票的 parity 门都是"对应测试文件零改动 + 用户可见输出逐字一致"。

1. 操作者执行一次冷安装（`#29`/`#30` 需要新 host 才生效）。
2. 重派 `service-detach`（带禁令），并把 `service open` 作为最后一步并入 `/restart-wheelchair-agent`
   （`src/spv/restart.js` + `tests/test-restart.mjs`，见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`
   的「改法」一节）。
3. 建 `dsh-superagent` 的 HARNESS 脊梁（`ARCHITECTURE.md` + `core/executor/sources/panel/operations/modules/tests`），
   把 007 拆开并 repoint `tests/docs.spec.ts`；顺带把两个压缩设置做进面板。
4. 一仓一部署 stage 2：`install.sh --project`、`wca-<slug>.service`、端口分配、`service --project`、
   `/restart-wheelchair-agent --project`；stage 3 再给收件箱 watcher 定归属、把审查结果路由回拥有该信的部署。
