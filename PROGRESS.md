# Current State

**可用**：SPV 会话 + superagent 服务端到端跑通。链路
`spv_dispatch` → 文件队列 → Trigger → superagent 主 Session（评估/路由）→ Ticket → worker（项目 clone 内执行）
→ `reply` 写回队列 → 会话内注入器作为新消息推进对话。没有 `spv_result`、没有超时。

**入口**：`wheelchair-agent` 是唯一命令（`spv` / `prepare` / `service` / `jobctl` / `dispatch` / `status` /
`inbox` / `work` / `restart-all` / `session` / `hook` / `where` / `check`）。`spv`、`superagent-service`、
`jobctl` 是它的兼容薄壳。

**数据根**：`~/.wheelchair-agent/`（`settings.json`、`inbox/`、`records/`、`logs/`），与 superagent 不耦合；
队列仍在 `~/.dsh/state/superagent/spv/`，superagent 自己的 state 在 `~/.dsh/state/superagent/`。

**面板**：dsh web 里左侧栏 `wheelchair-agent`（功能宿主，不是 iframe），当前两个功能——收件箱、设置。
`webui.style` = `fluid`（默认）/ `minimal`；两页共用 1200px 宽度变量，收件箱无左侧日期栏。
面板 URL 每次服务重启都换 token，只能从 `wheelchair-agent service status` 的 `panel:` 行或
`wheelchair-agent service open` 取（见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`）。

**服务**：当前跑在用户级瞬时 unit `wca-svc.service`（app.slice，不在任何 logind session scope 里），
不是从终端直接起的 tmux server。`wheelchair-agent service stop/start` 会把它拉回调用者 scope，慎用。

**插口（hooks）**：stage 1 已合并并安装（`#28`）：事件表（`src/shared/hook-events.js`）、引擎
（`src/shared/hooks.js`）、设置块 `hooks`、CLI `wheelchair-agent hook …`、`docs/hooks.md`。
**事件尚未接线**（stage 2 在 ticket `29ffe928` 上进行），所以现在挂脚本不会被触发。

# Completed

- **面板（`#27`）**：960→1200px 共用宽度变量；收件箱去掉 104px 日期栏、时间进每封信；`fluid` 重做材质
  （色调洗 + 发丝边 + 两层阴影 + 挂载即播的错峰入场），`minimal` 严格静止。
- **插口 stage 1（`#28`, `27d4463`）**：8 个事件 id、7 条内建行、脚本执行（stdin JSON + `WCA_*` 白名单、
  超时/截断/串行/软失败）、cursor 去重、`records/hooks.jsonl` 记账、`hook prompt` 生成可复制提示词。
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

- **hooks stage 2**（ticket `29ffe928`，thread `hooks`）：把事件接上——队列 `acknowledgement/reply/notice` →
  `ticket.{acknowledged,delivered,attention}`、收件箱 `approved/issue/merged`、`prepare.sh` 与 `dispatch.js`
  通过 spool 发 `ticket.started` / `spv.dispatch`。

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
- **两个新压缩设置是 API-only**：dsh-superagent 的 `src/client/eval.tsx` 没有 `compactRatio` / `compactMinIntervalMs` 的输入项。
- **"待冷安装"没有自我清除机制**：每次 install 仓库合并都会排一封 notice，即使几分钟后就装了。

# Next Steps

1. hooks stage 2 回来 → 审 diff / CI 绿 → 合并 → 派 stage 3（面板「插口」一节：事件含义、内建行可改名、
   最近 5 次执行、`hook prompt` 原样展示）。
2. 重派 `service-detach`（带禁令），并把 `service open` 作为最后一步并入 `/restart-wheelchair-agent`
   （`src/spv/restart.js` + `tests/test-restart.mjs`，见 `docs/PITFALLS/dsh-web-panel-token-is-per-instance.md`
   的「改法」一节）。
3. 建 `dsh-superagent` 的 HARNESS 脊梁（`ARCHITECTURE.md` + `core/executor/sources/panel/operations/modules/tests`），
   把 007 拆开并 repoint `tests/docs.spec.ts`；顺带把两个压缩设置做进面板。
4. 把"已装 sha"落盘，让面板/通知能自己判断"待冷安装"是否还成立。
