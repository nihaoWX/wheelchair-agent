# 已定型的约束（勿重复推导）

本文件收集**讨论已经结束**的结论。每一条都附了证据或实测结果，下一个 agent 不要重新推导一遍。
新增结论时写在这里，`ARCHITECTURE.md` 只留一行索引。

## 压缩成本：接受一次性 worker

原规划是单会话 worker 持续长期推进，靠上下文压缩节省 token，但 superagent 是一次性 worker。
疑问：新开一次性 worker 会不会省一次压缩的成本？

一次性 worker 会把 `ARCHITECTURE.md`、`PROGRESS.md` 等再读一遍，所以两种方案不一定谁成本更低。
实测里一次性或单会话、不干预的话，一个任务上下文占用都能到 90% 以上，**两者都避免不了压缩**。
既然避免不了，就顺着 superagent 做一次性 worker。

**未解决**：压缩时机应是「上下文已用 20% 左右 + 小阶段目标完成」，这个判断需要模型介入，目前没有方案。

## 降噪靠架构，不靠规则

痛点是「spv 和 worker 间收发消息会淹没用户跟 spv 的交流」。根因不是消息太多，而是**消息承担了状态的职责**。
过滤来自两处：superagent 的 worker 权限（worker 不会有任何信息外发）和它自带的机会触发 orchestrator（第二层过滤）。

**因此不要在本项目里加任何"消息分级规则"**——那是在架构之上叠规则，反而更脆。

## dsh 版本锁 `0.2.1-rc.3`

superagent 的 `engines.dsh = ^0.2.1-alpha.2`，semver 对 `0.x` 预发布版的规则使 `0.2.2-rc.1` 不满足。
`dsh-tui@0.19.0` 的 peer 列表含 `0.2.1-rc.3`，两个 profile 共用同一个全局 dsh。
**`dsh-tui update` 会升回 `0.2.2-rc.1`**，届时须手动降回并带 `--allow-scripts`（否则 `node-pty` 不编译）。

## GOAT 套餐可驱动任意 harness

`BYOK` 是"key 进 Command Code"（不耗额度），`Provider API` 是"key 出去"（耗额度）。要的是后者，
官方原文 *"any client or agent can use them. No lock-in. Use it anywhere."*，已实测
`/provider/v1/{models,messages}` 均 200。**CLI 与 API 共用同一份额度**（5 小时 $20 / 每周 $50），
所以 `maxWorkers=2`。

## 派任务入口：CLI 可以，沙箱暂不做（2026-11-14 修订）

**旧结论**（已作废）：派任务入口必须是 agent 工具，不能是 CLI 脚本，因为 `spv_send.py` 可被任何有 bash 的
agent 调用，而它投递的任务默认以 `operator` 身份进入 superagent，worker 跑一下就能伪造成用户派活。

**修订理由（实测）**：这个洞**现在就已经开着**，加 CLI 不新增它。

- `scripts/spv_send.py` 的 `--actor` 默认 `None`，不传就不写 `actor` 字段；
- `src/superagent/spv.js` 在任务文件没写 `actor` 时回落到 `config.actor`，而 `DEFAULT_ACTOR = 'operator'`。

所以今天任何有 bash 的 worker 跑一句 `spv_send.py "..."` 就已经是 operator 身份。in-process 工具从来没
提供过隔离，它只是让**文档里的入口**看起来是 agent 工具。

**用户裁决**：worker 本来就没有沙箱，想破怎么都能破（一般来说不会，worker 只专注下派的任务）。
**沙箱暂时不做**，`wheelchair-agent` 形态干净更重要。

**仍然成立的部分**：`actor` 由代码写死为 `operator`、不接受参数。CLI 的 `dispatch` 子命令与
`spv_dispatch` 工具 import 同一个 `src/spv/dispatch.js`，`ACTOR` 常量只有一处定义。

## 长任务不留在 worker 会话里

worker 回合结束后其 shell job 最多再跑 30 分钟即被杀（`src/executor/dsh.ts` 的 `BACKGROUND_LIMIT_MS`），
所以长时间分析不能留在 worker 会话里。交给 systemd user manager 持有（`jobctl`），
下一阶段的触发器是**作业自己的结束事件**（`ExecStopPost` 写队列），不依赖 worker 自觉、全局 goal 状态
或定时轮询。`/spv-cron` 每小时机械检查一次，漏挂的作业顶多一小时内被发现。

## SPV 遇上游 API error 停下：`wontfix`（账本 `R3-F1`）

不是"没接上重试"，也不是"code 不在白名单"。实测 SPV 会话里真实报错的 code 是 `TRANSPORT`——它**在**
provider 白名单里（`EMPTY_RESPONSE / RATE_LIMIT / THROTTLED / SERVER / TIMEOUT / TRANSPORT`，
`maxRetries: 1000`）。真正先动手的是 provider 自己注册的 `agent/request-error` 监听器：它用一份**独立的
transport 预算**（`transportMaxRetries`，默认 5、上限 50）吸收前 5 次失败（实测 6 次尝试、间隔约 770ms），
第 6 次抛出一个**普通 `Error`**；普通 Error 不是 `HarnessError`，`dsh-llm` 只能把它的 code 记成 `UNKNOWN`，
于是轮次以 `turn/end reason=error` 结束。59 份会话日志里**没有任何 `llm/retry` 事件**，说明
`dsh-llm-retry` 从未被轮到——provider 的监听器抢在它前面。

这是上游的**刻意设计**（issue #39：把 transport 宽限压到约 15.5s，避免整轮卡死几分钟），本仓库没有任何
代码参与，故按外部/上游限制处理、不改代码。

**绕行**：① 在启动 DSH 的 shell 里导出 `HTTPS_PROXY`/`HTTP_PROXY`（DSH 只读环境变量，不读 Windows
系统代理/PAC）——报错文案本身就这么说；② 调高 `llm-commandcode` 的 `transportMaxRetries`（0–50），
代价是网络真断时轮次会卡更久。

**注意**：旧结论里"把 `retryPolicy` 调成 `always`"对这条失败**无效**，因为 provider 的监听器在策略被查询
之前就抛了。worker 侧不受影响是因为 superagent 自带独立重试（`TRANSIENT_TRIES = 3`、15s 退避、
认 408/429/5xx 与 ECONNRESET 等）。

## 交付目标随项目走：不与环境变量对抗

worker 环境里的 `DSH_SUPERAGENT_GITHUB_REPOSITORY` 永远是面板那一个单值，而任务自带 `project`，
两者可以指向不同项目且无任何标记。**曾因此把一个 `tools/pitfalls-manager` 的 PR 开到了
`nihaoWX/bioagentforge`。**

三条配置绕行路已实测堵死（关 github Source 会停在 `setupPending`；`spv` 声明同名变量只是并排渲染两行；
编排器 API 锁死在配置仓库）。**已定方向：不与环境变量对抗，改为给 worker 一份它读得到的 `AGENTS.md`，
说明这个项目该不该推送。** 实现是 `commands/prepare.sh` + `install.sh`；六条约束记在 `ARCHITECTURE/preset.md`。

## UI 主页：独立包 + 区块数组 + 自包含 core（2026-11-14）

- **面板叫 `wheelchair-agent`，不叫"审查收件箱"**：它是 UI 主页，收件箱只是第一个 section。`PANEL_ID`、
  左侧栏 label、页面 `<h1>` 都是 `wheelchair-agent`；包名仍是 `wheelchair-agent-webui`
  （`dsh-client-modules` 只扫裸包名，而 `wheelchair-agent` 已被主包占用且以子路径挂载）。
- **页面骨架由 `SECTIONS` 数组驱动**：`{ id, labelKey, titleKey, descriptionKey, Component }`（5 个键）；加 section = 一个数组项 +
  一个 React 组件，tab 条与内容区都从它生成。不引入插件系统。
- **安装后的包必须自包含**：`install.sh` 把 `src/spv/inbox.js`、`dispatch.js`、`paths.js`、
  `src/shared/queue.js` 拷进包的 `lib/core/`、`lib/shared/`。理由（实测）：22:55 另一个 worktree 的
  `install.sh` 覆盖了共享 preset，删掉了 `src/spv/inbox.js`；若包用 `file://<preset>/...` import，
  下次重启就会 mount 失败。现在的包不依赖 preset 也能加载。
- **每个 PR item 的 read-modify-write 走跨进程锁**：watcher 与评论 POST 是两个进程，单靠原子 rename
  只能防半文件，防不了丢更新；锁文件 + `randomUUID` 临时名同时解决两者。

## UI 主页改为原生 React 页面（2026-11-15）

- **页面在 `main` slot 里渲染 React，不用 iframe**：官方 `cordis-plugin-development` 的 `practices.md`
  明确禁止「Host 发 HTML 再 iframe 嵌入」——iframe 文档拿不到 host 的 theme token、light/dark 与
  `ctx.locale`。旧的 `pageHtml()`、`/wheelchair-inbox/page` 与独立页因此删除；Host 只保留
  `/wheelchair-inbox/items`、`/wheelchair-inbox/review` 两个 JSON 路由。
- **不 require `@deepseek-ai/dsh-client-ui-primitives`**：同一份规范禁止把 Harness Client 包当模块加载
  （无类型检查、随版本变动、组件抛错会清空 slot）。控件、Markdown 渲染器与 CSS 都写在
  `lib/client.js`，只 require `react` / `react/jsx-runtime`；class 一律加 `wca-` 前缀。
- **PR 正文用自带的 Markdown → React 渲染器**（标题、嵌套列表、fenced code、行内代码、粗斜体、链接、
  引用、水平线、GFM 表格、段落；图片渲染成 alt 文本链接，不支持 HTML 透传/脚注/公式）。产出 React 元素
  而非 `innerHTML`，所以 GitHub 正文不会变成 HTML 注入；默认折叠，展开才解析；嵌套深度有上限并有
  try/catch 兜底，恶意正文不会把 slot 打崩。
- **样式只用 `--dsw-alias-*` 等 host token**（颜色、边框、圆角、字号、代码字体），抄 Plugin Manager
  页的间距/字号节奏，不写死颜色，因此浅色/深色都跟 host 走。
- **页面是功能宿主，不是收件箱页**：导航列功能（`SECTIONS`），活动功能渲染在自己的带边框面板里（标题、
  说明、筛选/刷新工具栏、行列表）；PR 列表嵌在收件箱功能面板内。加功能 = 一个数组项 + 一个组件。
- **审查模型只有 `approve` / `issue`**：通过只记录、不发消息；有问题正文必填并给 SPV 入口会话发一条
  `notice`（PR 的 thread 是 `inbox-<pr>`，SPV 决策信回到自己的 thread），不派 worker 任务。
  状态不落盘，由最新 review 派生（`pending` / `approved` / `issue`）；旧 `question`/`fix` 只在读取时
  映射成 `issue`，不改磁盘记录。筛选默认「待审」，另有全部 / 有问题 / 已通过；已通过行降低对比度。

## SPV preset：普通 dsh 会话 + `spv_*`，纯增量（2026-11-14）

**结论**：SPV 就是一个普通 dsh 会话，只是额外有 `spv_*` 工具。`preset/agent.cordis.yml` 里那句
「本文件刻意不挂 subagent / todo / web / plugin-manager / goal / plan-mode」作废。现在照 dsh-tui 的
liangshen preset 原样挂全套标准工具行（`tool-fs-search`、`bootstrap-filesystem`、`tool-jobs`、
`tool-goal`、`planning`、`delegation`（含 `subagent`）、`tool-ask-user`、`tool-todo`、`tool-web`），
`tool-fs` 不再只读。`subagent` 用于不需要 PR 的调研，要交付 PR 的代码活仍走 `spv_dispatch`。

**修订（2026-11-18，操作者）**：这条分工原本写在 preset 的 `persona` 里，现在**整段 persona 已删除**——
SPV 的系统提示词与普通 dsh 会话完全一致，不再注入任何关于 wheelchair-agent / spv 的说明（`AGENTS.md`
与工具元数据已经交代过）。派单契约全部搬进 `spv_dispatch` 的工具描述；`tests/test-preset.mjs` 断言
渲染出的 preset 里没有 persona、且该描述含"交付走派单"和"不等不轮询"两条。

**不照抄 liangshen 的 preset 本地插件**：`tool-bootstrap.mjs` / `instruction-hint.mjs` /
`skill-search.mjs` / `custom-bash.mjs` 是 dsh-tui 包内的本地文件，不是 dsh 包。挂它们要把 **6 个**
`.mjs` vendor 进本仓库——那 4 个加 `compaction-epoch.mjs` 与 `session-events.mjs`
（`tool-bootstrap.mjs` 引 `compaction-epoch.mjs`；`instruction-hint.mjs` 引两者；`compaction-epoch.mjs`
又引 `session-events.mjs`）；而且 `tool-bootstrap` 把首轮工具面砍到
`[bash, str_replace_editor]`（首轮没有 `spv_dispatch`）并抑制 `agent-instructions` 与 skill
catalog，`instruction-hint` 则是**替换** `dsh-agent-instructions`，而 SPV 要保留真注入。
skill 改用 dsh 包 `skill-filesystem` + `tool-skill`（内容来自 PR #3 的 commit `6f38eef`；那条 PR 的
base 是 `agent/cli-restructure`，从未进过 `main`）。

**验证**：`install.sh` 与 `install.sh --check` exit 0；`dsh --dump-config --patch …` exit 0 且新行
都落在 `preset-spv` 块内；`tests/test-layout.sh` / `tests/test-prepare.sh` /
`tests/test-injector.mjs` / `npm run check` 全绿。

## 面板样式：fluid 默认，minimal 是逃生口（2026-11-16）

**结论**：`webui.style` 是普通 enum 设置，`fluid` 默认、`minimal` 可切，两者共用同一版面和控件；换样式
只换材质/动效，不换结构。版面用卡片和间距分组，**不用分隔线**：没有 day rail、卡片内的 inset seam 或
review 左侧竖线；分隔靠 group card、留白和字重。每封信有状态 spine，操作固定在卡片底部；PR 与
`spv_message` 只差 radius 8/14px、inset +4px、spine 4/5px、glyph 与 brand/info tint。

**材质**：颜色/边框/圆角全部走 `--dsw-alias-*` token；`backdrop-filter` 只给卡片，不支持的浏览器退回
不透明 token 背景 + 同一组两层阴影（tint 仍在）。动效只在 fluid 下：enter `cubic-bezier(.22,1,.36,1)`、
exit `cubic-bezier(.4,0,.2,1)`、无 `linear`、press `scale(.985)` 120ms、展开 240ms（内容晚 40ms）、
状态 pill `clip-path` 200ms、approve 让 spine 交叉淡入并让卡片下沉 1px、轮询新增信件按 id 做一次 30ms
错峰入场；`prefers-reduced-motion: reduce` 全部关掉，焦点只用 `:focus-visible` ring。

**草稿**：收件箱审查草稿按 item id 存 `localStorage`，切页回来还在，提交成功才清，卡片上有 `Draft`
标记；设置表单同样按 revision 存，409 后 Reload 保留草稿并重挂到新 snapshot。localStorage 被拒时两者
退回内存副本。空设置文件由 `install.sh` 与 host mount 以 `wx` 补上，绝不用解析后的默认值回写。

**证据**：`webui/docs/panel-style-{before,after}-*.png`（同 fixture、1440×900、light；另有 1000px 与
dark 截图），`tests/test-settings.mjs` 的 CSS/轮询/草稿断言，`tests/test-install.sh` 的 0644/空文件/
不覆盖断言。**2026-11-16 更正**：`backdrop-filter` 在不透明的页面底色上模糊的是底色本身，等于什么都不做，
所以 `fluid` 的层级**不靠** blur，而靠色调洗（tonal wash）+ 带色发丝边 + 两层阴影；`@supports` 退回分支保留，
用于完全没有模糊能力的环境。

## 插口（hooks）：可配置的是副作用，不可配置的是核心（2026-11-16）

在核心事件上挂用户脚本，手感对齐 superagent 的 `executor.prepare`。三条边界定死：

- **core path 不可配置、不可取消**：review 落盘、notice 进 SPV 队列、合并后的 `git pull --ff-only`、队列的
  rename 消费永远发生。hook 失败/超时/输出洪水只记账，不 gate、不包裹、不重试 core path——否则一个写坏的
  脚本就能让收件箱罢工。
- **内建行只描述、不执行**：`builtin:prepare / injection / prIssue / spvObjection / reviewRecord / mergePull /
  coldInstallNotice` 在设置里可见、可改名（`labels`），但不可删除；其中"文本可编辑、触发不可取消"的（注入消息、
  issue 通知）指向现有模板 id，不新造第二份文案。
- **新增 = 一段可复制的提示词，不是 UI 里的 shell 输入框**：`wheelchair-agent hook prompt <事件>` 生成中文说明
  （事件含义 / 何时触发 / 能触发几次 / 载荷字段 / 该写成什么 `hook add`），面板原样展示。加脚本永远由 agent 落笔。

事件名的诚实性：`ticket.delivered` 而不是 `ticket.ended`——队列只给 `acknowledgement / reply / notice`，
拿不到工单终态，叫 `ended` 的名字会被后来的人用错。冷安装挂 `inbox.merged` 而不是 `ticket.delivered`：
挂在 worker 报告上会在 PR 存在之前就触发。

## orchestrator 保留在派单路径上（2026-11-16）

`spv_dispatch` 的 trigger 会先进主 Session（评估→`orchestrator_route`）再建票。对 explicit 请求它没有判断要做，
只有命名（title / worktree_name）和一句 acknowledgement，但**决定不删这条快路**：它在推断型触发（GitHub/飞书）
上是真正的产品能力，且作为质量门成本很低。若将来要加速，只做"explicit 且 source=spv 时直接 accept"的最小快路，
保持 `leftToWorkers` 语义；**不要**把整个评估层去掉。

## 主 Session 也要按水位线压缩（2026-11-16）

`dsh-compaction-basic` 的默认阈值是 **80%**，主 Session 活整个部署周期，20%→80% 这一段每一轮都在为历史付费。
因此在 dsh-superagent 里加 `eval.compactRatio`（默认 0.2，0 关闭）与 `eval.compactMinIntervalMs`（默认 60s）：
只对主 Session、复用 `sessions.compact()` 的软失败语义、压成功后**必须重新测到一次低于阈值**才允许下一次（防陈旧
样本反复压）。它只**前置**通用策略，不替换。已知缺口：这两个键目前只有 API，面板没有输入项。

## 服务必须离开调用者的 cgroup scope（2026-11-16）

`service start` 用 tmux 起服务时，node 进程继承调用者的 systemd cgroup scope：从 dsh 的工具 shell 起就落在
`dsh-terminal-<pid>-<hash>.scope`，那个 scope 一被拆（会话重置），服务被整组 SIGKILL，且**没有任何日志**。
从操作者终端起则落在 `session-N.scope`，宿主 logind 一崩（本机实测 `systemd-logind/resolved/timesyncd` 会在开机
191 秒时 SIGABRT）同样连坐。所以：起服务必须**离开调用者 scope**（用户级瞬时 unit：
`systemd-run --user --unit=… --property=RemainAfterExit=yes --property=KillMode=none`，PATH 需含
`~/.local/bin` 与 `~/.npm-global/bin`），并在启动后**验证** `/proc/<pid>/cgroup` 与调用者不同，否则不许打印
`OK: running`。

## 面板宽度与 fluid 材质（2026-11-16）

收件箱与设置页共用 **一条**宽度变量 `--wca-content-max: 1200px`（`AGENTS.md` 之外的 960 旧值 × 1.25，操作者口径），
两页不可能再各走各的。收件箱不再有左侧 104px 日期栏，时间落到每封信自己的元信息行——空列是"太偏右"的根因。
`fluid` 的可见性靠材质与**挂载即播**的入场动画（不再门控 `data-new`），`minimal` 严格静止；两者布局结构完全相同。

## Rust 核心：独立进程，不是 Node addon（2026-11-18）

**决定**：把能用类型检查守住的一部分逻辑搬进 Rust，产物是**独立可执行文件**
（`crates/wca-core` → `wheelchair-agent-core`），JS 用 `spawnSync` 走 JSON 契约调用；不用 napi-rs 的 `.node`。

**理由**（按权重）：
1. 目的只是编译器，不是性能。实测 spawn ≈ 0.7–1.0 ms，而轮询节奏 1–60 秒，进程边界不花钱。
2. `.node` 里的一次 panic 会让 dsh 服务或 SPV 会话 abort；二进制里只是一条命令失败。降低爆炸半径是这个决定的主因。
3. 二进制是单文件、不耦合 Node-API/glibc；schema 由 `schemars` 生成、两侧用 `src/shared/schema.js` 校验，
   比 FFI 值转换更容易独立测试。
4. loader 事实上两条都允许（它只约束入口是一次 ESM `import()`），所以这条是**取舍**而不是限制。

**配套的硬规则**：搬过去的模块**只有一份实现**——`src/shared/work.js` 在二进制缺失时抛错并打印
`bash build/build-core.sh`，永不退回 JS。Rust 侧对调用方输入一律 `Result`，`src/` 里不出现
`unwrap`/`expect`/`panic!`。

**已知未了**：冷安装多了一步前置（要有 cargo），与"面向大众一键安装"冲突，发布前必须改为按平台预编译；
`CORE_BINARY` 与 `CORE_ARTIFACT_REL` 目前写死 `linux-x64`。两者都记在 `ARCHITECTURE/core.md`。

## 重启恢复的目标由"发命令的会话"决定，不由 `resume.txt` 决定（2026-11-24）

**决定**：`/restart-wheelchair-agent` 的恢复目标是**发起命令的那个 Session**（命令插件从
`invocation.agent.session.id` 取，CLI 以 `--session` 接收）；`~/.dsh-tui/resume.txt` 降级为**兜底**，并且只
在没有 `--session`、或那个 id 在工作区解析不到时才用。任何 lease holder 只有在**重启链内**才会被发信号。

**理由**：`resume.txt` 是 dsh-tui 的**全局"最后打开"指针**。操作者在 A 终端发命令、B 终端后开时会话，指针
指向 B —— 重启于是"恢复"了 B 的会话，并且 `releaseSession` 把 B 终端持有该会话租约的进程 SIGTERM/SIGKILL
掉。这是实打实的两个 bug 叠加（`#36`/`19e71c4`），不是配置问题。拿"谁发命令"当唯一可信来源，就不再依赖
任何跨终端的全局状态。

**取舍**：真遇到"同一会话被另一个终端占着"时**开新会话并说明被占用**，不抢占。抢的收益是省一次手动 `/resume`，
代价是结束别人的终端；我们选省掉那个代价。显式的 `session release` 行为不变（它不传 chain，仍释放所有
非服务 holder）。

**守住它的测试**：`tests/test-restart.mjs` 的 `testForeignHolderIsNotKilled`（外来 holder → `kill` 一次都没
被调用，dry run 里出现在 `other:` 行而非 kill 集合）与 `--session` 优先于 `resume.txt` 的用例。
