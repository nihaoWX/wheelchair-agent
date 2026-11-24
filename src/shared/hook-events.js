/**
 * 插口（hook）引擎的**事件契约**：一张表说清每个事件是什么、什么时候触发、能否重复、负载里有哪些字段，
 * 以及它有哪些**内建行**（core path 拥有的行，永远不可取消）。
 *
 * 这是唯一实现：`src/shared/hooks.js` 执行它、`src/spv/hook.js` 打印它、`hook prompt` 从它生成中文提示词、
 * stage 3 的面板也读它（见 `ARCHITECTURE/hooks.md`）。**不要在任何地方抄第二份**——一个事件的说明只写在这里。
 *
 * 为什么单独一个文件、而不是塞进 `hooks.js`：设置存储（`src/shared/settings.js`）在保存时必须校验
 * `hooks.items[].event` 与 `hooks.labels` 的键，而执行器（`hooks.js`）又要 import 设置存储去读当前值。
 * 把契约放在两者**下面**，依赖图保持单向、无环：
 *
 *   home.js  <-  hook-events.js  <-  settings.js  <-  hooks.js
 *
 * 汇报规则（设计决定）：内建行只描述、不执行。真正干活的是 core path（`src/spv/inbox.js` 的
 * `appendReview` / `handleMergedPull`、注入器、superagent 的 `executor.prepare`），这里的 `cancellable`
 * 是给面板看的**事实**，不是开关。自定义行（`hook-*`）永远是操作者的，随加随删。
 *
 * 有意**没有** `ticket.ended`：队列只能看到 acknowledgement / reply / notice，看不到工单的终态结果；
 * 一个名字里带 "ended" 的事件会在以后被当成"结束了"来用，而那时它其实只是"worker 又说了一句话"。
 * 需要终态时，由 stage 2 解决 PR 身份问题后另开事件，不要在这里编一个。
 */

/** 一次事件在负载里的字段形状；面板与提示词都从这里生成。 */
function fields(spec) {
  return Object.entries(spec).map(([name, description]) => ({ name, description }))
}

/** 每个事件的示例负载：`hook test` 不带 `--payload` 时用它，`hook prompt` 也打印它。 */
const SAMPLE_AT = '2026-01-01T00:00:00.000Z'

/**
 * 事件表。顺序就是 `hook events` / 面板的展示顺序，也是"从一条工单的生命看过去"的顺序。
 *
 * `cancellable` 是**该事件的内建行**能不能被取消：带 core-path 内建行的事件为 `false`；只有自定义
 * 脚本的事件没有 core path 可保护，为 `true`。自定义行在任何事件上都可删。
 */
export const EVENTS = [
  {
    id: 'ticket.started',
    title: 'worker 启动',
    explanation:
      'superagent 为一张工单启动 worker 之前的那一刻：工作区已经准备好（clone、受管 AGENTS.md、tools/ 的私有远端），' +
      '但 worker 还什么都没做。它唯一的内建行是 superagent 自己的 `executor.prepare` 命令——那一行住在 ' +
      '**superagent 的设置**里，这里只显示一个指针行，绝不复制、不遮蔽，也不在这里执行它。事件由 prepare 命令' +
      '成功结束时写进 hook spool（`<数据根>/records/hook-events/`），服务侧的 runner 在下一轮 drain 里执行脚本；' +
      'prepare 自己永远不内联跑 hook，所以一个慢脚本不会拖住工单启动。',
    when:
      'prepare 命令成功结束之后：它把这次 occurrence 写进 spool，服务侧 runner 在同一个 tick 里和队列事件一起' +
      'drain（脚本可能在 worker 启动之后才跑）。成功的 prepare 每次启动写一次。',
    repeatable: true,
    repeatNote: '工单被后续消息复活、重新派 worker 时会再次启动，每次启动都是一次新的 occurrence。',
    cancellable: false,
    payload: fields({
      ticketId: '工单 id，例如 agent-hooks-29ffe928947d（来自 `DSH_SUPERAGENT_TICKET`，缺失时退到工单目录名）。',
      name: '工单名（`DSH_SUPERAGENT_NAME`），没有时省略。',
      project: '项目路径，例如 tools/wheelchair-agent（env 没有时是 prepare 实际解析到的那个）。',
      workspace: 'worker 将要使用的目录（绝对路径）；同时是脚本的 cwd 来源。',
      at: '这次启动的时间（ISO 8601，由 prepare 在成功结束时取）。',
    }),
    builtin: ['builtin:prepare'],
    sample: {
      ticketId: 'agent-demo-0123abcd',
      name: 'demo-0123abcd',
      project: 'tools/demo',
      workspace: '/home/operator/.dsh/state/superagent/work/demo-0123abcd',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'ticket.acknowledged',
    title: 'worker 接单',
    explanation:
      'SPV 队列里出现一条 `kind: "acknowledgement"` 的消息：worker 收下了这份活，或者你的追问已经排队。' +
      '它证明任务被接住了，不证明有结果。这个事件没有内建行，全部是操作者自己的脚本。',
    when: 'acknowledgement 消息出现在 SPV 队列（`outbox/` 或 `outbox/read/`）时，由服务侧 runner 按消息 id 触发一次。',
    repeatable: true,
    repeatNote: '每次接单 / 排队回执都是一条独立消息，各算一次 occurrence。',
    cancellable: true,
    payload: fields({
      messageId: '队列消息 id；也是 `WCA_EVENT_ID` 的来源。',
      ticketId: '工单 id。',
      thread: '队列 thread。',
      kind: '消息种类，固定为 acknowledgement。',
      text: '回执正文；超过 12000 个字符时截断。',
      textTruncated: '`text` 被截断时为 true（缺省不出现）；完整正文可用 `file` 自己读。',
      file: '这条消息的绝对路径（`outbox/` 或 `outbox/read/` 里的那个文件）。',
      at: '消息写入时间（ISO 8601）。',
    }),
    builtin: [],
    sample: {
      messageId: 'msg-ack-0001',
      ticketId: 'agent-demo-0123abcd',
      thread: 'demo-0123abcd',
      kind: 'acknowledgement',
      text: '收到，开始处理。',
      file: '/home/operator/.dsh/state/superagent/spv/outbox/msg-ack-0001.json',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'ticket.delivered',
    title: 'worker 报告',
    explanation:
      'SPV 队列里出现一条 `kind: "reply"` 的消息：worker 报告了这次的结果。**这就是本项目里"worker 完成了"的定义，' +
      '但它不是终态**——工单可以被后续消息复活，然后再报告一次。所以不要把 delivered 当成"结束"。队列消息只带 ' +
      '`ticketId` 与 `thread`，没有 PR 号；自动合并的 PR 身份必须从工单的执行目录反推（目录里的 git 分支与 ' +
      'origin），不能从负载里发明一个字段。' +
      '这个事件的内建行是结果注入（`injection` 模板）与会话归档、自动合并：注入属于 core path，正文可改，注入本身不可取消；' +
      '归档与自动合并由 wheelchair-agent-webui 在服务侧执行（见 `builtin:archiveSession`、`builtin:autoMerge`），' +
      '不是用户脚本。自动合并默认关闭，只有 `merge.autoMerge` 打开且五条闸门全部成立时才动手。',
    when: 'reply 消息出现在 SPV 队列时，由读取方按消息 id 触发一次。',
    repeatable: true,
    repeatNote: '一张工单可以有多条 reply；复活后的每次报告都是一次新的 occurrence。',
    cancellable: false,
    payload: fields({
      messageId: '队列消息 id；也是 `WCA_EVENT_ID` 的来源。',
      ticketId: '工单 id。',
      thread: '队列 thread。',
      kind: '消息种类，固定为 reply。',
      text: 'worker 的报告正文；超过 12000 个字符时截断。',
      textTruncated: '`text` 被截断时为 true（缺省不出现）；完整正文可用 `file` 自己读。',
      file: '这条消息的绝对路径（`outbox/` 或 `outbox/read/` 里的那个文件）。',
      at: '消息写入时间（ISO 8601）。',
    }),
    builtin: ['builtin:injection', 'builtin:archiveSession', 'builtin:autoMerge'],
    sample: {
      messageId: 'msg-reply-0001',
      ticketId: 'agent-demo-0123abcd',
      thread: 'demo-0123abcd',
      kind: 'reply',
      text: '已完成：README 的安装步骤已更新，测试全绿。',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'ticket.attention',
    title: 'worker 需要人 / 停下来了',
    explanation:
      'SPV 队列里出现一条 `kind: "notice"` 的消息：worker 停下来了、某个决定正被质疑、PR 到了终态，或者一次冷安装' +
      '还欠着。它是"需要你看一眼"的信号，不是"失败"。这个事件的内建行同样是结果注入（`injection` 模板）：注入器' +
      '把 reply 与 notice 一视同仁地推进 SPV 会话，所以 notice 的注入也属于 core path，正文可改、注入本身不可取消。',
    when: 'notice 消息出现在 SPV 队列时，由读取方按消息 id 触发一次。',
    repeatable: true,
    repeatNote: '一次事件一条 notice；同一 thread 可以有多条。',
    cancellable: false,
    payload: fields({
      messageId: '队列消息 id；也是 `WCA_EVENT_ID` 的来源。',
      ticketId: '工单 id（notice 可能不属于任何工单，此时缺失）。',
      thread: '队列 thread。',
      kind: '消息种类，固定为 notice。',
      text: '通知正文；超过 12000 个字符时截断。',
      textTruncated: '`text` 被截断时为 true（缺省不出现）；完整正文可用 `file` 自己读。',
      file: '这条消息的绝对路径（`outbox/` 或 `outbox/read/` 里的那个文件）。',
      at: '消息写入时间（ISO 8601）。',
    }),
    builtin: ['builtin:injection'],
    sample: {
      messageId: 'msg-notice-0001',
      ticketId: 'agent-demo-0123abcd',
      thread: 'demo-0123abcd',
      kind: 'notice',
      text: 'worker 停下来问：这个 PR 要不要一起改 CI？',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'inbox.approved',
    title: '收件箱：通过',
    explanation:
      '操作者在审查收件箱里点了"通过"。内建行只是把这条 review 追加到 item 上：不派任务、不发消息。' +
      '它属于 core path，文本与触发都不可配置；自定义脚本可以在这个事件上做自己的事。',
    when: '`appendReview(kind: "approve")` 把 review 写盘之后。',
    repeatable: true,
    repeatNote: '同一个 item 可以被再次审查，每次追加 review 都是一次新的 occurrence。',
    cancellable: false,
    payload: fields({
      itemId: '收件箱 item id，例如 acme-demo-1。',
      kind: 'item 种类：pr 或 spv_message。',
      pr: 'PR 号（仅 kind=pr）。',
      repo: '仓库 owner/name（仅 kind=pr）。',
      reviewIndex: '这条 review 在 item.review 里的下标，0 开始。',
      comment: '操作者的评论（通过时可以为空）。',
      at: 'review 写入时间（ISO 8601）。',
    }),
    builtin: ['builtin:reviewRecord'],
    sample: {
      itemId: 'acme-demo-1',
      kind: 'pr',
      pr: 1,
      repo: 'acme/demo',
      reviewIndex: 0,
      comment: '',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'inbox.issue',
    title: '收件箱：有问题',
    explanation:
      '操作者把一条收件箱项目标成"有问题"并写了评论。内建行是把这次质疑变成一条 `notice` 交给 SPV：' +
      'PR 用 `inbox-<pr>` thread 与 `prIssue` 模板，SPV 决策信用它自己的 thread 与 `spvObjection` 模板。' +
      '两行正文可改，notice 本身不可取消——不发这条消息，操作者的质疑就丢了。',
    when: '评论校验通过、review 写盘之后，notice 写入 SPV 队列时。',
    repeatable: true,
    repeatNote:
      '同一个 item 可以再次标"有问题"；完全相同的重复评论会复用 review index 与 message id，因此 eventId 相同、只算一次。',
    cancellable: false,
    payload: fields({
      itemId: '收件箱 item id。',
      kind: 'item 种类：pr 或 spv_message。',
      pr: 'PR 号（仅 kind=pr）。',
      repo: '仓库 owner/name（仅 kind=pr）。',
      reviewIndex: '这条 review 的下标。',
      comment: '操作者的评论原文（已 trim）。',
      messageId: '转给 SPV 的那条 notice 的 id（队列侧 `ticket.attention` 的 occurrence 用它）；' +
        '`inbox.issue` 自己的 `WCA_EVENT_ID` 是 `inbox.issue:<itemId>:<reviewIndex>`。',
      thread: 'notice 发往的 thread：inbox-<pr>，或决策信自己的 thread。',
      at: 'review / notice 的时间（ISO 8601）。',
    }),
    builtin: ['builtin:prIssue', 'builtin:spvObjection'],
    sample: {
      itemId: 'acme-demo-1',
      kind: 'pr',
      pr: 1,
      repo: 'acme/demo',
      reviewIndex: 0,
      comment: '这个改动会破坏已有的配置文件，先别合。',
      messageId: 'inbox-acme-demo-1-review-0',
      thread: 'inbox-1',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'inbox.merged',
    title: '收件箱：PR 已合并',
    explanation:
      '收件箱 watcher 观察到某个 PR 变成 MERGED，并且那一次 `git pull --ff-only` 已经跑完。内建行是那次 pull ' +
      '与（对安装目标仓库的）冷安装提醒；两者都属于 core path，不可取消。冷安装挂在这一侧、**不是** ' +
      '`ticket.delivered`：挂在 worker 的报告上会在 PR 存在之前就触发。',
    when: '`handleMergedPull` 成功完成 pull 之后；每个 item 只处理一次。',
    repeatable: false,
    repeatNote: 'item 上记录 mergeHandledAt；重试只补发通知，不会重新拉取，也不会再算一次 occurrence。',
    cancellable: false,
    payload: fields({
      itemId: '收件箱 item id。',
      pr: 'PR 号。',
      repo: '仓库 owner/name。',
      url: 'PR 地址。',
      mergeCommit: 'GitHub 报告的 merge commit。',
      pulledSha: '`git pull --ff-only` 之后本地 HEAD 的 sha。',
      localPath: '本地 clone 的路径。',
      at: '这次处理的时间（ISO 8601）。',
    }),
    builtin: ['builtin:mergePull', 'builtin:coldInstallNotice'],
    sample: {
      itemId: 'acme-demo-1',
      pr: 1,
      repo: 'acme/demo',
      url: 'https://github.com/acme/demo/pull/1',
      mergeCommit: '0123456789abcdef0123456789abcdef01234567',
      pulledSha: '0123456789abcdef0123456789abcdef01234567',
      localPath: '/home/operator/bioagentforge/tools/demo',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'spv.dispatch',
    title: 'SPV 派活',
    explanation:
      'SPV 提交一个任务进队列（`spv_dispatch` 工具或 `wheelchair-agent dispatch`）。这是链条的起点：此刻还没有' +
      '工单号，负载里只有任务记录本身。这个事件没有内建行，全部是操作者自己的脚本。',
    when: '任务写入 `pending/` 之后。',
    repeatable: true,
    repeatNote: '每次派活一次。',
    cancellable: true,
    payload: fields({
      taskId: '任务 id；也是 `WCA_EVENT_ID` 的来源。',
      thread: '任务所在 thread。',
      project: '项目路径，例如 tools/demo。',
      text: '任务正文。',
      preset: 'dsh agent preset id（可选）。',
      at: '任务写入时间（ISO 8601）。',
    }),
    builtin: [],
    sample: {
      taskId: 'task-0123abcd',
      thread: 'demo-0123abcd',
      project: 'tools/demo',
      text: '读一遍 README，把安装步骤补全。',
      at: SAMPLE_AT,
    },
  },
  {
    id: 'cron.spv_cron',
    title: 'SPV 轮询到点',
    explanation:
      '`/spv-cron` 的定时器到点，给会话注入一次简报（`quiet` 是例行提醒，`attention` 才是有 job 需要处理）。' +
      '前缀 `cron` 是触发者：不是某个工单，而是定时轮询。这个事件没有内建行，全部是操作者自己的脚本。',
    when: '每次轮询到点、简报注入之后。',
    repeatable: true,
    repeatNote: '每次到点一次；`at` 不同，所以不会互相去重。',
    cancellable: true,
    payload: fields({
      sessionId: '收到简报的会话 id（取得到时才有）。',
      minutes: '当前轮询间隔（分钟）。',
      at: '本次到点时间（ISO 8601）。',
      injected: '这次是否真的注入了简报；拿到会话时是 true。',
      verdict: '简报结论：`quiet` 为例行提醒，`attention` 为有需要处理的 job。',
    }),
    builtin: [],
    sample: {
      sessionId: 'sess-0123abcd',
      minutes: 60,
      at: SAMPLE_AT,
      injected: true,
      verdict: 'quiet',
    },
  },
]

/**
 * 内建行：core path 拥有的行。**它们不是脚本**，面板只展示，执行仍在各自的实现里。
 *
 * - `pointer`：真正的实现住在别处（`executor.prepare` 在 superagent 的设置里），这里只指过去；
 * - `template`：正文可编辑，但用**已有模板 id**，不新造一份文本（`src/shared/settings.js` 的 `TEMPLATE_SPECS`）；
 * - `editableText: false`：文本与触发都不可配置。
 *
 * 所有内建行都是 `cancellable: false`：取消它们等于砍掉 core path（review 不落盘、通知不发、pull 不跑），
 * 而 hook 的定义是"额外的副作用"。
 */
export const BUILTIN_ROWS = [
  {
    id: 'builtin:prepare',
    events: ['ticket.started'],
    defaultLabel: 'superagent 的 executor.prepare',
    description:
      'superagent 在启动 worker 前跑的 prepare 命令（面板里存的是 `wheelchair-agent prepare`）。它住在 superagent ' +
      '自己的设置里，这里只是一行指针：不复制、不遮蔽、不在这里执行。',
    cancellable: false,
    editableText: false,
    pointer: 'executor.prepare',
  },
  {
    id: 'builtin:injection',
    // reply 与 notice 都会被注入器用 `injection` 模板推进 SPV 会话，所以这一行属于两个事件、但只有一个 id。
    events: ['ticket.delivered', 'ticket.attention'],
    defaultLabel: '把 worker 的回信/通知注入 SPV 会话',
    description:
      'injector 把 reply / notice 原子消费后，用 `injection` 模板作为一条新消息推进 SPV 会话。模板正文可改；' +
      '注入本身是 core path，不可取消。',
    cancellable: false,
    editableText: true,
    template: 'injection',
  },
  {
    id: 'builtin:prIssue',
    events: ['inbox.issue'],
    defaultLabel: 'PR「有问题」转给 SPV',
    description:
      '把对 GitHub PR 的质疑写进 `inbox-<pr>` thread 的 notice，正文来自 `prIssue` 模板。正文可改；notice 不可取消。',
    cancellable: false,
    editableText: true,
    template: 'prIssue',
  },
  {
    id: 'builtin:spvObjection',
    events: ['inbox.issue'],
    defaultLabel: '质疑 SPV 的自主决定',
    description:
      '把对一封 SPV 决策信的质疑写回它自己的 thread，正文来自 `spvObjection` 模板。正文可改；notice 不可取消。',
    cancellable: false,
    editableText: true,
    template: 'spvObjection',
  },
  {
    id: 'builtin:reviewRecord',
    events: ['inbox.approved'],
    defaultLabel: '把「通过」写进收件箱',
    description:
      'approve 只是把一条 review 追加到 item 上：不派任务、不发消息。文本与触发都不可配置。',
    cancellable: false,
    editableText: false,
  },
  {
    id: 'builtin:mergePull',
    events: ['inbox.merged'],
    defaultLabel: '合并后 git pull --ff-only',
    description:
      'watcher 观察到 PR 变成 MERGED 后，在本地 clone 上跑一次 `git pull --ff-only`。只拉、不 force、不 reset、不 stash。',
    cancellable: false,
    editableText: false,
  },
  {
    id: 'builtin:coldInstallNotice',
    events: ['inbox.merged'],
    defaultLabel: '冷安装提醒',
    description:
      '被合并的是安装目标仓库（`merge.installRepo`，默认 wheelchair-agent）时，往 SPV 队列写一条冷安装提醒。' +
      '任何仓库的合并都会触发；冷安装只属于这一侧。',
    cancellable: false,
    editableText: false,
  },
  {
    id: 'builtin:archiveSession',
    events: ['ticket.delivered'],
    defaultLabel: '归档 worker 会话',
    description:
      'worker 报告之后，把它的会话（`worker-<ticketId>`）从默认侧栏归档：日志原地保留、可取消，下次唤醒前 ' +
      'superagent 会取消归档。**由 wheelchair-agent-webui 在服务侧执行，不是用户脚本**；该会话还有 running/stopping ' +
      '的 job 时跳过（交给 `ticket.ended` 的归档），turn 尚未结束时下一轮再试。归档失败只记 warning，不影响脚本。',
    cancellable: false,
    editableText: false,
  },
  {
    id: 'builtin:autoMerge',
    events: ['ticket.delivered'],
    defaultLabel: '交付后自动合并工单 PR',
    description:
      '`merge.autoMerge` 打开时，从工单的执行目录反推分支与仓库，把该分支唯一的 open PR 用 ' +
      '`gh pr merge <n> --repo <owner/name> --squash --delete-branch` 合并。**由 wheelchair-agent-webui 在服务侧执行，' +
      '不是用户脚本**；五条闸门必须全部成立：恰好一个 open PR 且 head 分支/仓库与克隆一致；非 draft；' +
      '`mergeable === MERGEABLE`；`statusCheckRollup` 非空且全部 SUCCESS（没有 CI 检查时写 `no CI checks`，不合并）；' +
      'files 不含 `ARCHITECTURE.md`、`ARCHITECTURE/**`、`PROGRESS.md`、`INSTRUCTIONS.md`。任何一条不成立、' +
      '读不到工单目录、gh 报错或超时都只记一行日志，不合并；合并后由收件箱 watcher 走既有的 pull / 冷安装路径。',
    cancellable: false,
    editableText: false,
  },
]

const EVENT_BY_ID = new Map(EVENTS.map(event => [event.id, event]))
const BUILTIN_BY_ID = new Map(BUILTIN_ROWS.map(row => [row.id, row]))

/** 一个事件条目；未知名返回 `undefined`（调用方决定是报错还是忽略）。 */
export function eventById(id) {
  return typeof id === 'string' ? EVENT_BY_ID.get(id.trim()) : undefined
}

/** 一个内建行；未知名返回 `undefined`。 */
export function builtinRowById(id) {
  return typeof id === 'string' ? BUILTIN_BY_ID.get(id.trim()) : undefined
}

/** 某个事件的内建行（顺序同 `BUILTIN_ROWS`）。 */
export function builtinRowsFor(eventId) {
  return BUILTIN_ROWS.filter(row => row.events.includes(eventId))
}
