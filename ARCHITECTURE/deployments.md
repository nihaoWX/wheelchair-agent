# Definition

**每个 worker 小仓一份 superagent 部署，spv 根仓不部署。** 这一条来自进程外的观察（`INSTRUCTIONS.md`）：
superagent 的原设计就是「一份部署 = 一个仓库」——`deployment.repository` 只有一个值，部署边界由
`stateDir` + dsh profile + 面板端口 + 一个 orchestrator 主会话划定。我们是顺着它，而不是绕它。

## 模型

| 角色 | 是什么 | 在哪 |
|---|---|---|
| 一份部署 | 一个 dsh profile + 一个 stateDir + 一个面板端口 + 一个 orchestrator 主会话 + 一份收件箱 watcher + 一份 wheelchair-agent 安装（preset / webui / core） | `~/.dsh/profiles/<profile>`、`<stateDir>` |
| 部署的身份 | 一个项目名 `tools/<name>` 或 `research/<name>`，**一个项目一份部署** | 注册表 `~/.wheelchair-agent/deployments.json` |
| spv | 普通 dsh 会话 + spv 工具（`spv_dispatch` / `spv_status` / `spv_notify`），cwd = 管理所有仓库的顶层目录 | `~/bioagentforge`（可配 `SPV_PROJECTS_ROOT`），**不是部署** |

由此退休两件旧设计：

- **`deployment.repository` 不再需要占位仓**：每份部署填它自己的仓库，`observeIssues` 可以按需真正打开；
  `bioagentforge` 不再出现在任何部署里。
- **`DSH_SUPERAGENT_SPV_PROJECT` 从「路由键」降级为「部署常量」**：变量本身保留（superagent 的 prepare 要它），
  但在一份部署里它是常量，不再是「多项目共用一份部署」的唯一载体。

# Structure

## 1. 路由：注册表 + 每部署自己的队列（stage 1）

- 注册表是**唯一**的「项目 → 部署」真相：`~/.wheelchair-agent/deployments.json`
  `{ "version": 1, "deployments": [{ "project", "profile", "stateDir", "queueDir", "port", "installedSha" }] }`。
- 队列**归部署自己**：`<queueDir>/<pending|done|outbox>`（默认 `<stateDir>/spv`，与 `src/superagent/spv.js`
  的 `queueDir` 配置一致）。每份部署的 spv Source 只读自己的队列——这一点不需要改，改的是**往哪写**。
- `spv_dispatch` 与 `wheelchair-agent dispatch` 先查注册表拿 `project → deployment`，再写那份部署的
  `<queueDir>/pending/`。找不到该项目的部署 → **报错并给出下一步**（`wheelchair-agent deployment add <project>`），
  **不自动创建**：创建部署要 profile、端口、systemd 单元，属于显式动作。
- **结果回收与观测**：注入器监听**所有**已注册部署的 `outbox/`，按「队列根 + 队列文件名 + thread」去重，
  各根的游标互不覆盖；`spv_status` 按部署分组打印队列深度，`--project` 只看一个。
  显式 `queueDir` 设置或 `$SPV_QUEUE_DIR` 一旦给出，就只有一个根，不再聚合——显式设置永远赢。
- 注册表是**唯一**来源（`#48` 起）：没有注册表、或本实例认不出自己读的是哪份部署的队列，一律**报错并给下一步**
  （`cannot tell which deployment this process belongs to …` / `no deployment for project "…"`），不再退回
  "基 stateDir 的旧队列"或"轮询所有项目"。`src/spv/paths.js` 的 `resolveRoot()`/`resolveRoots()` 里那条
  legacy 回退已经删除，`$SPV_QUEUE_DIR` 只剩测试与单次调试的逃生口语义。
- 迁移：`wheelchair-agent deployment migrate` 是**升级路径**，不是可选开关——它把一台旧机器（`superagent` profile +
  `~/.dsh/state/superagent` + 旧队列 `<stateDir>/spv`）认领成一条部署（项目取 `merge.installRepo` 所在的仓，
  即 `tools/wheelchair-agent`），之后这条机器上的服务/派单/重启才有部署可依。

## 2. 每部署的安装与服务（stage 2）

**部署 = 一个实例，不是一份 profile**（先证后做：`dsh --profile <p> --patch <file.yml>` 的 overlay 必须能设置
`webserver` 端口、`dsh-superagent` 的 stateDir、`wheelchair-spv` 的 `queueDir` 与 webui host——用
`dsh --profile superagent --patch … --dump-config` 验；验不过才退回「每部署一份 profile」，那需要复制
`node_modules`，代价大得多）。

- `install.sh --project tools/<name>`：前面的安装（preset / webui / core）保持**全局一份**，每个部署
  只多一份实例配置 `<data root>/deployments/<slug>.yml`（端口、stateDir、`queueDir`、面板标题），
  `installed.json` 记 `project` 与 sha（指纹判定沿用 #39）。
- systemd：一个部署一个 `wca-<slug>.service`，命令形如
  `dsh --profile superagent --patch <data root>/deployments/<slug>.yml`；端口从 3082 起按注册表分配，
  冲突即报错、不自动改。每个部署的 stateDir 独立（`~/.dsh/state/superagent/<slug>`），所以会话、工单、
  worker 都互不可见。
- `wheelchair-agent service start|stop|restart|open`：目标**由所在目录决定**（`#59` 删掉了 `--project`）——cwd 落在
  `<projectsRoot>/<project>` 之下（含子目录、最长匹配）就动那份部署；`SPV_QUEUE_DIR`（启动器拉起的 shell）作第二兜底；
  推不出就 exit 2 列出注册表并指路 `--all`。`--all` 动全部。裸 `service status` 不做推断：先打面板行，再逐份列出注册
  部署。要动另一份而人不在它的 checkout 里，用 `restart-all --project <p>`（那个 `--project` 保留）。
- 重启分两种，都带 `--project`：
  - `/restart-wheelchair-agent`（= `restart-all --project <本部署>`）：目标**从本实例的 `SPV_QUEUE_DIR` 反查注册表**，
    所以斜杠命令一个参数都不用敲；只停/起这一份实例、resume 这一份的会话，**不跑 install**（preset/webui/core
    是全局一份，装属于另一件事）。
  - `restart-all --all`：全机器一圈——`service stop --all` → 停会话链等 lease → **装一次**
    （`bash install.sh --project <installProject>`，installProject 由本 checkout 的 origin/路径反推，推不出就要求
    显式 `--project`）→ `service start --all` → 恢复 TUI。想装新代码就用它。
- 派单路径的健康判定（`src/spv/dispatch.js` 的 `ensureDeploymentStarted()`）：先探活 → 目标部署没在跑就用**与
  `service start` 完全相同**的 argv 起它 → 再探活 → 只有实例真的能应答才写 `pending/<id>.json`。**非零退出码不等于
  启动失败**：`setup: waiting — repositoryUnset` 时管理器会先把实例拉起来再 exit 3，那种情况按"已暂停"报告并指向
  `deployment setup --project <p>`（`#60`）。"能不能接活"由实例自己的 `/orchestrator/api/state` 判定，
  **启动前后各判一次**（`#61`：paused 与"我这次起没起它"无关，否则同一个部署第二次派单会成功）；
  `setup.problem` 的真机形状是对象 `{place, code, values, detail}`（`dsh-superagent/src/setup.ts:24`），
  由 `setupProblemText()` 归一化成一句话，`projects-view.js` 与 `deployment-setup.js` 共用；读不到/空对象/缺
  `code` 一律 fail open（旧式队列、测试假实例都不能被误拒）。启动/暂停/失败三种情形都**不**留下任务文件。
- `wheelchair-agent spv` **不启动任何后端**（`#59`）：任务进的是各部署自己的队列文件，读它的是那份部署自己的实例，
  所以派单路径（`spv_dispatch` / `dispatch`）先确保目标部署在跑、**成功之后**才写队列文件。没被用到的部署就一直不跑，
  它的收件箱轮询/自动合并也随之不发生——这是有意的（"没用到就不启动"）。
- `wheelchair-agent spv` 仍只有一个（spv 不是部署），它的目标由 cwd 落在
  `<projectsRoot>/<project>` 推断，推不出就报错列清单，**不再有 `--project`**（`#50` 删掉：项目没有自己的 spv）。
- 面板（`service open` / `wheelchair-agent panel`）从 `#58` 起也是**一份自己的 dsh 实例**，但它**不是部署**：
  profile `panel` 不含 `dsh-superagent`，不进注册表，`deployment list` 不显示、`service stop --all` 不停它，
  端口取设置 `panel.port`（默认 3080），stateDir `<data root>/panel`。各部署的完整 UI 仍在各自端口，面板
  「项目」卡片用链接跳过去。

## 3. 收件箱（stage 3）

- 收件箱数据根保持**全局** `~/.wheelchair-agent/inbox/`：任何面板打开都看到同一份，对应
  `INSTRUCTIONS.md` 的「包含所有正在管理仓库的 PR」。
- watcher 归属：每份部署只轮询**自己项目**的仓库（`discoverRepos(projectsRoot)` 之后按注册表过滤），所以同一个
  PR 只由一份部署处理 `git pull --ff-only` 与冷安装通知，不会重复。
- 审查结果路由：通过/有问题的评论必须到达**拥有该 item 的部署**——按 item 的 `repo` 反查注册表，写一条
  `kind: "review"` 的队列消息进那份部署的队列，由它的注入器注入 orchestrator → 工单。`#48` 之后不存在
  "认不出自己"的兜底：认不出就什么都不轮询、也不猜目标部署（猜错会让两份部署抢同一个 PR）。

### 两个被接受的限制（stage 2 定）

- **面板标签所有部署一致**：webui 面板标题是固定常量，没有 host/title 配置。每份部署在自己的端口上，
  收件箱数据根本来全局，所以标签重名不会认错对象。想区分时给 webui 加 title 配置即可，属于以后的事。
- **`queueDir` 恒等于 `<stateDir>/spv`**：实例里 `wheelchair-spv` 的 `queueDir` 跟随实例 settings/stateDir，
  overlay 改不了它。所以注册表条目必须满足这条恒等式，否则会出现"派单写进 A、部署读 B"的静默坏掉。
  `deployment add` 不一致即报错并给出正确值，手改注册表造成的不一致条目在读取时即报错，
  `deployment migrate` 与 `install.sh --project` 写出的条目必须合法。

## 分阶段与验收

| 阶段 | 交付 | 验收 |
|---|---|---|
| 1（已完成，`#42`/`#43`） | 注册表 + `deployment add|list|remove|migrate` + `dispatch`/`spv_dispatch` 走注册表 + 注入器/`spv_status` 聚合所有注册部署 + 安装契约记 project | 两份注册表条目下 `dispatch` 各写各的队列、两边的回信都回到同一个 spv 会话且不重复；没有条目时报错文案指明下一步；`npm test` 全绿（"注册表缺失时行为逐字不变"这半条在 `#48` 后被翻转成"给出指路错误"） |
| 2（已完成：`#44` 实例 overlay + `#45` 重启/状态作用域 + `#48` 去单部署 + `#59` 按 checkout 定位） | 每部署实例 overlay（`<data root>/deployments/<slug>.yml`：端口 + stateDir + queueDir）+ `service … [--all]`（目标由 cwd 决定，按注册表找实例、端口、会话、日志）+ `install.sh --project` 按项目分配 stateDir/端口 | 两个部署同时运行、各自面板可达、互不干扰；`/restart-wheelchair-agent` 仍能 resume 原会话；认不出部署的 `service` 报错指路，绝不猜基服务 |
| 3（已完成，`#46`） | watcher 按项目归属 + `kind: review` 路由 | 任一面板审一封属于别的部署的信，注入落到正确部署的工单 |

### stage 2 第一片落地（`#44`）

- 实例 overlay 由 `src/shared/deployments.js` 的 `renderInstance()` 生成，`deployment add` 与
  `install.sh --project` 共用同一份模板；`writeInstance()` **只在文件不存在时创建**，已存在的文件不动
  （可能被操作者按主机情况改过），注册表变了但文件没重写时会提示"删掉再 add"。
- `deploymentSlug(project)`：取叶子名、小写、非 `[a-z0-9._-]` 换 `-`；它同时是实例文件名、tmux 会话名
  （`wca-<slug>`）与日志名（`~/.dsh/.artifacts/wca-<slug>.log`）。
- 端口：`allocatePort()` 从 3082 起取注册表里第一个未占用的号；**只看注册表，不探内核**——所以旧单部署
  仍在 3082 上跑时先做 `deployment migrate`（把 `tools/wheelchair-agent` 记成 3082），新部署自然从 3083 起。
  真冲突由 `service start` 报错，不自动改。
- `service …`：先由 cwd（或 `SPV_QUEUE_DIR`）认出本部署（`#59`；`--project` 已删）→ 查注册表 → 找实例文件 →
  用该部署的 `--profile/--patch/--session/--log/--url/--port` 调 `commands/superagent-service.py`；没有端口、
  没有实例文件都给出"下一步跑什么"的报错。推不出部署时是一条指路错误（cd 进项目或 `--all`），裸 `service status`
  例外——它不需要推断，照旧打印本机服务行并逐份列出注册部署。
- `commands/superagent-service.py` 的进程匹配从"profile"细化到"profile + `--patch` 文件"（`serves(argv,
  profile, patch)`，`patch=None` = 旧的无 `--patch` 服务，`ANY_PATCH` = 该 profile 的所有实例，安装探针用）：
  同一个 profile 下多实例靠 patch 文件区分；监听端口上的进程也要 argv 对得上才算，避免"实例占了 3082 就
  被当成旧服务还在跑"。

### stage 2 第二片落地（`#45`）

- `restart-all --project <p>`（以及 `/restart-wheelchair-agent --project`）只停/起那一份实例：匹配用
  `src/spv/deployment-restart.js` 的纯函数 `selectInstanceProcesses(table, {profile, patch})`——profile 与
  `--patch` 文件两者都对才算命中，`patch: null` 只命中不带 `--patch` 的旧服务，`dsh plugin …` 安装器被排除。
  **重启不跑 install**：preset/webui/CLI/core 是全局一份，装是 `restart-all --all` 或手动
  `build-core.sh` + `install.sh --project` 的事。
- 会话目标：`--session`（命令插件传发起命令的会话）→ 该部署 stateDir 下的 `deployment-session.json`
  （`SESSION_RECORD`）→ 放弃并打印"去那个部署的终端跑 `spv --resume <id>`"。**永远不读
  `~/.dsh-tui/resume.txt`**——那是全局"最后打开"指针，跨部署读它等于把别人的会话拖进来；测试里放哨兵 id 断言没被用。
- 裸 `service status` 逐份列出注册部署（每行
  `<project> port <n> running|stopped <pid|->`），旧服务本体不重复报两次。

### stage 3 落地（`#46`）

- 归属由 `src/spv/ownership.js` 回答两个问题，**不新增注册表字段**：
  - *本实例是谁*：注册表里 `queueDir` 等于本进程 `resolveRoot()` 读到的那条。对不上（注册表不存在、
    条目被删、`$SPV_QUEUE_DIR` 覆盖）→ `{entry: null, reason}`；`#48` 之后 watcher 遇到这种状态**什么都不轮询**，
    只打一行 `ownership: <reason>; polling nothing until this instance can be identified`，`spv_status` 把它当问题显示
    ——猜一份部署会让两份部署抢同一个 PR。
  - *repo 属于哪个项目*：先读 `<projectsRoot>/<project>` 的 `git config --get remote.origin.url` 反查
    （`githubRemote()` 解析 https/ssh），读不到时退到「repo 名 == 项目叶子名」，报告里标明是兜底。
- watcher 只对**本部署的项目**做 `git pull --ff-only`、`pullEndNotices`、冷安装通知；别家项目的 PR 跳过并留一行
  `skipping <repo>: owned by deployment <project>`。同一个 PR 因此只会被 pull 一次。
- 审查回信：`inbox.approved`/`inbox.issue` 发现 item 的 repo 属于别的部署 → 不本地注入，而是往**那个部署**的
  `pending/` 写一条 `kind: "review"` 的消息（`thread: inbox-<pr>` 让同一 PR 的多次审查落到同一工单；
  `id = review-<item.id>-<sha256(id,verdict,comment)[:16]>` 保证重试只覆盖不叠加）；接收侧的注入文本以
  「这是另一份部署转来的审查结论」开头并原样带上 repo/PR/verdict/comment。`src/spv/outbox.js` 的
  `RESULT_KINDS` 相应加上 `review`。属于自己项目的审查仍走原来的本地通知路径。

### 去单部署落地（`#48`）

操作者的裁决：单部署是累赘，不留。做法是把**旧形态**删掉，而不是让注册表只剩一条（一份部署仍是数组里的一项）。

- 解析：`src/spv/paths.js` 的 `resolveRoot()`/`resolveRoots()` 删掉 legacy 回退，注册表是唯一来源
  （`$SPV_QUEUE_DIR` 只剩测试/单次调试语义，文档里明写它不是部署来源）。
- 安装：`install.sh --project` 必填，唯一允许的推断是 checkout 的 origin/路径**唯一**对上一个已登记部署；
  `--check`/`--fingerprint` 仍然只读（不写注册表、不写实例文件）。
- 服务：`service start|stop|restart|open` 的目��由 cwd 决定，`--all` 动全部；裸 `service status` 仍可看全局。
- `spv`：`--project` → cwd 落在 `<projectsRoot>/<project>` → 报错列出已登记部署；**不再默认
  `tools/wheelchair-agent`**。它启动时把该部署的 `DSH_SUPERAGENT_STATE_DIR` 与 `SPV_QUEUE_DIR` 交给 TUI/实例，
  所以实例天然能认出自己。
- 重启：`restart-all` 要 `--project` 或 `--all`；斜杠命令不给参数时从实例反查本部署。`--project` 只重启、不装；
  `--all` = 逐份 stop → 停链等 lease → **装一次**（`install.sh --project <installProject>`）→ 逐份 start → 恢复 TUI。
  `--all --dry-run` 在会话里要加 `--detach` 才能出计划（`preflight` 的祖先检查），计划是
  `service stop --all` → 停链 → 一次 `install.sh --project <installProject>` → `service start --all`。
- `deployment remove` 删最后一条要 `--force`（并警告这台机器将没有可用部署）；`deployment migrate` 只剩
  "认领旧安装"这一个语义。无注册表时 `service start`/`spv`/`restart-all` 都给一句指路话。
- watcher：认不出自己 → 什么都不轮询（见 stage 3 那节）；未登记项目不再被任何实例轮询，那个"两边各 pull 一次"
  的口子因此关闭。
- 测试：`tests/test-deployments.mjs` 里"注册表缺失时输出与旧版逐字相同"的断言翻成"给出指路错误"，
  每条新错误路径各有用例；`npm test` 355 → **367 passed / 0 failed**。

## 不做的事

- **不改 superagent 实现**，也不改它「一份部署一个 `repository`」的语义（见 `ARCHITECTURE/boundaries.md`）。
- 不自动创建部署、不自动改端口、不在 spv 会话里 stop/start 服务（重启只走 `/restart-wheelchair-agent`）。
- 不把 spv 根仓塞进任何部署；`bioagentforge` 只作为 spv 的工作目录存在。

## 与旧设计的关系

旧的单部署把所有项目都塞进 `tools/wheelchair-agent` 这份部署，靠 `trigger.meta.project` 拐一个弯决定 clone
哪个仓库；那份部署的 `deployment.repository` 只能填 `nihaoWX/bioagentforge`（spv 工作目录）当占位，于是 gh 默认
仓库、PR 归属判定、PR 结束通知、每张工单的环境变量全部指向一个与派单无关的仓库。分部署之后这些语义各自归位，
占位仓那段历史留在 `ARCHITECTURE/decisions.md` 里备查。

`#48` 之后连"单部署形态"本身也退场了：`paths.js` 的 legacy 回退、watcher 的"没有注册表就轮询所有项目"、
裸 `service`/`spv`/`restart-all` 这三套旧入口都已删除。代价是一台没有注册表条目的机器什么都跑不起来，
所以升级顺序固定为 `deployment migrate`（认领旧安装）→ `install.sh --project …` → 进项目目录 `service start`
（或 `service start --all`）。
