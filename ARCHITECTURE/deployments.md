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
- **结果回收与观测**：注入器监听**所有**已注册部署的 `outbox/`（外加旧规则那个 `<stateDir>/spv`，让还没迁移的部署继续工作），
  按「队列文件名 + thread」去重，各根的游标互不覆盖；`spv_status` 按部署分组打印队列深度，`--project` 只看一个。
  显式 `queueDir` 设置或 `$SPV_QUEUE_DIR` 一旦给出，就只有一个根，不再聚合——显式设置永远赢。
- 迁移：`wheelchair-agent deployment migrate` 把当前的单部署（`superagent` profile + `~/.dsh/state/superagent`）
  写成一项（项目取 `merge.installRepo` 所在的仓，即 `tools/wheelchair-agent`），旧行为完全不变。

## 2. 每部署的安装与服务（stage 2）

**部署 = 一个实例，不是一份 profile**（先证后做：`dsh --profile <p> --patch <file.yml>` 的 overlay 必须能设置
`webserver` 端口、`dsh-superagent` 的 stateDir、`wheelchair-spv` 的 `queueDir` 与 webui host——用
`dsh --profile superagent --patch … --dump-config` 验；验不过才退回「每部署一份 profile」，那需要复制
`node_modules`，代价大得多）。

- `install.sh --project tools/<name>`：preceding 的安装（preset / webui / core）保持**全局一份**，每个部署
  只多一份实例配置 `<data root>/deployments/<slug>.yml`（端口、stateDir、`queueDir`、面板标题），
  `installed.json` 记 `project` 与 sha（指纹判定沿用 #39）。
- systemd：一个部署一个 `wca-<slug>.service`，命令形如
  `dsh --profile superagent --patch <data root>/deployments/<slug>.yml`；端口从 3082 起按注册表分配，
  冲突即报错、不自动改。每个部署的 stateDir 独立（`~/.dsh/state/superagent/<slug>`），所以会话、工单、
  worker 都互不可见。
- `wheelchair-agent service status|start|stop|open [--project <p>]`：默认**全部**部署，带 `--project` 只动一个。
- `/restart-wheelchair-agent` 保持「全部停 → 装 → 全部起 → resume 原 spv 会话」的语义，`--project` 只重启一个。
- 每个部署一个面板（自己的端口），彼此独立；`wheelchair-agent spv` 仍只有一个（spv 不是部署）。

## 3. 收件箱（stage 3）

- 收件箱数据根保持**全局** `~/.wheelchair-agent/inbox/`：任何面板打开都看到同一份，对应
  `INSTRUCTIONS.md` 的「包含所有正在管理仓库的 PR」。
- watcher 归属：每份部署只轮询**自己项目**的仓库（`discoverRepos(projectsRoot)` 之后按注册表过滤），所以同一个
  PR 只由一份部署处理 `git pull --ff-only` 与冷安装通知，不会重复。
- 审查结果路由：通过/有问题的评论必须到达**拥有该 item 的部署**——按 item 的 `repo` 反查注册表，写一条
  `kind: "review"` 的队列消息进那份部署的队列，由它的注入器注入 orchestrator → 工单。stage 3 之前，
  单部署行为不变。

## 分阶段与验收

| 阶段 | 交付 | 验收 |
|---|---|---|
| 1（已完成，`#42`/`#43`） | 注册表 + `deployment add|list|remove|migrate` + `dispatch`/`spv_dispatch` 走注册表 + 注入器/`spv_status` 聚合所有注册部署 + 安装契约记 project | 两份注册表条目下 `dispatch` 各写各的队列、两边的回信都回到同一个 spv 会话且不重复；没有条目时报错文案指明下一步；`npm test` 全绿；单部署行为逐字不变 |
| 2（下一步） | 每部署 `install.sh` / systemd 单元 / 端口 / `service --project` / 重启作用域 | 两个部署同时运行、各自面板可达、互不干扰；`/restart-wheelchair-agent` 仍能 resume 原会话 |
| 3 | watcher 按项目归属 + `kind: review` 路由 | 任一面板审一封属于别的部署的信，注入落到正确部署的工单 |

## 不做的事

- **不改 superagent 实现**，也不改它「一份部署一个 `repository`」的语义（见 `ARCHITECTURE/boundaries.md`）。
- 不自动创建部署、不自动改端口、不在 spv 会话里 stop/start 服务（重启只走 `/restart-wheelchair-agent`）。
- 不把 spv 根仓塞进任何部署；`bioagentforge` 只作为 spv 的工作目录存在。

## 与旧设计的关系

旧的单部署把所有项目都塞进 `tools/wheelchair-agent` 这份部署，靠 `trigger.meta.project` 拐一个弯决定 clone
哪个仓库；那份部署的 `deployment.repository` 只能填 `nihaoWX/bioagentforge`（spv 工作目录）当占位，于是 gh 默认
仓库、PR 归属判定、PR 结束通知、每张工单的环境变量全部指向一个与派单无关的仓库。分部署之后这些语义各自归位，
占位仓那段历史留在 `ARCHITECTURE/decisions.md` 里备查。
