# 目标目录布局（2026-11-14 定案，已实现）

本文件是**实现契约**。worker 按此移动文件、改 import、改 `install.sh`；不要重新设计。
实现落在 `agent/cli-restructure` 分支（PR #2），下面「目标布局」一节即当前布局。

## 为什么改

现状的 import 图是干净的——两侧零交叉 import，`ARCHITECTURE.md` 里写的"严格分开、互不 import"在代码里
是真的做到了。**乱的不是代码，是布局没把已经存在的边界画出来**：`src/` 平铺 8 个文件，名字里没有一个字
说它属于哪一侧，每次读都得重新推一遍。

这个边界在运维上也是真的：`install.sh` 的白名单只装 SPV 侧，superagent 侧靠 profile 的 `node_modules`
软链加载、**从不进 preset 目录**。布局应该让这件事一眼可见。

## 目标布局

```
wheelchair-agent/
├── bin/wheelchair-agent.mjs      # CLI 入口：argv 解析 + process.exit，仅此
├── src/
│   ├── shared/                   # 两侧共用，唯一的契约
│   │   ├── queue.js              # 文件队列布局与读写（pending/done/outbox）
│   │   └── schema.js             # 极简 schema 校验
│   ├── superagent/               # 只被 superagent profile 加载
│   │   ├── spv.js                # spv Source kind（Trigger/Channel/Policy）
│   │   └── watch.js              # 插件入口：注册 kind + 轮询循环
│   └── spv/                      # 只被 SPV preset 与 CLI 加载
│       ├── paths.js              # 队列根解析（config > env > stateDir）
│       ├── dispatch.js           # 写 pending/，ACTOR 写死 operator
│       ├── outbox.js             # 读/消费 outbox/ 的原语（没有阻塞读取器）
│       ├── injector.js           # 后台注入器：新 reply/notice 消费后注入会话
│       ├── health.js             # 探健康端点，服务没跑就拒绝派活
│       ├── inbox.js              # 收件箱：item 存储、gh 轮询、approve/issue→队列、面板 JSON 路由
│       ├── cron.js               # `/spv-cron` 逻辑（纯逻辑，注入依赖）
│       ├── tools.js              # 插件入口：spv_dispatch / spv_status + 持有注入器
│       └── cron-plugin.js        # 插件入口：`/spv-cron` 薄壳
├── webui/                        # 独立 dsh web client 包 wheelchair-agent-webui
│   ├── package.json              # dsh.client + exports ".", "./client", "./package.json"
│   ├── lib/index.js              # host 半身：/wheelchair-inbox/* 与 /wheelchair-settings JSON 路由
│   ├── lib/client.js             # 手写预构建 bundle：功能宿主 + 收件箱面板 + 自带 Markdown 渲染器
├── preset/                       # 原 dsh/：装到 ~/.dsh/.agent-presets/spv/
│   ├── preset.yml
│   ├── agent.cordis.yml          # 工具面 + compaction 组
│   ├── spv-launcher.sh           # 启动器模板（先拉起服务，再开 TUI）
├── commands/                     # 会被装成独立命令的实现
│   ├── prepare.sh                # 面板 prepare 命令的实现（保持 sh，见下）
│   ├── jobctl.py
│   └── superagent-service.py
├── build/render-preset.mjs       # 构建步骤，不是命令
├── tests/                        # 12 套离线可跑证据（CI 逐个跑，清单见 package.json 的 test 脚本）
│                                 #   prepare / layout / install / restart / inbox / inbox-refresh /
│                                 #   injector / settings / work / home / clone-guard / hooks
├── install.sh                    # 只负责安装
├── AGENTS.md / ARCHITECTURE.md / PROGRESS.md / ARCHITECTURE/
└── docs/
```

## 三条机械可查的规则

1. `src/superagent/` 不许 import `src/spv/`，反之亦然。
2. `bin/wheelchair-agent.mjs` 不许 import `src/superagent/`（CLI 是操作者的工具，Source kind 是服务的）。
3. `src/` 与 `bin/` 里任何文件不许 import `@deepseek-ai/*` 或任何 dsh 包。

规则 3 的由来：`src/spv/tools.js` 头部注释已写明——本包是用户级 preset 引用的普通目录，不在 dsh 安装树里，
`@deepseek-ai/dsh-tools` 这个 bare specifier 从本包位置解析不到，preset 会整个 mount 失败。所以工具用
原始 JSON Schema 注册，参数校验自己写。

**验收**：`tests/test-layout.sh`（新增）用 `grep` 扫 import 行，三条规则各至少一条断言，违规即 exit 1。

## `package.json` 的 exports 键保持不变

`~/.dsh/profiles/wca/cordis.patch.yml`（`#74` 前叫 `superagent`）用 bare specifier `wheelchair-agent/spv-watch` 引用插件，
那是**仓库外的操作者状态**。所以 exports 的**键**是公开 API，只改它指向的文件：

| 键 | 现在 | 之后 |
|---|---|---|
| `./spv-watch` | `./spv-watch.js` | `./src/superagent/watch.js` |
| `./spv-tools` | `./spv-tools.js` | `./src/spv/tools.js` |
| `./spv-cron-plugin` | `./spv-cron-plugin.js` | `./src/spv/cron-plugin.js` |
| `./queue` | `./src/queue.js` | `./src/shared/queue.js` |
| `./spv` | `./src/spv.js` | `./src/superagent/spv.js` |

**删掉 `index.js` 与 `main` 字段**：现在 `import 'wheelchair-agent'` 会注册一个 Source，这是个坑。
`exports` 里每个入口都显式命名，不需要默认入口。

## `prepare.sh` 保持 sh，不重写

298 行 POSIX sh + 77 条断言已经跑通。`wheelchair-agent prepare` 的实现是 `exec sh commands/prepare.sh "$@"`。
重写成 node 是风险远大于收益的改动。**这是唯一一个实现不是 node 的子命令，必须在 `ARCHITECTURE/cli.md`
里写明原因**，否则下一个 agent 会以为是漏改。

## 安装布局：只加一样东西

| 装什么 | 装到哪 |
|---|---|
| preset（`preset.yml`、`agent.cordis.yml`、`preset-default.patch.yml`、`package.json`） | `~/.dsh/.agent-presets/spv/` |
| SPV 侧 JS（`src/spv/*`、`src/shared/*`）+ `cli.js` + `agentsmd-examples/` + `prepare.sh` + `commands/` | `~/.dsh/.agent-presets/spv/` |
| **webui 包**（`package.json`、`lib/index.js`、`lib/client.js` + 拷进去的 inbox core） | **`~/.dsh/profiles/superagent/node_modules/wheelchair-agent-webui/`（新增）** |
| **webui loader 行**（`- insert: id: wheelchair-webui`） | **`~/.dsh/profiles/wca/cordis.patch.yml`（append-only）** |
| **`wheelchair-agent` CLI 薄壳** | **`~/.local/bin/wheelchair-agent`（新增）** |
| `spv` 启动器 | `~/.local/bin/spv` |
| `superagent-service` | `~/.local/bin/superagent-service` |
| `jobctl` | `~/.local/bin/jobctl` |

CLI 薄壳把 preset 目录路径烧进去（和 `spv` 启动器同样的 `sed s|@SPV_HOME@|...|` 手法），内容是
`exec node <preset>/cli.js "$@"`。

**为什么不另建 `~/.local/lib/wheelchair-agent/`**：那样 SPV 侧代码会有两份（preset 目录一份、lib 一份），
或者 preset 目录只剩 4 个 yml 而 `file://` URL 指向 lib。两种都比现在多一个概念，收益只是"preset 目录
里不放 CLI"。preset 目录实际上就是"SPV 侧的已安装包"，放 CLI 不违和。

**`webui/` 是第四种安装目标，不是第五个 CLI 子命令包。** 它必须落在 profile 的 `node_modules` 里，因为
`dsh-client-modules` 从 profile 的 module 解析基址找 `dsh.client`；preset 目录不在那条解析链上。它的
`lib/client.js` 是**预构建 bundle**（`window.__ModuleLoader__.load(...)`），本仓库没有 TS/构建链，所以手写；
它只 require `react` / `react/jsx-runtime`，自带 Markdown 渲染器与控件，页面直接渲染在 host 的 `main` slot。
host 半身 `lib/index.js` 在 profile 里运行，**可以** import dsh 服务；`src/` 与 `bin/` 的规则 3 不适用于它。
`install.sh` 把 `src/spv/inbox.js` + `dispatch.js` + `paths.js` + `src/shared/queue.js` 拷进包的
`lib/core/`、`lib/shared/`，让面板不依赖共享 preset。

## `install.sh` 的契约（冷安装 only）

`install.sh` 是唯一的安装入口，**它自己不能在被装的东西正被使用时运行**：

| 行为 | 契约 |
|---|---|
| 装什么 | preset 目录、webui 包 + loader 行、`~/.local/bin` 四个薄壳；**拷贝不是软链** |
| 目标被占用 | superagent 服务或活着的 SPV 会话持有目标时 `exit 3`，并往 SPV 队列写**一条** notice（说明停谁、按什么顺序来） |
| `--check` | 只读，比对"装进去的 == checkout"；过期/缺文件 `exit 2`，绝不写 |
| 原子性 | 先在本目录暂存，再替换目标；失败回滚，不留半装的目录 |
| 幂等 | 内容相同则不动；空设置文件用 `wx` 创建，不用解析后的默认值回写 |
| 唯一自动化的替代 | `/restart-wheelchair-agent`（`wheelchair-agent restart-all`）：停服务 → 等会话租约 → 冷安装 → 起服务 → 同终端 `--resume` 拉回会话 |

## 顺手清掉的死东西

| 东西 | 处理 |
|---|---|
| `ARCHITECTURE/` | **保留**（操作者 2026-11-14 明确要求），本次按架构拆分内容进去 |
| `scripts/__pycache__` | 现在靠 `.git/info/exclude` 排除，**不是 `.gitignore`**，新克隆会看到。写进 `.gitignore` |
| `scripts/spv_send.py` / `spv_read.py` | **已删除**。CLI 做出来后队列格式不该有两份实现（JS 一份、Python 一份），必须永远保持字节兼容 |
| `index.js` | 已删除（见上） |
| `~/.dsh/profiles/dsh-tui/node_modules/wheelchair-agent` | 11-12 的真实目录副本（不是软链，只有 4 个文件），无任何 yml 引用。**仓库外，worker 不动**，由 SPV 处理 |

## 实现时定下的两件事（契约没写，但必须选一个）

1. **`jobctl` 的 `--next` 交接走 CLI，不再走 `spv_send.py`。** 那个脚本删掉后，`ExecStopPost` 脚本改成
   `node <cli> dispatch --project … --task … --thread …`。CLI 路径按「`$WHEELCHAIR_AGENT_CLI` →
   `<preset>/cli.js` → `<checkout>/bin/wheelchair-agent.mjs` → PATH」解析：systemd 的 PATH 不是操作者的
   登录 shell PATH，所以绝对路径优先。
2. **`preset/wheelchair-agent.sh` 是 CLI 薄壳的模板**，与 `spv-launcher.sh` 同样用 `@SPV_HOME@` 占位符。
   安装后它是 `~/.local/bin/wheelchair-agent`，内容是 `exec node <preset>/cli.js "$@"`。不用软链：preset
   目录是原子替换的，软链会短暂指向不存在的路径。

---

# 当前目录布局（2026-11 现状；以上是 11-14 的定案记录）

**布局与三条机械可查的规则见 `ARCHITECTURE/layout.md`（`tests/test-layout.sh` 逐条断言）。**
`src/` 已按 `shared/` `superagent/` `spv/` 三分，边界在布局上一眼可见。

```
wheelchair-agent/
├── bin/wheelchair-agent.mjs      # CLI 入口：argv 解析 + process.exit，仅此
├── src/shared/                   # 两侧共用、纯 Node builtins（home, queue, schema, settings, work, hooks, hook-events）
├── src/superagent/               # 只被 superagent profile 加载（spv.js 定义 Source kind，watch.js 跑轮询）
├── src/spv/                      # 只被 SPV preset 与 CLI 加载（paths, dispatch, outbox, injector, health,
│                                 #   inbox, cron, tools, cron-plugin, check, hook, restart, restart-ux,
│                                 #   restart-command, session, panel-instance, profiles, spv-host,
│                                 #   deployment-policy, service-instance, archive-effect, auto-merge-effect）
├── preset/                       # 装到 ~/.dsh/.agent-presets/spv/（preset.yml, agent.cordis.yml, spv-launcher.sh）；
│                                 #   panel.patch.yml 是独立面板实例的 --patch overlay
├── commands/                     # 会被装成独立命令的实现（prepare.sh, jobctl.py, superagent-service.py）
├── webui/                        # 独立 dsh web client 包 wheelchair-agent-webui（装进 superagent profile，见下）
├── build/                        # 构建步骤，不是命令（render-preset.mjs, refusal-notice.mjs）
├── tests/                        # 12 套离线证据，清单见 ARCHITECTURE/layout.md（CI 逐个跑）
├── install.sh                    # 只负责安装（冷安装，契约见 ARCHITECTURE/layout.md）
├── crates/wca-core/               # Rust 核心 wheelchair-agent-core（work-plan / schema 子命令）
├── ARCHITECTURE.md ARCHITECTURE/  # 定义 + 索引 + 分册（构建规则只允许记在这里）
└── docs/                         # 只剩 PITFALLS/（旧 md + round-data/ 证据）、setup/、agentsmd-examples/
```

安装布局：preset 目录是「SPV 侧的已安装包」（含 `cli.js`、`src/{shared,spv}/`、`commands/`、`prepare.sh`），
`~/.local/bin/wheelchair-agent` 是薄壳，`spv` / `superagent-service` / `jobctl` 是它的兼容名。
superagent 侧的 `src/superagent/` **从不进 preset 目录**：那个 profile 用自己的 `node_modules` 软链加载它。
`webui/` 是**第四种安装目标**：`install.sh` 把包拷进 `~/.dsh/profiles/wca/node_modules/wheelchair-agent-webui/`（`#74` 前叫 `superagent`），
并往该 profile 的 `cordis.patch.yml` 追加一行 loader（见下）。`#74` 改成**每份 profile 都从模板渲染**：`preset/profiles/<id>.{package.json,patch.yml}` →
`~/.dsh/profiles/<id>/`（`wheelchair-agent profiles sync`，`install.sh` 也做），三份 profile 与各自的 overlay 见
`ARCHITECTURE/profiles.md`；`profile-links.json` 记下我们建过的 `node_modules` 软链，回收只看这些。
面板不再是「镜像来源 profile」的独立目录：它跑的是 `wca` + `deployments/panel.yml`（关四行）。

**`install.sh` 的契约在 `ARCHITECTURE/layout.md`**：只做冷安装（服务或活着的 SPV 会话占着目标就 `exit 3` 并写一条
notice）、`--check` 只读地比"装进去的 == checkout"（过期 `exit 2`）、**拷贝不软链**、暂存后原子替换、幂等。
