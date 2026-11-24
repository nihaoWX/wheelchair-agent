# worker 会话归档：可行性、现状与方案

状态：调研完成，待操作者选方案。本文只整理证据，不包含实现。工单 `d2088229a67e394cb8bcd7fedbacf00c`。

被调研的指令是 `INSTRUCTIONS.md:24`：

> worker的会话在`ticket.delivered`后归档，理由是webui如果不归档这些积压的会话会很乱，归档也是可以取消的，
> 如果这个worker未来再次被拉起，可以取消归档。

（相邻的一条也定义了 `ticket.delivered` 在操作者语境里的含义：`INSTRUCTIONS.md:23` 说它"相当于一次worker的成功工作完成
结束（它有可能被再次拉起，所以名字不叫工单结束）"。）

## 结论

1. **能做，而且 dsh 原生支持会话归档**，不用我们自造"归档"概念。`workspaceRegistry.archiveSession()` 把会话 id 记进
   registry-global 的归档集合，日志原地保留、不移动文件；`unarchiveSession()` 取消。Web UI 自带 Archive/Unarchive
   菜单、`⌘⇧A` 快捷键和"显示已归档 / 只看已归档"筛选，dsh-tui 读同一份集合。
2. **票面说的"`src/` 零命中，完全没实现"只对 wheelchair-agent 成立。** superagent 已经在 `ticket.ended` 时归档
   worker 会话（`worker-<ticketId>`）。本机现状：57 个 `worker-*` 会话里 55 个已归档，剩下 2 个正好是 2 张
   **未结束**工单（本票和 `a465…`）。也就是说 WebUI 当前的 worker 会话积压是 2 条，不是 55 条。
3. 真实缺口只有一个：**`ticket.delivered` 到 `ticket.ended` 之间不归档**。要补，改动只能落在 wheelchair-agent
   （`INSTRUCTIONS.md:28`："dsh-superagent能不改就不改"；`ARCHITECTURE/spv-source.md:16`："`~/opt/dsh-plugins/dsh-superagent/src/`
   一个字节都不能改"），做法见 §6 方案 A。
4. **"把会话目录移走"不是归档，且后果严重**：`--resume` 硬失败、SPV 会话被静默重建成空会话、运行中的会话会分裂到
   两个位置。否决，见 §4。
5. 推荐 **方案 A**（满足字面指令：每次 `ticket.delivered` 后归档），代价与三个实现要点见 §6；若操作者认为
   "工单结束后不积压"已足够，则**方案 B**（现状 + 手动归档，零改动）。放开 superagent 禁令也能改，但 delivered 不是它的域事件，
   不是一行能改完的（方案 D），且违反上面两条禁令。

## 1. 先对齐：什么是"归档"，以及当前到底积压了多少

dsh 的归档**不是删除，也不是移动文件**：它把 id 写进 `~/.dsh/storages/workspace.json` 的
`global.archivedSessionIds`（unit `{name:"workspace", version:2}`），日志目录原地不动，随时可以取消。

本机实测（只读）：

| 事实 | 值 | 怎么核对 |
|---|---|---|
| 工单 | 59 = 57 已结束 + 2 未结束 | `orchestrator.sqlite` 的 `ticket` 表；未结束的是本票和 `a465b91dba77d003f069ed4317baf8a9` |
| `worker-*` 会话目录 | 57 | `find ~/.dsh/sessions -maxdepth 2 -name 'worker-*' -type d \| wc -l`；目录名后缀就是工单 id |
| 没有会话目录的已结束工单 | 2 | `2fc0a885…`、`8033a742…`（从未启动 worker） |
| 已归档的 `worker-*` id | 55 | 全部属于已结束工单（另 2 张从未启动 worker，没有可归档的会话）；`global.archivedSessionIds` 里以 `worker-` 开头的项 |
| 未归档的 `worker-*` | 2 | `worker-d208…`（本票）、`worker-a465…`（冷安装警告票），即 2 张未结束工单 |

归档集合里另有 20 个旧式 `session-<uuid>` 和 20 个裸 uuid（更早的会话），说明这套归档在本机已经用了很久，
不是实验性路径。

> 核对 `orchestrator.sqlite` 时**必须连同 `-wal`/`-shm` 一起复制**再读；只复制 `.sqlite` 会读到过期快照（本次调研
> 踩过：只拷主文件时 `ticket` 表读到 0 行）。

### 1.1 归档的精确语义（决定方案能不能满足指令）

- 归档集合是 **registry-global**，不是"某个 workspace 隐藏"：所有分组、搜索（默认筛选下）和 dsh-tui 都受影响
  （`dsh-workspace/lib/types/index.d.ts:190-260`）。
- **不影响 workspace 记账**：`sessionIds` 槽位保留，取消归档后回到原位（同上）。
- **不删日志**：dsh 核心没有会话删除 API（只有 dsh-tui 自己的 `rmSync`）；Web UI 没有删除入口（§3）。
- **归档后拒绝新 step**：`dsh-api-session-controller/lib/types/archived-session-gate.js` 在 `agent/pre-step` 检查当前 Session 或其
  subagent 祖先是否在归档集合里，命中就拒绝这一步，turn 以 `blocked` 结束；取消归档后整条 lineage 恢复。
- **可以带 `stopActivity`**：`archiveSession(id, {stopActivity:false})` 先问 `workspace/session-activity`（只有"正在
  running 的 turn"算活动），有活动就拒绝（`WorkspaceActiveSessionError`）；`{stopActivity:true}` 先写归档再通知
  `workspace/session-stop` 提供方（turn、subagent、jobs、schedule），**会杀掉后台 job**
  （`dsh-workspace/lib/index.js:526-620`；job 侧 `dsh-jobs/lib/index.js:20-42`）。所以"delivered 后归档"不能用 `true`：
  worker 可能刚把 server 之类交给用户（superagent `handOff` 语义），杀了就违背交接。

## 2. Q1：WebUI 的会话列表从哪来

一条链，全部是目录扫描，没有会话索引/SQLite（`dsh-session-query-sqlite` 只做内容检索，`:memory:`）：

1. 前端 `session.list` → `dsh-api-session-controller/lib/client.js:3245`。
2. RPC 描述 `'session/list'`（`dsh-api-session-controller/lib/typert.host.js:1635`，"Read all visible Session rows without
   resuming an Agent"）。
3. Host handler 再用 `remoteAccess.allows(...)` 过滤（`dsh-api-session-controller/lib/index.js:3061-3065`）。
4. `ApiSessionList.list()`（`dsh-api-session-controller/lib/index.js:1951-1990`）：冷会话只在 `record.header.cwd !== undefined`
   时出现（`types/list.js:121-127`），按 `updatedAt` 倒序。
5. `sessionQuery.listSessions`（`dsh-session-query/lib/index.js:95-117`）：`persistence.list()` ∪ 活着的会话。
6. `dsh-session-persistence-jsonl/lib/index.js:2603,3506-3524,3435`：`readdir(~/.dsh/sessions/<project>/<id>/)`，取最新
   一代 `session.v<N>.jsonl[.zstd]` 的首行做 header；根目录来自 `dsh-base/cordis.patch.yml:138-141`
   （`dshHomePath('sessions')`）。

**出现条件**：`~/.dsh/sessions/<project>/<id>/` 下有一次可解析的 generation（header 读得出来），或会话正活着；
冷会话还要求 header 里有 `cwd`。**归档不参与 `session/list` 的过滤**——归档是客户端 `sessionVisible()` 的筛选
（`dsh-client-ui-workspace/lib/client.js:964-973`），默认 `archivedFilter: "default"` 即"不显示已归档"
（`:1269-1274`），菜单里可切 `hide-archived/show-archived/only-archived`（`:2878`）。所以已归档会话仍然在列表数据里，
只是默认不画出来；"只看已归档"能看到并取消归档。

分组：`dsh-workspace/lib/index.js:762-767,897-898` 按每个 workspace 的 `sessionPaths`（由 header `cwd` 得来）分桶；
不属于任何 workspace 的会话显示为"未分组"（`client.js:4754`）。

## 3. Q2：dsh 支持的"隐藏/归档/删除"入口

| 入口 | 证据 | 说明 |
|---|---|---|
| 服务 API | `dsh-workspace/lib/index.js:526/553`（`archiveSession`/`unarchiveSession`），另有 `pinSession`/`unpinSession` | 唯一写入归档集合的正式途径 |
| RPC | `dsh-api-workspace-controller/lib/typert.host.js:344`（`workspace/archiveSession`，参数 `sessionId` + 可选 `stopActivity`）、`:601`（`workspace/unarchiveSession`）；`:453` 推 `{type:'archived', archivedSessionIds}` 变更 | 前端拿到的就是它 |
| Web UI 菜单 | `client.js:4137`（`ArchiveSessionMenuItem`）、`:4156`（行内按钮）、`:4183`（`SessionArchiveConfirmDialog`，会列出将被停掉的活） | 归档/取消归档都有菜单项 |
| 快捷键 | `client.js:176` 注册 `session.archive` = `KeyA` + primary/shift（`⌘⇧A` / `Ctrl+Shift+A`） | 手动归档的最短路径 |
| 撤销 | `client.js:4681-4720` 的 toast（`archived`/`stoppedAndArchived` + `toast.archivedUndo`）、`:5164` 接线 | 归档后几秒内可撤销 |
| 筛选 | 见 §2（`sessionVisible` + 视图菜单） | 取消归档后立刻回到默认视图 |
| dsh-tui | `dsh-tui/lib/types/dsh-adapter/channel/session-metadata.js:18-27` 读同一份 `archivedSessionIds`；`sessions/workspaceCounts.js:14` 计数排除；Ctrl+D 归档（`i18n.js:598-602`，`useSessionSupervisor.js:57`） | 归档是跨前端共享的状态，不是 WebUI 私有 |

**没有**的东西（都查过）：

- Web UI 没有"删除会话"。dsh-tui 有硬删除（`session-metadata.js:254-267`、`compat/sessionLog.js:1165-1190` 的
  `rmSync(dir,{recursive:true,force:true})`），但 Ctrl+D 的删除分支被 `!dshBackend` 挡住
  （`SessionSupervisor.js:346`），dsh 后端下只提供归档。
- 会话 header 里没有 `archived` 字段（`dsh-session/lib/types/types.d.ts:59-110`），归档只存在于 `workspace.json`；
  `grep -ril archiv ~/.dsh/sessions` 为 0 个文件。
- persistence 没有删除 API；`dsh-session-projection-cache` 没有可见性字段。
- "删除 workspace"只是解除分组：`client.js:4801/4923` 写明"其会话将显示在'未分组'下"。

结论：`archiveSession` 正好是"隐藏但可取消、日志不丢"的唯一正式实现，和指令的措辞（"归档也是可以取消的"）完全对应。

## 4. Q3：如果走"把会话目录移走"会怎样（否决）

移动**不损坏字节**，但会同时踩三类问题：

1. **显式按 id 访问 → 硬失败**：`dsh-session-persistence/lib/index.js:28`（`session "<id>" not found`）、
   `dsh-session-persistence-jsonl/lib/index.js:2524`（`SessionPersistenceNotFoundError`）；`dsh --resume <id>` /
   `dsh-tui --resume <id>` 非零退出（`dsh-tui/lib/types/dsh-adapter/plugin.js:3091`："no fresh session was started
   instead"）；`~/.dsh-tui/resume.txt` 从不过期校验，`--resume` 不带 id 会一直失败；会话内 `/resume` 只弹错误 toast
   （`session-resume.js:105`）。
2. **按 id 推导的消费者 → 静默重建空会话**：`dsh-api-session-controller/lib/types/agent.js:413,468-470` 在
   `SESSION_QUERY_SESSION_NOT_FOUND` 时 `createAgent` 用同一个 id 新建日志。最痛的是 superagent 的 master（SPV）
   会话：`src/app/runtime.ts:218` 每次启动都 `ensure(masterId)`，移走日志后 SPV 的整段对话被静默换成空日志，
   不报错、不提示；worker 会话则重建成空 transcript（`src/executor/dsh.ts:352-355`、`:506` 会重发完整派单，
   旧上下文丢失）。
3. **运行中移动 → 会话分裂**：写端持有 fd，rename 后继续往"旧 inode"追加；目录已在新位置而写端还在写，列表里
   已消失、内容还在长。另外 `workspace.json` 会保留一个陈旧 `sessionIds` 槽位，重启后以
   `session header is missing` 过滤掉（`dsh-workspace/lib/index.js:367,911`），`session_projcache` 留一条永远
   复用不了的孤儿记录（identity 含 `createdAt`，`dsh-session-projection-cache/lib/index.js:49,158`）。

tui 的缓存（`session-index.json`）会自愈（`sessions/list.js:318-319` 每次列表都清掉后端不再列出的行），
`last-used.json`/`agent-view-sessions.json` 留无害陈旧项。真正不可接受的是第 1、2 条：**归档的核心承诺是"日志还在、
随时能回来"，而移动把"不在列表里"变成了"按 id 打不开/被顶替"**。

另外，`archiveSession` 对已移动的 id 直接抛 `WorkspaceUnknownSessionError`（`:526`，需要 live 或 persistence 里
能找到），所以"先移走、以后再补归档"也走不通；`unarchiveSession` 对不存在的 id 静默成功（`:553`），会造成
"以为取消了归档、其实什么都没发生"。

## 5. Q4：dsh-superagent 面板要不要跟着隐藏

结论：**不需要为归档改面板**；面板没有会话列表，只有行上的一个 Session 按钮。

- 面板的 `/orchestrator/api/*` 共 25 个 operation（`src/app/http.ts:155-213`），没有任何 session list/detail/transcript
  端点；唯一带 session 的是 `GET prompts`，来自 `runtime.sessions.status()`（`http.ts:130`，只有活着的
  `{sessionId, revision}`，`src/app/sessions.ts:495-502`）。
- 行上的 `sessionId` 是**视图时推导**的：`ticket.assignments.some(startedAt) ? workerSessionId(ticket.id) : ''`
  （`src/app/views/records.ts:126-128`；`src/app/views/tickets.ts:79` 同样用 `ref: workerSessionId(ticket.id)`）。
- 按钮 → `openKnownSession(ctx.sessions, id, target => ctx.uiWorkspace.openSession(target))`
  （`src/client/index.tsx:34-43`），只在 catalog 未就绪或 id 不在列表里时抛错（`src/navigation.ts:16-23`）。
- 关键细节：`uiWorkspace.openSession()` 只是 `replaceMain`（`dsh-client-ui-workspace/lib/client.js:1471-1473`），
  **不检查归档集合**；检查只在侧栏行的 `guardedOpen`（`:3533-3538`）和搜索结果（`:3664-3669`）里，命中时弹
  "已归档对话暂时无法查看，请取消归档后查看"（`:4627-4632,4813`）。所以归档后从面板点 Session 按钮仍能打开
  对话（查看没问题），但归档 gate 会拒绝新 step；面板里没有"这个会话已归档"的提示（`src/client/locales.ts:109-110`
  的 `sessionNotListed` 只在 catalog 查不到时用）。
- 面板的 SQLite 没有 session 列/字段（`src/app/store.ts:73-78`、`src/core/model.ts:277-308`），worker id 永远是
  `worker-<ticketId>` 推导，不存在"记录指向已归档会话"的悬挂引用；transcript 读取走
  `sessionController.inspect`（`src/app/resources.ts:38,114-115`），而 `inspect` 不查归档集合
  （`dsh-api-session-controller/lib/index.js:3046-3056`），所以 SPV 侧读归档会话的日志仍然可用。

若以后要求"已归档会话在面板里不可链接"，再加一个 `archived` 标记即可，但今天没有便宜的 host 数据源（`status()` 只列
活会话），属于新需求，不是归档的前提。

## 6. Q5：方案

### 方案 A（推荐，满足字面指令）：wheelchair 侧在 `ticket.delivered` 后归档

不改 superagent，把归档挂到 wheelchair 自己的 hook 管线上。链路：

```
worker 的 reply 工具把消息写进 SPV 队列（outbox，src/superagent/spv.js:143-158）
  → 服务侧 hook runner 下一轮 drain 看到 ticket.delivered（默认 15s，`src/shared/settings.js:431`）
    → 新内建动作：archiveSession("worker-<ticketId>", {stopActivity:false})
      → 侧栏默认视图不再画这个 worker（日志原地保留，可取消归档）
工单后续被复活 → superagent 在唤醒前 revive（dsh.ts:343 / :481），会话照常工作
```

为什么只能落在这里：

- reply 是在 worker 的 turn 内写进 outbox 的，**写消息那一刻归档一定撞 `WorkspaceActiveSessionError`**；hook runner
  是服务侧唯一读者，且通常在 turn 结束后才看到事件（`src/spv/hook-runner.js` 文件头写明它是唯一读者、cursor 去重）。
- `webui/lib/index.js` 是 dsh 插件，能拿到 `ctx`（`inject = ['webServer','connection']`），并且和 dsh-superagent、
  `workspaceRegistry` 在同一个 host/进程（`~/.dsh/profiles/superagent/cordis.patch.yml` 把 `wheelchair-webui` 和
  `wheelchair-spv` 都插进 superagent profile）。`src/superagent/watch.js:57-73` 已有"lazily 取 registry、最多等 5s"
  的现成写法，可以直接复用这种取法（不必给插件加 `inject`）。
- 取消归档**不用新写**：superagent 在每次唤醒前 `revive()`（`dsh.ts:343` 送排队输入、`:481` 复活工单启动），
  未归档时是 no-op（`src/app/sessions.ts:231-237`）。所以"未来再次被拉起"这条已经由现有代码覆盖。

改动落点（约 4 个文件，均为 wheelchair 自有文件；`install.sh:344` 已经把 `spv/hook-runner.js`、
`shared/hook-events.js`、`shared/hooks.js` 复制进 webui 包，无需改安装脚本）：

1. `src/shared/hook-events.js`：在 `BUILTIN_ROWS`（`:302+`）加一行（`events: ['ticket.delivered']`，
   `cancellable: false`，说明"由 wheelchair-agent-webui 执行"），并把事件对象上的 `builtin: [...]`
   （`ticket.delivered` 当前是 `['builtin:injection']`，`:122`）同步加上它的 id——面板按 `BUILTIN_ROWS.events`
   过滤，事件对象上的数组只是同一份展示引用。
2. `src/spv/hook-runner.js`：给 `startHookRunner` 加一个可注入的 `effects`（builtin id → async fn），在
   `runHooksFor` 返回后按 `builtinRowsFor(event)` 执行；测试与 host 都用注入，保持纯 Node、不 import dsh。
3. `src/shared/hooks.js`：**不要**把效果放进 `runHooksFor` 的 `items` 循环——`items.length === 0` 时它会认领 occurrence
   后提前返回（`:824-834`），而 delivered 通常没有脚本行，效果会被跳掉；放在 runner 里并**只在本次真正处理了
   这次 occurrence 时执行**：`summary.skipped` 为 `'paused'`（hook 全局暂停）或 `'cursor'`（已被别的 drain 认领）
   时不执行，其余情况（含 `'empty'`）执行。
4. `webui/lib/index.js`：在 `startHookRunner({...})`（`:175-185`）处传 `effects`；实现里：
   - 取 registry：照 `src/superagent/watch.js:57-73` 的 lazy 写法；
   - 检查 `ctx.jobs.list(sessionId)` 没有 `running`/`stopping` 的 job（有就跳过，交给 `ticket.ended` 的归档；
     该 API 见 `dsh-jobs/lib/types/index.d.ts:77`，从插件作用域调用是否需要 owner 需实测）；
   - `archiveSession(id, {stopActivity:false})`；`WorkspaceUnknownSessionError` 静默（会话从未创建）、
     `WorkspaceActiveSessionError` 进重试队列（原因见下）；
   - 日志走 `ctx.logger?.warn`，绝不因为归档失败影响 hook 脚本。

三个必须处理的实现要点（都是本次读码发现，不是猜测）：

- **事件可能早于 turn 结束**：reply 工具可以在 turn 中途调用，之后模型还可能继续跑工具。看见 `ticket.delivered`
  时 turn 不一定已结束，`archiveSession` 会抛 `WorkspaceActiveSessionError`。要有重试（下个 tick 再来，带上限），
  或等 `ctx.agents.get(id)?.status === 'idle'`。
- **job 结尾的唤醒不走 revive**：`dsh.ts:650`（"background job ended"）、`:705`（"jobs killed"）、`:624`（retry）都
  直接 `sessions.prompt`，不 `revive`。归档后这类唤醒会被 archived gate 拒绝（turn 以 `blocked` 结束）。所以
  "有 running job 就先不归档"是必要的闸；只靠 `stopActivity:false` 不够（那只是不杀 job，不解决唤醒）。
- **重放要无害**：cursor 认领保证正常情况下只执行一次；但崩溃重启后 drain 可能重放，`archiveSession` 对已归档 id
  幂等（直接 resolve、不写盘，`dsh-workspace/lib/types/index.d.ts:190-260`），可以接受。

失败时的表现：hook runner 每轮打一行 warning，worker 的 turn/报告不受影响；归档没发生就等于没归档（侧栏继续显示），
不会出现"半归档"状态。手动兜底始终可用：侧栏行内 Archive（`⌘⇧A`）/"显示已归档"→取消归档。

代价（操作者需要知道的取舍）：工单**还没结束**（等人工 review/合并）时，它的 worker 会话会从默认侧栏消失，
要看只能切"显示已归档"或从面板的 Session 按钮点开；面板按钮打开的是只读对话，此时在里面发消息会被 gate 拒绝。

### 方案 B（零改动）：维持 `ticket.ended` 归档 + 手动归档

现状已经让"积压"降到 2 条（§1），且 `ticket.ended` 归档带 `stopActivity:true`（`src/app/sessions.ts:218-225`），
job 不会残留。若操作者认为"工单不结束前保留会话"是合理的可见性，那就不需要任何代码，只需在
`ARCHITECTURE/decisions.md` 记一句"delivered 后不归档，ended 后归档"（本次未改，等决定）。
缺点是字面上不满足 `INSTRUCTIONS.md:24` 的 "`ticket.delivered` 后"。

### 方案 C（否决）：把会话目录移走/改名

见 §4。硬失败 + 静默重建 + 运行中分裂，且失去"可取消"的语义（移回来需要人肉搬目录，`archiveSession` 也不认）。

### 方案 D（仅列出，被禁令否决）：改 superagent

`src/app/runtime.ts:148-155` 加一个"delivered 也归档"的分支（需要新事件或 hook 桥），或在 `sessions.archive`
里放宽。违反 `INSTRUCTIONS.md:28` 和 `ARCHITECTURE/spv-source.md:16`，且 delivered 不是 superagent 的域事件，
不是一行能改完的。列在这里只为完整性。

## 7. 未验证与限制

- 全程只读，**没有做运行时实验**：方案 A 的 race（turn 未结束）、job 闸（`ctx.jobs.list` 在插件作用域是否可读）、
  job 结尾唤醒被 gate 拒绝，都是读码推断，没有实机复现。
- "归档后从面板 Session 按钮仍能打开对话"是读 `openSession` 推断的，没有实机点击验证；侧栏行为有代码证据
  （`guardedOpen`）。
- 归档集合是 registry-global，影响面包括 dsh-tui 和搜索，不只是 WebUI；本次没有评估"团队成员/多前端"场景。
- `workspace.json` 是 dsh 内部存储，本文不主张手改；方案 A 只通过 `workspaceRegistry` 的公开方法写。

## 8. 复现与证据索引

```sh
# 归档集合与 worker 会话数（只读）
python3 - <<'PY'
import json, os
d = json.load(open(os.path.expanduser('~/.dsh/storages/workspace.json')))
arch = set(d['global']['archivedSessionIds'])
root = os.path.expanduser('~/.dsh/sessions')
dirs = [x for w in os.listdir(root) for x in os.listdir(os.path.join(root, w))]
w = [x for x in dirs if x.startswith('worker-')]
print('workers', len(w), 'archived', sum(1 for x in w if x in arch), 'visible', [x for x in w if x not in arch])
PY

# 未结束工单：必须连 -wal/-shm 一起复制，否则读到过期快照
mkdir -p /tmp/wca && cp ~/.dsh/state/superagent/orchestrator.sqlite* /tmp/wca/
python3 -c "import sqlite3,json;c=sqlite3.connect('/tmp/wca/orchestrator.sqlite');print([json.loads(v)['id'] for (v,) in c.execute('select value from ticket') if json.loads(v).get('ended') is None])"
```

关键证据（全部为本次实际读到的文件:行）：

- 归档 API：`dsh-workspace/lib/index.js:526,553`；类型与语义：`dsh-workspace/lib/types/index.d.ts:190-260`；
  存储形状：`lib/types/spec.d.ts`（`archivedSessionIds`）。
- RPC：`dsh-api-workspace-controller/lib/typert.host.js:344,453,601`。
- 前端：`dsh-client-ui-workspace/lib/client.js:176,964-973,1269-1274,1471-1473,2878,3533-3538,3664-3669,4137,4156,4183,4627-4632,4681-4720,4813`。
- 归档 gate：`dsh-api-session-controller/lib/types/archived-session-gate.js`（`agent/pre-step`）。
- 列表链：`dsh-api-session-controller/lib/index.js:1951-1990,3061-3065`、`lib/typert.host.js:1635`、
  `dsh-session-query/lib/index.js:95-117`、`dsh-session-persistence-jsonl/lib/index.js:2603,3435,3506-3524`、
  `dsh-base/cordis.patch.yml:138-141`。
- tui：`dsh-tui/lib/types/dsh-adapter/channel/session-metadata.js:18-27`、
  `lib/types/sessions/workspaceCounts.js:14`、`lib/types/sessionSupervisor.js:57,346`。
- superagent：`src/app/runtime.ts:148-155`、`src/app/sessions.ts:218-237`、`src/executor/dsh.ts:25,343,481,506,624,650,705`、
  `src/app/http.ts:130,155-213`、`src/app/views/records.ts:126-128`、`src/client/index.tsx:34-43`、
  `src/client/rows.tsx:37`、`src/navigation.ts:16-23`。
- wheelchair：`src/shared/hook-events.js:101-121,302+`、`src/shared/hooks.js:824-834`、`src/spv/hook-runner.js:100-153`、
  `webui/lib/index.js:175-185`、`src/superagent/watch.js:57-73`、`install.sh:344`、
  `~/.dsh/profiles/superagent/cordis.patch.yml`（wheelchair-webui / wheelchair-spv 的 mount 行）。
