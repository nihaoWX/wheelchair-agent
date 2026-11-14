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
- `src/spv.js` 在任务文件没写 `actor` 时回落到 `config.actor`，而 `DEFAULT_ACTOR = 'operator'`。

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
说明这个项目该不该推送。** 实现见 `docs/delivery-target.md`。

## UI 主页：独立包 + 区块数组 + 自包含 core（2026-11-14）

- **面板叫 `wheelchair-agent`，不叫"审查收件箱"**：它是 UI 主页，收件箱只是第一个 section。`PANEL_ID`、
  左侧栏 label、页面 `<title>`/`<h1>` 都是 `wheelchair-agent`；包名仍是 `wheelchair-agent-webui`
  （`dsh-client-modules` 只扫裸包名，而 `wheelchair-agent` 已被主包占用且以子路径挂载）。
- **页面骨架由 `SECTIONS` 数组驱动**：`{ id, label, render }`；加 section = 一个数组项 + 一个
  `render(container)`，不改 rail/tab/body 骨架。不引入插件系统。
- **安装后的包必须自包含**：`install.sh` 把 `src/spv/inbox.js`、`dispatch.js`、`paths.js`、
  `src/shared/queue.js` 拷进包的 `lib/core/`、`lib/shared/`。理由（实测）：22:55 另一个 worktree 的
  `install.sh` 覆盖了共享 preset，删掉了 `src/spv/inbox.js`；若包用 `file://<preset>/...` import，
  下次重启就会 mount 失败。现在的包不依赖 preset 也能加载。
- **每个 PR item 的 read-modify-write 走跨进程锁**：watcher 与评论 POST 是两个进程，单靠原子 rename
  只能防半文件，防不了丢更新；锁文件 + `randomUUID` 临时名同时解决两者。
