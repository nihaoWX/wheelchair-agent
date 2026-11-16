# DeepSeek Harness (dsh) + Command Code GOAT

记录本机 dsh / dsh-TUI 的安装，以及把**模型、web_search、web_fetch** 都接到 Command Code 的方式。
重装、换 profile、升级后按本文恢复。

- 安装日期：2026-11-11（web_fetch 补于同日，superagent 补于同日）
- 平台：Linux (Ubuntu 24.04, WSL2 host)
- 账户：Command Code **GOAT**（除 Go 外的套餐都有 Provider API 权限，按套餐额度计费）

## 1. 组件与版本

| 组件 | 版本 | 位置 |
|---|---|---|
| Node.js | v24.22.2 | `~/opt/node24` → `~/.local/bin/{node,npm,npx}`（优先于 `/usr/bin/node`） |
| `@deepseek-ai/dsh` | **0.2.1-rc.3** | `~/.npm-global/lib/node_modules/@deepseek-ai/dsh` |
| `@deepseek-harness-tui/dsh-tui` | 0.19.0 | 同全局 node_modules |
| `@mars-sea/dsh-commandcode-provider` | 0.17.7 | 装进 profile，作为 bundle（模型 + web_search + 账号池） |
| `dsh-web-fetch-commandcode` | **1.1.0**（自写，带账号池） | `~/opt/dsh-plugins/dsh-web-fetch-commandcode/` |
| **`dsh-superagent`** | **0.1.0（本地构建）** | **`~/opt/dsh-plugins/dsh-superagent/` → profile `superagent`** |
| dsh profile | `dsh-tui` / **`superagent`** | `~/.dsh/profiles/<name>` |

命令：`dsh`、`dsh-tui`、`dst`（`dsh-tui` 短别名）。

分工：

- **模型 + web_search**：`@mars-sea/dsh-commandcode-provider`（第三方，维护活跃）
- **web_fetch**：上游插件只实现了 search（源码里只有 `registerSearchProvider`，README/CHANGELOG/issues 均无 fetch），所以自写了一个极小的 `ctx.web` fetch provider 补上
- 官方 `web-search-deepseek` 仍挂着但不再被选中

## 2. 版本约束（重要）

**dsh 必须锁 `0.2.1-rc.3`，不能是 `0.2.2-rc.1`。**

`dsh-superagent` 的 `engines.dsh` 是 `^0.2.1-alpha.2`，而 semver 的 `^0.2.x` 对 `0.x` 系列**不允许更高的预发布版**：

```
0.2.1-alpha.2  SATISFIES
0.2.1-rc.3     SATISFIES   ← 用这个
0.2.2-rc.1     NOT satisfied
```

好消息：`dsh-tui@0.19.0` 的 peer 依赖列表**明确包含 `0.2.1-rc.3`**，所以两个 profile 可以共用同一个全局 dsh。

## 3. 安装

```bash
# Node 24（dsh 要求 >=24.9；系统 node 是 22）
curl -L -o node.tar.xz \
  https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v24.22.2/node-v24.22.2-linux-x64.tar.xz
mkdir -p ~/opt && tar -xf node.tar.xz -C ~/opt
ln -sfn ~/opt/node-v24.22.2-linux-x64 ~/opt/node24
for b in node npm npx corepack; do ln -sf ~/opt/node24/bin/$b ~/.local/bin/$b; done

# 必须锁版本 + 放行原生模块脚本（npm 11 默认拦截 install scripts）
npm install -g @deepseek-ai/dsh@0.2.1-rc.3 @deepseek-harness-tui/dsh-tui@0.19.0 \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs

# 初始化 profile（只需一次）
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui

# Command Code 插件（作 bundle）
dsh plugin --profile dsh-tui add @mars-sea/dsh-commandcode-provider@0.17.7

# web_fetch provider（本地插件，非 bundle）
dsh plugin --profile dsh-tui add ~/opt/dsh-plugins/dsh-web-fetch-commandcode
```

坑：

- `@deepseek-ai/dsh` 必须写具体版本，浮标签会 `ETARGET`。
- 不放行 install scripts 时 `node-pty`/`koffi` 不编译，TUI 起不来。（降级/重装后要**再跑一次**带 `--allow-scripts` 的命令，否则原生模块会被 reinstall 掉。）
- nodejs.org 走代理极慢会截断，用 TUNA/npmmirror。
- `@mars-sea/...@latest` 会被 pnpm `minimumReleaseAge` 静默解析成旧版，写具体版本。
- npm 走本机代理（`~/.npmrc` 已有 `proxy/http-proxy = http://172.29.240.1:7892`）。

## 4. 凭据（两个账号）

`~/.dsh/.credentials.yaml`（必须 600，dsh 拒绝 group/other 可读的文件）：

```yaml
version: 1

refs:
  COMMANDCODE_API_KEY: <当前在用的账号 key>
  COMMANDCODE_API_KEY_2: <上一个账号的 key，保留作后备>
```

规则：

- **默认槽 = `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`）**，`accounts` 列表里的 ref 是
  **之后的轮换顺序**。顺序按「能用的在前」排：正常请求只用第一把，旧号放在最后，
  只有前面不可用的时候才会去碰它。
- **401 和额度是两件事**。账号 `cmd logout` / 重新登录后，那把旧 key 会被服务端判
  401（`Invalid 'Authorization' header or token`）；这和 5 小时 / 每周窗口用完（429）
  无关。旧 key 留在 refs 里没有副作用——池子跳过它并打一行告警；等那个账号重新登录
  拿到新 key，写回同一个 ref 就原地复活（不用改配置）。
- **加账号走面板**：`/settings` → Command Code → 账户 → 「添加账户」→「网页登录」或「粘贴密钥」。
  provider 侧（聊天 / web_search）的账号、顺序、固定账号**全部由这个面板管**，它会写回
  `apiKeyEnv` + `accounts` 并把 key 落进凭据库；之后 `/commandcode` 能看到每个账号的套餐和
  两个额度条。key 是只写字段，不会回显。
  面板按 `${base}_N` 命名新 ref（`_2`、`_3`…）——我们的 fetch 插件就是靠这个名字自动跟随，
  所以面板加完号，fetch 那边不用改配置。
- 也可以手工往 refs 里加 `COMMANDCODE_API_KEY_N`（同样 600）。**改之前先备份**：
  `cp -a ~/.dsh/.credentials.yaml ~/.dsh/.credentials.yaml.bak-$(date +%Y%m%d-%H%M%S)`。
- 本机 shell 里的 `COMMANDCODE_API_KEY` 可能是旧的；dsh 凭据库优先级高于启动环境，
  所以不必 `unset`。但 `headless` profile 不挂凭据库，只认环境变量（见第 11 节）。
- **superagent profile 也要挂凭据库**，否则 worker 拿不到 key。见第 6 节。

## 5. profile 配置

### dsh-tui

`~/.dsh/profiles/dsh-tui/cordis.patch.yml`：

```yaml
# DSH 层的默认模型（TUI 自己还会读 ~/.dsh-tui/model.json，见下）
- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4-pro

# web_fetch 走 Command Code 的 /alpha/web-fetch（见第 7 节）
- insert:
    - id: web-fetch-commandcode
      name: 'dsh-web-fetch-commandcode'

# 搜索和抓取都 pin 到 commandcode：本地 `http` fetch 后端也挂着，
# 不 pin 会因多后端可用而报 WEB_PROVIDER_AMBIGUOUS。
- id: web
  config:
    searchProvider: commandcode
    fetchProvider: commandcode
```

**账号不在这里手写**：`/settings` → Command Code → 账户 就是它的配置入口，加号 / 改号 /
固定账号都由面板写回 `apiKeyEnv` + `accounts`（key 落凭据库）。本文件只保留上面这几行。

不要在这里再写 `llm-pi-ai` 的 `commandcode` route：会和上游插件注册的 route 撞名，导致插件加载失败。

TUI 自己的默认路由是 `~/.dsh-tui/model.json`，优先级高于 `cordis.yml`：

```json
{ "provider": "commandcode", "model": "deepseek/deepseek-v4-pro" }
```

最省事的改法还是启动后 `/model` 选一次（插件可能把默认改成它自己目录里的型号，例如
`deepseek/deepseek-v4.1-flash`，属正常）。

### superagent

`~/.dsh/profiles/superagent/cordis.patch.yml`：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: /home/nihao/.dsh/state/superagent
```

`stateDir` 是**必填**（数据库、锁、worker 的 git 配置、默认的 Ticket 工作目录都在这）。升级前备份。

**还需要 commandcode provider 的 config 和凭据库**，否则 superagent 的 Session 没有模型可用：

```yaml
- id: llm-commandcode
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    transportMaxRetries: 50
```

> bundle 已注册 `llm-commandcode`，这里只补 config（同 id 合并，不需要 `insert`）。
> 校验：`dsh --profile superagent --dump-config` 里应看到 `transportMaxRetries: 50`。
> 账号（`accounts`）同样由面板管理——superagent 有自己的 web 面板（3082），
> 它的账号页写的是 **superagent 自己的 patch**，和 dsh-tui 相互独立。

## 6. 安装 superagent

```bash
# 从只读参考件 clone 到 ~/opt/dsh-plugins/（不要在 docs/repositories 里构建）
# 为什么不是 tools/：tools/ 放的是我们自己的项目，dsh-superagent 是第三方依赖的本地构建副本，
# 与我们自写的 dsh 插件（dsh-web-fetch-commandcode 等）同级。
git clone /home/nihao/bioagentforge/docs/repositories/dsh-superagent-prototype \
          /home/nihao/opt/dsh-plugins/dsh-superagent
cd /home/nihao/opt/dsh-plugins/dsh-superagent
pnpm install
pnpm build

# 建 profile（只需一次）
dsh superagent --from-default-profile web --dump-config > /dev/null

# 装 bundle
dsh plugin --profile superagent add "link:$PWD"

# ★ 关键：必须手动把 bundle 加进 profile 的 bundles 列表，
#   `dsh plugin add` 只写 dependencies，不会写 bundles。
#   编辑 ~/.dsh/profiles/superagent/package.json：
#     "dsh": { "profile": { "bundles": [
#         "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-superagent" ] } }
```

坑：

- **`dsh plugin add` 不自动注册 bundle**。不加进 `bundles` 会报
  `patch: entry "dsh-superagent" not found`。
- `--dump-config` 是校验手段：出现 `- id: dsh-superagent` 和 `stateDir:` 才算成功。
- 构建产物在 `~/opt/dsh-plugins/dsh-superagent/lib/`，`link:` 方式安装所以改代码后重新 `pnpm build` 即可，不用重装。
- 没有 `~/bioagentforge/tools/dsh-superagent` 这个路径（早先的符号链接已删）。它不在 `tools/` 下，不是 `tools/<name>` 项目，所以**不派 worker 维护**：它是跑 worker 的那个服务本身，改完要 `pnpm build` + 重启服务才生效，而重启会打断正在跑的工单（闭环在 worker 手里合不上），坏的 build 还会让 `spv_dispatch` 这条派活通道一起挂。改它属于 SPV 自己的活。

## 7. 启动与状态

```bash
cd /home/nihao/opt/dsh-plugins/dsh-superagent
python3 scripts/dsh-superagent start    # 是 python 脚本，不是 sh
python3 scripts/dsh-superagent status
python3 scripts/dsh-superagent stop
```

本机首选 `wheelchair-agent service start|status|restart`：它包了上面这个上游脚本（同样的退出码、同样的 tmux 会话名、
同样优雅 SIGINT），但不用 `ps -o ucomm=` 判断进程——那在 WSL2 上会把 Node 进程报成 `MainThread`，于是脚本看不到进程、
`restart` 只会打印 "An existing orchestrator answers at this URL" 而不真的重启。

或者直接：

```bash
dsh --profile superagent --no-open      # 前台
tmux attach -t dsh-superagent           # 脚本启动的实例
```

**面板**：`http://127.0.0.1:3082/?token=<log 里的 token>`

```bash
grep -o 'token=[A-Za-z0-9_-]*' $(ls -t .artifacts/*.log | head -1) | cut -d= -f2
```

**状态 API**（不经 token，脚本和排障用）：

```bash
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state
```

退出码：`0` 正常；`1` 没跑/重复/不通/运行时错误（可 restart）；`2` 某组件报错（restart 无效）；`3` 等待 setup（restart 无效）。

### 已知：脚本 start 的"健康检查超时"

`scripts/dsh-superagent start` 偶发打印 `Startup health check timed out`，但**服务其实已经在跑**
（`tmux ls` 有 `dsh-superagent`、端口 3082 返回 303/401）。用第 7 节的 `curl .../orchestrator/api/state` 核实，
不要据此判定启动失败、也不要重复 start。

## 8. 两个 Command Code 服务

| 能力 | 端点 | 谁在实现 |
|---|---|---|
| 模型 | `/provider/v1/{chat/completions,responses,messages}` | `@mars-sea/dsh-commandcode-provider` |
| web_search | `POST /alpha/web-search`，`{query,numResults}` → `{results:[{title,url,snippet}]}` | 同插件（默认开启） |
| web_fetch | `POST /alpha/web-fetch`，`{url,format}` → `{content,url,status}` | 自写 `dsh-web-fetch-commandcode` |

`alpha/*` 两个端点不在公开的 Provider API 文档里，是 Command Code CLI 自己的内置工具在用
（`dist/cli.mjs` 里可搜到），已实测 200、同一把 key。

自写 fetch provider 的要点：

- 注册 id `commandcode`（fetch 注册表；search 注册表里的同名 id 由上游插件占用，两者独立）
- 默认 `format: markdown`，返回 `body.kind = 'text'`，不再走本地 turndown
- `available()` 只做 URL 合法性检查；`ready()` 检查至少有一把 key（都不联网）
- **账号池（1.1.0 起，抄上游 provider 的轮换语义）**：
  - 槽位顺序 = `apiKeyEnv`（默认槽，可回落 `~/.commandcode/auth.json`）→ `accounts` 列表；
    没写 `accounts` 时自动跟随 `COMMANDCODE_API_KEY_2`、`_3`…（也就是面板加账号后不用改配置）
  - **401** → 该 key 作废到「key 值变化」为止（标记按 key 指纹记，不按 ref 名），换下一个账号，
    stderr 打一行：`account "default" rejected its key (401) — switching to "..."`。这一行就是
    「某个号退出登录了」的信号，和额度无关。
  - **429** → 用 `/alpha/billing/credits` 读真实窗口（fiveHour / weekly 取较晚的重置时间）做冷却，
    打一行带重置时间；全部账号都被标记时再探一次，窗口真的重置了就直接恢复，不用重启进程。
  - **5xx / 传输错误 / 403(Cloudflare)** 不轮换，直接抛错——不把一次故障藏到另一个账号后面。
  - `activeAccount` 可钉住某个账号优先（它耗尽后再回落常规顺序）。
  - 全挂时的报错会逐个列出账号、原因和最早重置时间，不会只说一句 "failed"。

对比本地 `web-fetch-http`（undici GET + turndown）：Command Code 服务端会做 JS 渲染、bot 防护和
正文抽取，所以 SPA / Cloudflare 站和“干净程度”上更好；本地则是匿名直连、不占额度、不外发 URL。

## 9. 验证记录

| 检查 | 结果 |
|---|---|
| `curl /provider/v1/models` | 200，97 个模型 |
| `curl /chat/completions`、`/v1/messages` | 均 200 |
| `curl /alpha/web-search`、`/alpha/web-fetch` | 均 200 |
| `dsh --profile dsh-tui --dump-config` | `llm-commandcode` + 两个 web provider 已合成，`fetchProvider: commandcode`（`accounts` 出现即面板已配账号） |
| TUI 内对话 | 返回 `ok` |
| TUI 内 `web_search` | 返回搜索结果 URL |
| TUI 内 `web_fetch example.com` | `Fetched https://example.com/ (HTTP 200)` + 正文 |
| 直接调用自写 fetch provider | 200，18.5k 字符干净 markdown |
| `dsh --profile superagent --dump-config` | `- id: dsh-superagent` + `stateDir` + `transportMaxRetries: 50` 已合成，exit 0 |
| superagent 服务启动 | 进程在跑，3082 监听，`/orchestrator/api/state` 返回 health |
| superagent setup 状态 | `setupPending` / `repositoryUnset`（未配 GitHub Source，属预期） |
| 凭据库各 ref（`/alpha/whoami`） | `COMMANDCODE_API_KEY` → 200（`zqliangjintaoje4w`，5h $0.62/14、周 $0.62/35）；`COMMANDCODE_API_KEY_2`（已退出账号的旧 key）→ 401；`COMMANDCODE_API_KEY_3`（面板新加的）→ 200，**同一个账号的另一把 key** |
| fetch provider 账号池测试 | `node --test tests/pool.test.mjs` 7 项全过（401 轮换 / 429 学重置 / 冷却期内不重试 / 5xx 不轮换 / 自动跟随 `_N` / 钉账号 / 无 key 报错） |
| 真实 key 端到端 `web_fetch` | 200，`example.com` 正文 171 字符；默认槽直接命中，无切换告警 |

`dsh-tui doctor` 除 `DEEPSEEK_API_KEY` 未设置（只影响 DeepSeek 官方模型路由）外全部通过。

## 10. 日常使用

```bash
dsh-tui            # 启动 TUI（首启 4 步向导，Esc 跳过）
dsh-tui --resume   # 恢复上次会话
dst                # 同 dsh-tui
dsh-tui doctor     # 环境自检
dsh-tui update     # 对齐 TUI / dsh 引擎 / 启动器（★ 会改 dsh 版本，见第 2 节）
```

- 换模型：`/model`；Command Code 插件在 `/settings` 里还有账号、配额、可见模型、ZDR 等页面
- 计费：模型与搜索都走 GOAT 套餐额度，和 CLI 共用
- 模型清单以 `GET /provider/v1/models` 为准

### 换号 / 加号

```text
/commandcode        # TUI 内：每个账号的套餐 + 5 小时/每周额度条 + 重置时间
cmd status          # CLI 当前登录的账号（只报身份，不报额度）
```

- **加一个号**：`/settings` → Command Code → 账户 → 「添加账户」→「网页登录」或「粘贴密钥」。
  provider 侧账号全由面板管（它会写 `accounts` 到当前 profile 的 patch、key 落凭据库）；
  我们的 fetch 插件自动跟随面板命名的 `COMMANDCODE_API_KEY_N`，不用改配置。
  如果那一页在 superagent 的面板里（3082），写的就是 superagent 自己的 patch。
- **顺序**：默认槽（`apiKeyEnv`）在前，`accounts` 依次在后。把还有额度的放前面；暂时不用的号
  留在最后即可，不用从 refs 里删——它 401 时会被跳过并告警，恢复后自动回到可用。
- **只看额度**：`GET /alpha/billing/credits`（同一把 key），返回 `windowLimits.{fiveHour,weekly}`
  的 `used/cap/exceeded/resetAt` 和 `credits.monthlyCredits`。

## 11. 已知事项

- **启动告警** `patch: entry "tool-ralph" / "tool-subagent-list-agents" not found`（dsh-tui 0.19.0 +
  dsh 0.2.2-rc.1 时出现）。dsh 0.2.1-rc.3 下如有类似告警，属可选插件缺失，无害。
- **升级后**若 profile 被模板重置：重写第 5 节的 patch，重跑第 3 节后两条 `dsh plugin add`，
  并恢复 `~/.dsh-tui/model.json`。
- **`dsh-tui update` 会把 dsh 升回 0.2.2-rc.1**，届时 superagent 会因 engines 不兼容而加载失败。
  升级后须手动降回 `0.2.1-rc.3`（第 3 节，记得带 `--allow-scripts`），或等 superagent 放宽 engines。
- **上游插件若以后实现 fetch**：会与自写 provider 抢 `commandcode` 这个 fetch id，注册会抛
  `WEB_DUPLICATE_PROVIDER`。届时删掉第 5 节的 `insert` 行和自写插件即可。
- **`headless` profile 不挂凭据库**（`id: credentials` 为 `disabled: true`），只认环境变量；
  要用凭据库需在 `--patch` overlay 加 `- id: credentials` + `disabled: false`。
- **superagent 的 GitHub Source 目前未配置**，服务停在 `setupPending`。要用它得先装 `gh`、
  建 agent 账号、在面板里填 repository（或改用自写 Source 跳过 GitHub）。
- **额度**：superagent 每个 Ticket 起一个 worker，Eval + worker 都走 GOAT 额度，
  与 CLI 共用 5 小时 $20 / 每周 $50 的窗口。先用 `observe` 模式（SETUP 默认）观察消耗。
- **401 不是额度问题**：账号退出登录 / 重新登录后，旧 key 会被服务端判 401，池子会把该账号
  标记为 invalid 直到 key 值变化；429 才是 5 小时 / 每周窗口用完。看到
  `rejected its key (401)` 就去重新登录那个号、把新 key 写回同一 ref。
  旧 key 会不会在重新登录后自己恢复**未确认**，所以两个号的 key 都留着：能用的一把在前。
- **账号池是进程内存态**：重启后重新学一次标记。失效 key 放在最后时，正常请求只用第一把，
  不会因此付一次 401；只有在前面账号不可用时才会去试它。
- **面板只管自己那个 profile**：dsh-tui 的面板写 dsh-tui 的 patch，superagent 的面板写 superagent
  的 patch，两边账号各自管理、不互相同步；凭据库是共用的。
- **面板分配 ref 会跳过已占用的名字**：`COMMANDCODE_API_KEY_2` 里还留着旧号的 key 时，
  新加的号会落成 `_3`。旧 key 确认没用了就把 `_2` 删掉，fetch 那边少一个要跳过的死槽。
- **同一账号贴两把 key 不涨额度**：`/alpha/whoami` 返回同一个 `userName` 就说明它们共享同一组
  5 小时 / 每周窗口，轮换没有意义（只在 401 时有一点用）。要确认是不是真·第二个号，看 `userName`，
  而不是看 key 字符串是否相同。
