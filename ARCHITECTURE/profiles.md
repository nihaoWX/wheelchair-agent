# 三份自建 dsh profile：`wca` / `wca-spv-tui` / `wca-spv-web`

> 索引见 `ARCHITECTURE.md`。决策记录（为什么不是别的形状）见 `ARCHITECTURE/decisions.md` 的
> 「两个 profile 对应两种交互形状」（`#74`）与「`wca-spv-web` 用自建 profile 而不是原生 preset」（`#76`）。

## 0. 为什么只能按"整进程"切

- 一个 dsh profile = **一套完整的 dsh**：`package.json` 的 `dsh.profile.bundles` 是一张平表
  （`@deepseek-ai/dsh-base` + **一个** surface bundle + 若干插件 bundle），没有父子继承，
  `dsh --patch` 只是**运行期** overlay，不产生新 profile。
- 所以"一个 web 底座 + 两种前门"拼不出来；能切的粒度就是 profile = 进程。三份 profile 因此三份目录
  `~/.dsh/profiles/{wca,wca-spv-tui,wca-spv-web}`。

| profile | 谁在跑 | 谁起它 | 启动 overlay | stateDir | 端口 |
|---|---|---|---|---|---|
| `wca` | 面板 + 每份 orchestrator 实例（浏览器面） | `wheelchair-agent service start`、`panel start` | 实例 `deployments/<slug>.yml`；面板 `deployments/panel.yml` | 实例 `<stateDir>`；面板 `<data root>/panel` | 实例 `deployments.json` 的 `port`；面板 `panel.port`（3080） |
| `wca-spv-tui` | spv 会话（终端面，`spv.surface=tui` 默认） | `wheelchair-agent spv` → `spv-launcher.sh` | `~/.dsh/.agent-presets/spv/preset-default.patch.yml` + `DSH_TUI_PRESET=spv` | dsh-tui 自己的 `~/.dsh-tui` | 无 |
| `wca-spv-web` | spv 会话（浏览器面，`spv.surface=web`） | `wheelchair-agent spv`、`service start --all` | `deployments/spv.yml`（只带端口） | `<data root>/spv` | `spv.webPort`（3081） |

`wca` 的 bundles：`dsh-base` + `dsh-web-app` + `dsh-superagent` + `@mars-sea/dsh-commandcode-provider` +
`dsh-context` + `billion-context` + `wheelchair-agent`（`link:`）。`wca-spv-tui`：`dsh-base` + `dsh-tui` +
commandcode + bili（**不带** `dsh-superagent`/`dsh-context`/我们的 webui）。`wca-spv-web`：`dsh-base` +
`dsh-web-app` + commandcode + bili + `wheelchair-agent`（**不带** `dsh-superagent`/`dsh-context`/webui）。

`wca-spv-web` **不是部署**：它不写 `deployments.json`、不进 `deployment list`、面板「项目」页把它当 spv 的
一行显示（`spv.running`/`spv.url`），而不是一个 orchestrator 实例。

## 1. 模板与渲染（真源是模板，不是已装的 profile）

- 模板：`preset/profiles/<id>.package.json` + `preset/profiles/<id>.patch.yml`；`install.sh` 与
  `wheelchair-agent profiles sync` 把占位符替换后写到 `~/.dsh/profiles/<id>/`。
- 占位符：`@SERVICE_PORT@`、`@STATE_DIR@`、`@SPV_PLUGIN@`、`@SPV_CRON_PLUGIN@`、`@SPV_RESTART_COMMAND@`、
  `link:@WHEELCHAIR_AGENT@`、`link:@DSH_SUPERAGENT@`。模板里**不许**出现本机绝对路径。
- 为什么不再"互相镜像"：`#63` 时面板 profile 的 patch 是从 `superagent` 的 patch 逐行镜像的，结果
  `activeAccount` 只写进了源 profile，面板就没有可用账号。现在每份 profile 都由模板渲染，源是模板文件。
- 模块解析：patch 层的模块解析基址是 **profile 目录**，所以我们的插件行必须用 `file:` URL
  （`@SPV_PLUGIN@` 等渲染成 `file://…`）；`wheelchair-agent`、`dsh-superagent` 这类裸名靠
  `package.json` 里的 `link:` 依赖落进 profile 的 `node_modules/`。`profile-links.json` 记录我们建过的
  软链，回收只看它记过的条目。

## 2. 迁移（只搬、不删）

| 旧 | 新 | 做法 |
|---|---|---|
| `profiles/superagent` | `profiles/wca` | 整体 `renameSync`（保住 `node_modules` 里的 `link:`），`deployments.json` 的 `profile` 字段改写 |
| `profiles/wca-tui` | `profiles/wca-spv-tui` | 整体 `renameSync`；两个都在时只用新的 |
| `profiles/wheelchair-agent`、`profiles/panel` | — | 只在 `--check` 打 note"可手删"，**从不自动删** |

`deployments.json` 里坏掉的 JSON 不重写（宁可报 problem 也不猜）。迁移之后指向旧 profile 名的设置键就成了死键——
`panel.profileFrom` 已按这条路径删掉（issue #77 / PR #78）：`crates/wca-core/src/settings.rs` 的 `RETIRED_KEYS`
让旧 `settings.json` 里的残留值**静默丢弃**（不当成拼写错误告警），下一次写盘不再带它。以后每删一个键都往这个
列表里加一行。

## 3. `spv.surface` / `spv.webPort`

- 两个键都在 Rust schema（`crates/wca-core/src/settings.rs`）：`spv.surface` ∈ `{"tui","web"}`（默认 `tui`）、
  `spv.webPort` 1–65535（默认 `3081`）。非法值有专门报错：`spv.surface must be one of "tui", "web", got "browser".`
- `wheelchair-agent spv` 读设置选形状：`tui` ⇒ 走 `preset/spv-launcher.sh`（设 `DSH_TUI_PROFILE`，
  `wca-spv-tui` 缺失时回落 dsh 自带的 `dsh-tui` 并打一行 note，绝不因此起不来）；`web` ⇒ 走 `spv-host.js`。
- web 形态的三态（`spvHostState()`）：`free` ⇒ 前台起 host；`running` ⇒ **不再抢占端口**，打印日志里最后一条
  token URL 后 exit 0；`occupied` ⇒ 报 pid 与 `kill -INT`，不自己杀。
- `service start --all` 只在 `spv.surface=web` 时把 spv host 算进那一圈（部署先、spv 后、面板最后）；
  `service stop --all` 只要该形态的配置在就停。spv host 失败不改部署的退出码。

## 4. 活体判定契约（最容易写反的一条）

dsh web 在 `/` 上**没有会话 cookie 时回 401**（`@deepseek-ai/dsh-client-connection` 的 `writeUnauthorized()`），
带 `?token=` 才 303 换 cookie、之后 `/` 才是 200。所以：

- "**有人在服务**" = 收到**任何**状态码。`probeSpvWebHost()` / `probePanelHttp()` 返回 `statusCode`，
  连不上或超时才是 `null`。
- "**是我们的 host**" = 日志里存在 token URL，**且**（读不到 pid/cmdline 时以日志为准；读得到时
  `/proc/<pid>/cmdline` 必须含 `--profile wca-spv-web`）。

`#76` 第一版写的是 `response.status === 200`，结果 host 真在跑时反而被判成"端口被占"、
`spv.running` 永远 false。改这种代码前先 curl 一次现场。

## 5. 手抄的三行与 parity 闸门

`preset/profiles/wca-spv-web.patch.yml` 里的 `spv-tools` / `spv-cron` / `restart-command` 三行是
`preset/agent.cordis.yml` 的**镜像**（这份 profile 不挂原生 preset，靠进程级插件行给 spv 那套工具）。
`tests/test-profiles.mjs` 有一条 parity 断言逐字比对 `name:`，失败信息会指明"`preset/agent.cordis.yml` 是真源"。
**新增 SPV 插件行时两处都要改。**

`wheelchair-spv`（`wheelchair-agent/spv-watch`）**不**在这份 profile 里：它 `inject: ['orchestrator']`，而这份
profile 不带 `dsh-superagent`，挂上只会一直 pending；spv host 只发单、不接单。

worker 结果能进 web 形态的 spv 会话，靠的是 `src/spv/tools.js` 挂的 `startResultInjector()`：它每 tick 读各
部署的 `outbox/`，`consumeMessage` 把文件 rename 进 `outbox/read/` 再注入；`getAgent()` 还没有 agent 时
**不消费**（否则消息会被丢在没有读者的地方）。

## 6. 命令与常见 problem

- `wheelchair-agent profiles sync`：渲染/更新三份 profile（`panel sync` 是它的别名）；`profiles check`
  只读，有漂移 exit 1。
- 常见 problem：`profile "wca" is missing; the old "superagent" profile is still installed`；
  `deployments.json still points at a legacy profile: …`；`the panel overlay is missing at
  <data root>/deployments/panel.yml`；`profile "wca-spv-web" is missing (spv.surface is "web")`。
  这些都指向"跑一次 `install.sh`"或"跑一次 `profiles sync`"。
- 并存态（新旧目录都在）一律是 **note** 而不是 problem：`profiles sync` 在目标已存在时故意不搬，
  把"并存"写成 problem 会让 `--check` 永远红。
