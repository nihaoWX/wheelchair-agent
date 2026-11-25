# Current State

**可用**：SPV 会话 + superagent 服务端到端跑通。链路
`spv_dispatch` → 文件队列 → Trigger → superagent 主 Session（评估/路由）→ Ticket → worker（项目 clone 内执行）
→ `reply` 写回队列 → 会话内注入器作为新消息推进对话。没有 `spv_result`、没有超时。

**入口**：`wheelchair-agent` 是唯一命令（`spv` / `prepare` / `service` / `jobctl` / `dispatch` / `status` /
`inbox` / `work` / `restart-all` / `session` / `hook` / `where` / `check`）。`superagent-service`、`jobctl`
是它的兼容薄壳；`spv` 装的是渲染过的启动器本身（`runSpvSession` 直接 exec 它）。

**数据根**：`~/.wheelchair-agent/`（`settings.json`、`inbox/`、`records/`、`logs/`、`deployments.json`），与
superagent 不耦合；队列归**每份部署**自己（`<stateDir>/spv/`），superagent 自己的 state 在
`~/.dsh/state/superagent/<slug>/`。
**一仓一部署**（`INSTRUCTIONS.md`）stage 1–3 已全部落地（`#42`/`#43`/`#44`/`#45`/`#46`/`#48`）：注册表
`~/.wheelchair-agent/deployments.json` 是**唯一**来源，`project → 部署` 决定队列、实例 overlay、端口与会话；
没有注册表的机器先 `wheelchair-agent deployment migrate` 认领旧安装。单部署**旧形态**已删除（裸 `service`、
裸 `restart-all`、默认项目的 `spv`、`resolveRoot` 的 legacy 回退、watcher 的全量轮询），见
`ARCHITECTURE/deployments.md`。

**面板**：两个宿主、同一份 `webui/lib/client.js`（`#52`, `25b8e29`）。①独立面板 `wheelchair-agent panel`
（`127.0.0.1:3080`，`panel.port` 可改，`--detach` 常驻 + `panel stop/status`），`service open` 只开它，
`service status` 把面板与各部署分行列；②dsh 插件宿主保留（面板仍出现在 dsh web 左侧栏）。功能仍是
收件箱、设置、插口三段；`webui.style` = `fluid`（默认）/ `minimal`；各页共用 1200px 宽度变量，收件箱无
左侧日期栏。**后台行为（收件箱轮询、`builtin:autoMerge`、`builtin:archiveSession`、冷安装提醒、hook
runner）故意只留在 dsh 插件宿主**——没开面板也照常合并与提醒。dsh 内嵌面板的 URL 仍每实例一 token
（见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`），独立面板不需要 token。

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

- **四份部署 + 自动合并开关 + 文档第一批去重（运维，`23aa57e` 之后）**：注册
  `tools/manuscripts_skills`（3083）/`tools/pitfalls-manager`（3084）/`tools/svg_grid`（3085），各自
  `service start --project` 后 `deployment setup --project` 写进 GitHub 仓库，四份全部 `runtime: ready`；
  注册 spv 项目 `/home/nihao/bioagentforge` 绑四个 worker；`merge.autoMerge` 从 `false` 改成 `true`
  （`~/.wheelchair-agent/settings.json` revision 3）。同时发现两个设置面 bug 已派票
  （`d15a826a7cda43bf921ddfe7dd8c8ea7`：`panel.port` 不在 `KEY_SPECS` 里所以被当未知键丢掉、部分
  `PUT /wheelchair-settings` 会把没出现的键重置成默认值并记进 `filled`）。

- **Rust 第四步：插口数据面（`#54`, `9c98064`）**：`crates/wca-core/src/hooks.rs` + 子命令 `hooks`
  （`payload|eventId|timeout|cwd|env|record|records|cursor-read|cursor-write|texts`）。搬的是数据面
  （payload 采样、事件 id、超时夹取、cwd/env 推导、`hooks.jsonl` 追加与读取、游标读写、12000 code point
  截断），**执行面留 Node**（spawn/流式/强杀/超时），游标锁与 claim 协议也留 Node。事件表仍在
  `hook-events.js`，二进制不认识事件名。自验：`cargo test --release --workspace` 56 passed；
  `npm test` 446 passed / 0 failed；我自己写的 65 项对比脚本（九个事件 payload、eventId、timeout、cwd、
  env 白名单与凭证过滤、记录字节、游标格式与 claim 幂等）在 `c655edf` 与 PR 之间**逐字相同**（只差时间戳）；
  生产代码 `unwrap/expect/panic` 零命中；`spawn` 仍只有 `hooks.js:622`。已知**既有**抖动（与本 PR 无关）：
  `tests/test-hooks.mjs:435` 的"the timeout bounds the run"在 main 上也会 ~1/8 概率失败。

- **spv 项目 + 面板「项目」段（`#53`, `16d0a97`）**：`<data root>/spv-projects.json`
  （`{version:1,spvProjects:[{root,workers}]}`，坏 JSON 报错且一字不改、相同内容不写盘）+
  `spv-project list|add|remove` + `deployment add --spv`（唯一祖先可推断才自动）+
  `deployment remove` 同步解绑。四条校验都有测试：spv 根不能是已登记 worker 项目、两个 spv 根不能嵌套、
  worker 必须在根之下、一个 worker 只绑一个 spv。面板第四个 section「项目」只读：
  core 路由 `GET /wheelchair-projects`（两宿主都有）+ `src/spv/projects-view.js` 并发探测每份部署
  `GET /orchestrator/api/{state,overview,tickets?state=working}`，**单份 2s 超时**、失败只把那一行标
  `unavailable`、30s 刷新。自验：`npm test` 全绿；临时数据根手验 `add`/幂等/嵌套/worker 当根/`--force`
  五种报错文案；真起面板 3998 + 假部署 API 3084 → `state.kind:"ok"` 带 `running` 与 `queued`;
  截图 `webui/docs/panel-projects-1440.png`。
- **独立面板（`#52`, `25b8e29`）**：`webui/lib/` 里的三个 JSON 路由抽成不 import `@deepseek-ai/*` 的
  `src/spv/panel-routes.js`，新增 `wheelchair-agent panel [start|stop|status] [--port] [--detach]`
  （`src/spv/panel.js`，`127.0.0.1:3080`、`panel.port` 设置键、`<data root>/panel.pid`、自己的
  Host/Origin 栅栏）与 `src/spv/panel-shell.js`（`window.__ModuleLoader__` + 槽位/locale 垫片 + vendored
  React 18.3.1 UMD，`webui/vendor/` 带 LICENSE 与版本 SHA）。**`webui/lib/client.js` 一个字节没改**，
  Before/After 截图在 `webui/docs/panel-standalone-{before,after}-1440.png`。`service open` 只开面板、
  `service status` 分列面板与部署、`service stop --all` 不停面板。后台行为（轮询/自动合并/归档/提醒/
  hook runner）**故意留在 dsh 插件宿主**。我的自验：`npm test` 全绿；真起面板 3999 端口 →
  `/client.js` 与仓库文件 `cmp` **字节一致**、`/` 200、`/vendor/react.production.min.js` 200、外域
  `Origin`/伪造 `Host` 都 403、`GET /wheelchair-settings` 里 `effective` 有 `panel.port: 3080`、
  `PUT` 写入 + stale revision 409、`panel stop` 后端口释放。
- **每份部署自己的仓库（`#51`, `315b17f`）**：注册表条目加可选 `repository`（`deployment add --repo`
  或从项目 checkout 的 GitHub origin 推断，https/`git@`/scp 三种写法），`deployment list` 显示；
  新增 `deployment setup --project <p>`：走实例面板 API（loopback + `x-orchestrator-request: 1`，
  无 token）写 `source:github`，PUT 后轮询 `GET /orchestrator/api/state` 直到 setup 重新 configured
  （默认 90s/2s）；`service start` 成功后若 setup 为空就给一行指路。我的自验：`npm test` 368 全绿；
  手验 `--repo` 推断、冲突报错指路 remove/add、非法 repo 与无 origin 的明确报错；`DEPLOYMENT_USAGE`
  首行漏 `setup`（已在 `#52` 顺手修）。
- **`spv` 去掉假语义（`#50`, `31c105e`）**：`spv` 是整台机器唯一的会话，`--project`/`--all` 一律
  UsageError；启动前启动每份已注册部署的后端并清掉继承来的 `SPV_QUEUE_DIR`/`DSH_SUPERAGENT_STATE_DIR`；
  注册表缺失只打一行 note 不阻断；`mergeNoticeText` 打出的冷安装配方改成 `--project` 形式。
- **SPV 起不来（dsh schema 子集）+ 启动器保活（`#49`, `6dde246`）**：`src/spv/tools.js:285` 的
  `project: { type: ['string','null'] }` 用的是 type 数组，而 dsh 只接受单个 type 字符串，整份 preset 在
  `failed to create agent` 时被拒（`#48` 的 `1ba0587` 引入）——改成 `oneOf: [{type:'string'},{type:'null'}]`。
  `tests/test-preset.mjs` 新增 schema 子集 walker（`type/oneOf/properties/required/additionalProperties/
  items/enum/const` + 四个注释键，递归 `properties`/`items`/`oneOf`），把回归挡在测试里。
  另修启动器：`#48` 后裸 `service status`/`start` 必失败（无 `--patch` 匹配 / `UsageError`），
  `preset/spv-launcher.sh` 于是每次都报 "superagent did not start"。现在 `commandService` 在既无
  `--project` 也无 `--all` 时先用 `ownDeployment()`（读 `SPV_QUEUE_DIR`，与 `restart-command.js` 同一套）
  反查本进程所属部署；`wheelchair-agent spv` 会把该变量导出给启动器，所以启动器裸跑 status/start 就落在
  自己那份实例上。没有身份的普通终端行为不变（裸 start/stop 仍 exit 2，测试 `test-deployments.mjs` 未动）；
  直接敲 `spv` 时如实报告"不知道属于哪份部署"（`#50` 之后启动器回到薄壳，`spv` 本身不再带部署身份）。
  验证：`npm test` 63 passed / 0 failed（`test-deployment-instance.mjs` 新增假 python3 记录器，
  断言 `--patch`/`--queue-dir` 指向 alpha、`--project` 压过环境、匿名 start 不触达 service manager）；
  冷安装后 `SPV_QUEUE_DIR=… spv --version` 自动起后端并打印 `superagent: ready`；
  `wheelchair-agent spv --project tools/wheelchair-agent` 在 tmux 里正常渲染 SPV TUI（状态行 `SPV`，
  无 schema 错误、无 superagent 警告）。
- **去单部署（`#48`,`1ba0587`）**：注册表成了唯一来源——`resolveRoot`/`resolveRoots` 删掉 legacy 回退、
  `install.sh --project` 必填（唯一推断是 checkout 唯一对上已登记部署）、`service` 要 `--project`/`--all`
  （裸 `status` 例外）、`spv` 三级推断不再默认 `tools/wheelchair-agent`、watcher 认不出自己就什么都不轮询、
  `deployment remove` 删最后一条要 `--force`、`migrate` 只剩"认领旧安装"。`restart-all --all` 改成逐份
  stop → 等 lease → 装一次 `install.sh --project` → 逐份 start（原先那条计划里是裸 `install.sh`/裸
  `service start`，真跑会停光起不回）；`--all --dry-run` 需 `--detach` 才出计划。三轮自验：第一轮抓到
  `--all` 的洞、第二轮抓到 dry-run 的 `preflight(detached:false)` 回归、第三轮全绿；基线 355 → **367 passed
  / 0 failed**，CI pass，+1578/−465。
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
  `service … --project <p>` 按注册表找实例文件、端口、会话（`wca-<slug>`）与日志，只动那一份；当时不带
  `--project` 仍沿用旧行为（`#48` 已改成必须 `--project`/`--all`）。`commands/superagent-service.py` 的进程匹配从 profile 细化到「profile + `--patch` 文件」。
  我自己验：`dsh --profile superagent --patch <实例文件> --dump-config` 真的把 `port: 3099`（516 行）、
  `stateDir`（1283 行）、`queueDir`（1484 行）套进去了；`deployment add` 幂等、`--queue-dir` 不一致
  `exit 2`、手改注册表 `exit 1`；`npm test` 368 PASS/0 FAIL。
- **一仓一部署 stage 1 收尾（`#43`,`07c9b24`）**：注入器改用 `resolveRoots()` 每轮解析**所有**部署队列
  （显式 `queueDir`/`$SPV_QUEUE_DIR` 仍然独占一根），去重身份是「队列根 + 文件名 + thread」、每根各自取基线，
  新 `deployment add` 的部署在运行期被接上且不重放积压；`spv_status` 按部署分组（`project` 参数只看一份）；
  当时注册表不存在时输出与旧版逐字相同（`#48` 已改成给出指路错误）。我实测：三个根（两个部署 + 旧规则根）各投一条 reply → 三条都注入一次，
  随后再向其中一个队列追加一条 → 也注入，共 4 条不重复。
- **一仓一部署 stage 1（`#42`,`4a24e4f`）**：注册表 `~/.wheelchair-agent/deployments.json`（项目 → 部署，
  坏文件报错且一字不改、原子写入）+ `wheelchair-agent deployment list|add|remove|migrate` +
  `dispatch`/`spv_dispatch` 按注册表写对应部署的队列（缺条目报错并指路 `deployment add`，绝不自动建）+
  `install.sh --project` 装成功后记账（`--check`/`--fingerprint` 只读）。当时注册表不存在时行为逐字不变，
  所以升级本身不改变任何现有行为（`#48` 已翻转：注册表是唯一来源）；`deployment migrate` 认领旧安装。
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

- **下一次冷安装**（`#49`–`#52` 全在等它）：`service stop` → 退出 SPV → `bash install.sh --project
  tools/wheelchair-agent` → `service start --project tools/wheelchair-agent` → `wheelchair-agent spv`。
  装完 `install.sh --check --project tools/wheelchair-agent` 应全绿，`deployment list` 应显示一条
  `tools/wheelchair-agent port 3082`；随后 `wheelchair-agent panel --detach` + `service open` 才是独立面板。
- **下一步（未派）**：`INSTRUCTIONS.md` 的「spv 项目」模型 + 面板「项目」卡片（只读）——
  `<data root>/spv-projects.json`、`spv-project add|list|remove`、`deployment add --spv`、卡片数据来自每份
  部署的 `GET /orchestrator/api/{overview,tickets}`，实例挂了显示 `unavailable`。
- **四份部署尚未注册**：`tools/manuscripts_skills`→`nihaoWX/manuscripts_skills`、`tools/pitfalls-manager`、
  `tools/svg_grid`、`tools/wheelchair-agent`（3082），端口 3083/3084/3085；每份要 `deployment add` +
  `install.sh --project` + `service start --project` + `deployment setup --project`（`#51`）。
- **`merge.autoMerge` 仍是关的**：`settings.json` 里还没有这个键（默认 `false`），要在面板打开，
  且第一次真正合并前建议先用一张低风险 PR 试。

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
- **worker / router 两个 preset 的 bili 工具待实机确认**：`INSTRUCTIONS.md` 的「压缩策略2」要求 worker、orchestrator、
  spv 全部交给 billion-context。三处策略1 已关（`dsh-superagent` `#2`、本仓 `#34`），SPV 会话本来就在用
  billion-context；worker/router 的 preset 里**没有 bili 的行**（bili 只往四个内置 preset 注入），工具可见性靠
  `dsh-superagent` `#3`（`c79f104`）的 `BILI_TOOLS` + `allowTools()` 解决——它放宽 `tools.restrict` 的白名单，
  插件不在时白名单与旧版完全一致。`#3` 随下次冷安装生效，**要等下一次真派单在 worker 工具表里看到
  `compress`/`acp_status` 等六个工具**才算验证完成。
- **冷安装现在多一步前置**：`install.sh` 需要 `bash build/build-core.sh` 的产物，所以装的人要有 cargo +
  crates.io。这与"面向大众一键安装"冲突，发布前必须改成按平台预编译产物（`dsh` 的做法：按平台拆包 +
  `os`/`cpu` 门禁）。
- **平台写死**：`src/shared/queue.js` 的 `CORE_BINARY` 与 `install.sh` 的 `CORE_ARTIFACT_REL` 都写死
  `linux-x64`；多平台前要改成按 `process.platform` / `process.arch` 拼名。
- **"待冷安装"判定依赖戳**（`#39`）：`install.sh` 写 `<data root>/installed.json`，`--check` 与 `spv`
  的 `detectInstallPending` 共用同一指纹（preset 注释不敏感、块标量逐字保留）；没戳的老部署仍按旧行为提醒一次。
- **`deployment list` 的空注册表文案也过时**：`src/spv/deployment.js:150-153` 仍说 "this install still uses the
  single-deployment default"，而 `#48` 之后没有这个默认了（同一句里的 `deployment migrate` 建议仍然正确）。
- **冷安装通知的配方在 `#48` 之后过时**：`src/spv/inbox.js:881-890` 的 `mergeNoticeText()` 仍打印
  `wheelchair-agent service stop` / `bash install.sh` / `wheelchair-agent service start` / `wheelchair-agent spv`
  这四条裸命令，而去单部署之后它们全都会被拒绝。修法：按 `ownDeployment()` 得到的项目打印 `--project <p>` 形式
  （`deployment add` 的建议也一并给），认不出自己时打印 `--project <your project>` 占位并在文案里说明原因。
- **`install.sh` 结尾的配方同样是裸命令**：装完打印的 `wheelchair-agent service start` / `wheelchair-agent spv`
  在 `#48` 之后也会被拒（`service start` 要 `--project`；`spv` 推断不出项目就报错列清单）。同一类修法。
- **直接敲 `spv` 没有部署身份**：`~/.local/bin/spv` 装的是渲染过的启动器本身（不是
  `exec wheelchair-agent spv` 的薄壳），所以直接调用时环境里没有 `SPV_QUEUE_DIR`——启动器无法反查会话属于
  哪份部署，只能如实提示改用 `wheelchair-agent spv --project <p>`（见 `ARCHITECTURE/cli.md`「保留独立命令名」）。
  两条路二选一：把 `spv` 改成薄壳（则必须在项目目录里或带 `--project` 才能起），或让启动器在只有一个注册
  部署时也直接用它（与 `#48`「不猜默认部署」冲突，需操作者定夺）。
- **HARNESS 里仍有规则重述**：一次全树审计量到 14 条规则、66 处出现（47 处在 `ARCHITECTURE/**`、
  19 处在代码与 UI 文案），去掉 11 处合法指针后还剩约 55 处重述（此前记的"23 处"漏了文件内重复）。
  单一出处已定：冷安装契约 `layout.md`、面板必须是真包 `webui/index.md`、受管 AGENTS.md 六条 `preset.md`、
  队列 rename 协议 `spv-source.md`、不动线上服务 `restart/lease.md`、`queueDir ≡ <stateDir>/spv`
  `deployments.md`、重启顺序 `restart/order.md`、`delivered` 非终态与内建行 `hooks/contract.md`、
  revision/409 `webui/settings.md`、一个 hook 读者 `hooks/runtime.md`。清理按这份清单逐条做。
  **第一批已收**：`preset.md` 的「重启整套部署」整段（约 2.2KB 重述，且里面"`resume.txt` 是唯一来源"
  自 `#36` 起已作废）换成三行指针 + 两条易错提醒；`webui/index.md` 的路由清单从"三条"改成四条并指向
  `src/spv/panel-routes.js`，`hooks.md` 拆分后遗留的"面板段"歧义也一并改准。
- **代码注释里有 8 处指向 `ARCHITECTURE/hooks.md`**（`src/shared/hooks.js:4/:87/:776/:994`、
  `hook-events.js:6`、`settings.js:18`、`src/spv/hook.js:4`、`commands/prepare.sh:384`）：文档拆成四册后
  这些指针要分别指向 `hooks/{contract,execution,runtime}.md`，属于代码改动，等下一张票一起改。

# Next Steps

0. **Rust 迁移的下一张票**：`settings`（`#47`）与 `hooks` 数据面（`#54`）已搬完，下一块是 CLI 侧
   `dispatch`/`outbox`/`check`/`health`/`cron`/`inbox` 存储；`session`/`restart` 链放最后（它管杀进程，
   出事最贵）。每张票的 parity 门都是"对应测试文件零改动 + 用户可见输出逐字一致"。

1. 操作者执行一次冷安装（`service stop` → 退出 SPV → `build-core.sh`（若 core 未建）→ `install.sh --project` →
   `service start --project` → `spv`），`#37`–`#52` 一起生效；装完 `panel --detach` + `service open` 才是独立面板。
2. 重派 `service-detach`（带禁令），并把 `service open` 作为最后一步并入 `/restart-wheelchair-agent`
   （`src/spv/restart.js` + `tests/test-restart.mjs`，见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`
   的「改法」一节）。
3. 建 `dsh-superagent` 的 HARNESS 脊梁（`ARCHITECTURE.md` + `core/executor/sources/panel/operations/modules/tests`），
   把 007 拆开并 repoint `tests/docs.spec.ts`；顺带把两个压缩设置做进面板。
4. 一仓一部署：stage 1–3 与去单部署都已完成（`#42`–`#48`）。剩下的只有实机验证——`deployment add` 第二份部署
   （例：`tools/pitfalls-manager`），确认两个面板各自可达、`dispatch --project` 各写各的队列、审查回信落到正确部署。
