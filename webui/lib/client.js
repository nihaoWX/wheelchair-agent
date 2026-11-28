window.__ModuleLoader__.load({
	id: "wheelchair-agent-webui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, jsxs } = react_jsx_runtime;

		/** Namespace of this package's locale dictionaries and slot declarations. */
		const NS = "wheelchair-agent-webui";
		/**
		* Id of the wheelchair-agent UI home panel. It is shared by the sidebar row
		* and the `main` page registration, and it is the same in both languages: the
		* panel is the product entry, whose first section is the review inbox.
		*/
		const PANEL_ID = "wheelchair-agent";
		/** The two JSON endpoints the inbox already serves; the panel only reads them. */
		const ITEMS_URL = "/wheelchair-inbox/items";
		const REVIEW_URL = "/wheelchair-inbox/review";
		/** The one settings endpoint: GET the snapshot, PUT one staged change set with its revision. */
		const SETTINGS_URL = "/wheelchair-settings";
		const PROJECTS_URL = "/wheelchair-projects";
		const PROJECTS_REFRESH_MS = 30000;

		/** Copy for the panel, the inbox section and the Markdown chrome. */
		const zh = {
			panel: "wheelchair-agent",
			"panel.subtitle": "功能面板：wheelchair-agent 的各项工作流",
			"nav.features": "功能",
			"sections.label": "功能",
			"section.inbox": "收件箱",
			"feature.inbox.title": "收件箱",
			"feature.inbox.description": "复查 GitHub PR 与 SPV 的自主决策。SPV 在无人看管时自己做的决定会写成一封信，记录决定了什么、为什么；你之后通过或质疑。",
			"section.settings": "设置",
			"feature.settings.title": "设置",
			"feature.settings.description": "调整面板的外观，以及只因为 wheelchair-agent 存在而存在的旋钮：收件箱刷新、合并处理、消息注入、派单模板与工作回收。保存后立即生效，不需要重启服务或 SPV 会话。",
			"section.projects": "项目",
			"feature.projects.title": "项目",
			"feature.projects.description": "查看每个 spv 项目、它绑定的 orchestrator 项目，以及这些项目的部署与正在跑的工单/worker。这个段只读；修改请用 wheelchair-agent spv-project 与 deployment 命令。",
			"projects.kind": "SPV 项目",
			"projects.loading": "正在读取项目…",
			"projects.loadFailed": "读取项目失败：{message}",
			"projects.empty": "还没有登记 spv 项目。用「wheelchair-agent spv-project add <root>」登记一个。",
			"projects.workerCount": "{count} 个 orchestrator 项目",
			"projects.noWorkers": "没有绑定 orchestrator 项目",
			"projects.undeployed": "未部署",
			"projects.port": "端口 {port}",
			"projects.openFullUi": "打开该部署的完整 UI",
			"projects.idle": "空闲",
			"projects.running": "正在跑 {count} 个工单 · {workers} 个 worker",
			"projects.queued": "排队 {count}",
			"projects.unavailable": "不可用：{reason}",
			"projects.rootMissing": "spv 根不存在",
			"projects.setup": "配置未完成：{problem}",
			"projects.status": "{count} 个 spv 项目 · 更新于 {time}",
			"section.hooks": "插口",
			"feature.hooks.title": "插口",
			"feature.hooks.description": "查看每个事件是什么意思、什么时候触发、脚本能拿到什么，以及它下面有哪些内建行和自定义行。内建行属于 core path，只能改名；新增插口是一段给 agent 的提示词，不是在这里写 shell。",
			"hooks.loading": "正在加载插口…",
			"hooks.loadFailed": "加载插口失败：{message}",
			"hooks.viewMissing": "当前 host 没有返回插口视图；更新并重启 host 后可见。",
			"hooks.viewError": "插口视图加载失败：{message}",
			"hooks.reload": "刷新",
			"hooks.summary": "{events} 个事件 · {builtin} 条内建行 · {custom} 条自定义行",
			"hooks.enabled": "总开关：开启",
			"hooks.disabled": "总开关：关闭（只记录 paused，不跑脚本）",
			"hooks.interval": "runner 每 {seconds} 秒看一次（0 = 暂停）",
			"hooks.saved": "已保存，revision {revision}",
			"hooks.conflict": "设置在别处已被改动（当前 revision {revision}）。改名草稿还在；刷新后再保存。",
			"hooks.saveFailed": "保存失败：{message}",
			"hooks.event.when": "什么时候触发",
			"hooks.event.repeat": "能重复吗",
			"hooks.event.repeatable": "能。",
			"hooks.event.once": "每个对象只一次。",
			"hooks.event.payload": "负载字段（{count}）",
			"hooks.event.rows": "行（{count}）",
			"hooks.event.history": "最近 {count} 次执行",
			"hooks.event.noRows": "这个事件没有内建行或自定义行。",
			"hooks.event.noRuns": "还没有执行记录。",
			"hooks.row.core": "core path",
			"hooks.row.notCancellable": "这是 core path，不能取消、不能删。",
			"hooks.row.renamable": "内建行可以改显示名称，但不能停用或删除；留空恢复默认。",
			"hooks.row.renamed": "已改名",
			"hooks.row.defaultLabel": "默认名称：{label}",
			"hooks.row.template": "正文在「设置 → 派单文本」的 {template} 模板里，改模板不会改触发。",
			"hooks.row.pointer": "真正的实现在 superagent 设置里的 {pointer}；这里只是指针，不复制、不遮蔽、不执行。",
			"hooks.row.openTemplates": "去设置模板组",
			"hooks.row.script": "脚本预览（只读）",
			"hooks.row.enabled": "启用中",
			"hooks.row.disabled": "已停用",
			"hooks.rename.label": "显示名称",
			"hooks.rename.save": "保存名称",
			"hooks.rename.saving": "保存中…",
			"hooks.rename.error.long": "名称最多 120 个字符。",
			"hooks.rename.error.control": "名称不能包含控制字符。",
			"hooks.prompt.add": "新增",
			"hooks.prompt.close": "收起",
			"hooks.prompt.hint": "让 agent 照这段提示词去改。",
			"hooks.prompt.copy": "复制提示词",
			"hooks.prompt.copied": "已复制",
			"hooks.prompt.copyFailed": "复制失败，请手动选择文本复制。",
			"hooks.run.ok": "成功",
			"hooks.run.failed": "失败",
			"hooks.run.timeout": "超时",
			"hooks.run.paused": "已暂停",
			"hooks.run.pausedName": "（总开关关闭，整个事件只记一条）",
			"hooks.run.duration": "{ms} ms",
			"hooks.run.last": "最近一次：",
			"settings.loading": "正在加载设置…",
			"settings.loadFailed": "加载设置失败：{message}",
			"settings.reload": "重新加载",
			"settings.save": "保存",
			"settings.saving": "保存中…",
			"settings.saved": "已保存，revision {revision}",
			"settings.unchanged": "没有未保存的改动",
			"settings.dirty": "{count} 项未保存",
			"settings.fixErrors": "有字段不合法，先按行内提示修正，再保存。",
			"settings.conflict": "设置在别处已被改动（当前 revision {revision}）。草稿还在；重新加载后再保存，避免覆盖别人的改动。",
			"settings.saveFailed": "保存失败：{message}",
			"settings.fileWarning": "设置警告：{warning} 下面显示的是回退后的值；保存只写入改动的字段，不会整体重写设置文件。",
			"settings.effective": "当前生效：{value}",
			"settings.defaultValue": "默认：{value}",
			"settings.reset": "恢复默认",
			"settings.resetStaged": "已标记恢复默认，保存后生效。",
			"settings.source.file": "已保存",
			"settings.source.config": "插件 config",
			"settings.source.env": "环境变量",
			"settings.source.default": "内置默认",
			"settings.overridden": "生效来源是{source}；这些低层值被压住、不会生效：{layers}。",
			"settings.envIgnored": "环境变量 {name}={value} 已设置但无效，未生效。",
			"settings.on": "开启",
			"settings.off": "关闭",
			"settings.error.number": "必须是整数。",
			"settings.error.range": "必须是 {min}–{max} 之间的整数。",
			"settings.error.repo": "填 owner/name 或 name，只能使用字母、数字、点、横线和下划线。",
			"settings.group.style": "外观",
			"settings.group.inbox": "收件箱刷新",
			"settings.group.merge": "合并处理",
			"settings.group.injection": "消息注入",
			"settings.group.templates": "派单文本",
			"settings.group.work": "工作回收",
			"settings.group.other": "其他设置",
			"settings.sources.allDefault": "所有设置都使用内置默认值。",
			"settings.sources.file": "{count} 项来自设置文件",
			"settings.sources.env": "{count} 项来自环境变量",
			"settings.sources.config": "{count} 项来自插件 config",
			"settings.sources.none": "没有可显示的设置。",
			"settings.draftTag": "草稿",
			"settings.draftHint": "这项有未保存的草稿",
			"settings.tech": "技术细节",
			"settings.style.minimal": "简洁",
			"settings.style.fluid": "流体",
			"settings.template.preset": "预设",
			"settings.template.builtinSuffix": "（内置）",
			"settings.template.placeholders": "可用占位符",
			"settings.template.count": "{count} / {limit} 字符",
			"settings.template.readonly": "内置默认不可直接修改；用“从这里新建预设”复制一份再改。",
			"settings.template.newFromThis": "从这里新建预设",
			"settings.template.presetName": "预设名称",
			"settings.template.create": "新建",
			"settings.template.cancel": "取消",
			"settings.template.delete": "删除预设",
			"settings.template.revert": "恢复内置默认",
			"settings.template.requiredLegend": "必填：{required}（接收方行动所需的事实，不能删）",
			"settings.template.error.unknown": "未知占位符 {token}；可用：{allowed}。",
			"settings.template.error.required": "缺少必填占位符 {token}：接收方需要它才能行动。",
			"settings.template.error.limit": "超过 {limit} 字符上限（当前 {count}）。",
			"settings.template.error.preset": "预设“{name}”：{message}",
			"settings.template.error.nameEmpty": "预设名不能为空。",
			"settings.template.error.nameLong": "预设名最多 64 个字符。",
			"settings.template.error.nameControl": "预设名不能包含控制字符。",
			"settings.template.error.nameDefault": "“default” 是内置预设名，请换一个。",
			"settings.template.error.nameReserved": "预设名不能使用保留字 __proto__、prototype 或 constructor。",
			"settings.template.error.nameExists": "已有同名预设，请换一个名字。",
			"settings.notes.recovery": "恢复命令文本不参与模板化：冷安装合并通知、install.sh 的拒绝文本、restart-all 的计划文本都保持精确原文。",
			"settings.notes.scope": "superagent 的面板负责 executor、eval、policy、source:github、source:spv；本页只改因为 wheelchair-agent 存在而存在的旋钮，不镜像、不链接它们。",
			"settings.notes.live": "设置文件由服务和 SPV 会话在使用时重读，所以保存后立即生效；只有 host 半身的代码改动（lib/index.js 与复制进包的 core 文件）才需要等下一次正常的服务重启，浏览器 bundle 会热重载。",
			"setting.webui.style.label": "面板样式",
			"setting.webui.style.desc": "决定面板看起来和动起来的样子。",
			"setting.webui.style.changes": "「流体」用可见的淡色底纹、分层阴影、悬停抬升和交错入场；「简洁」关掉这些，只留平面卡片。切换只改变材质与动效，版面结构不变。",
			"setting.webui.style.recommended": "推荐先用「流体」；如果觉得晃眼或卡顿，切回「简洁」。",
			"setting.webui.style.tech": "键 webui.style，取值 minimal | fluid；面板加载时读取，保存后即时生效，不需要重启。",
			"setting.inbox.intervalSeconds.label": "收件箱刷新间隔（秒）",
			"setting.inbox.intervalSeconds.desc": "多久检查一次各个仓库有没有新信件。",
			"setting.inbox.intervalSeconds.changes": "调小能更早看到新 PR，但每个仓库每轮都会调用一次 gh；调到 0 就不再自动检查，手动刷新仍然可用。",
			"setting.inbox.intervalSeconds.recommended": "推荐 60 秒。",
			"setting.inbox.intervalSeconds.tech": "键 inbox.intervalSeconds；环境变量 SPV_INBOX_INTERVAL_SECONDS；插件 config intervalSeconds，文件值优先。",
			"setting.merge.installRepo.label": "合并即冷安装的仓库",
			"setting.merge.installRepo.desc": "哪个仓库的 PR 合并后需要做一次冷安装。",
			"setting.merge.installRepo.changes": "这个仓库合并后会排队一条冷安装提醒，而不是普通 pull；填错会导致合并后没有提醒。",
			"setting.merge.installRepo.recommended": "推荐保留 wheelchair-agent。",
			"setting.merge.installRepo.tech": "键 merge.installRepo；填 owner/name 或 name；环境变量 SPV_INSTALL_REPO。",
			"setting.merge.autoMerge.label": "交付后自动合并工单 PR",
			"setting.merge.autoMerge.desc": "打开后，ticket.delivered 由 wheelchair-agent-webui 在服务侧尝试合并工单克隆当前分支对应的 open PR。PR 身份从工单目录的 git 分支与 origin 反推，不来自队列负载。",
			"setting.merge.autoMerge.changes": "五条闸门必须全部成立：恰好一个 open PR 且 head 分支/仓库与克隆一致；非 draft；mergeable 为 MERGEABLE；statusCheckRollup 非空且全部 SUCCESS（没有 CI 检查时写 no CI checks，不合并）；files 不含 ARCHITECTURE.md、ARCHITECTURE/**、PROGRESS.md、INSTRUCTIONS.md。任何一条不成立、读不到工单目录、gh 报错或超时都只记一行日志，不合并。",
			"setting.merge.autoMerge.recommended": "默认 false：开启等于跳过人工审查。",
			"setting.merge.autoMerge.tech": "键 merge.autoMerge；布尔；冷安装后生效；合并命令 gh pr merge <n> --repo <owner/name> --squash --delete-branch，效果上限 120s。",
			"setting.injection.intervalMs.label": "结果注入间隔（毫秒）",
			"setting.injection.intervalMs.desc": "结果注入器多久查看一次待发送的消息。",
			"setting.injection.intervalMs.changes": "调小更及时，但会更频繁地读文件；调大更省资源，但结果会晚一点到。",
			"setting.injection.intervalMs.recommended": "推荐 1000 毫秒。",
			"setting.injection.intervalMs.tech": "键 injection.intervalMs；范围 50–3600000 毫秒。",
			"setting.injection.maxBodyChars.label": "注入正文上限（字符）",
			"setting.injection.maxBodyChars.desc": "注入到 SPV 会话的消息正文最多保留多少字符。",
			"setting.injection.maxBodyChars.changes": "超出部分会被截断；调小可能丢掉关键信息，调大可能让会话变长。",
			"setting.injection.maxBodyChars.recommended": "推荐 12000 字符。",
			"setting.injection.maxBodyChars.tech": "键 injection.maxBodyChars；范围 100–200000 字符。",
			"setting.work.keep.label": "work gc 保留的最新目录数",
			"setting.work.keep.desc": "自动清理时，按数量至少保留多少个最近的 ticket 目录。",
			"setting.work.keep.changes": "调大占用更多磁盘；0 表示不按数量保留，只按天数和可重建性判断。",
			"setting.work.keep.recommended": "推荐 0。",
			"setting.work.keep.tech": "键 work.keep；命令行的 --keep 仍然优先。",
			"setting.work.keepDays.label": "work gc 保留最近天数",
			"setting.work.keepDays.desc": "自动清理时，保留最近多少天的 ticket 目录。",
			"setting.work.keepDays.changes": "调大保留更久；0 表示不按天数保留。",
			"setting.work.keepDays.recommended": "推荐 0。",
			"setting.work.keepDays.tech": "键 work.keepDays；命令行的 --keep-days 仍然优先。",
			"setting.work.sweepOnMount.label": "服务启动时自动回收",
			"setting.work.sweepOnMount.desc": "服务启动时是否自动清理可重建的 ticket 目录。",
			"setting.work.sweepOnMount.changes": "关掉后只能手动运行 wheelchair-agent work gc。",
			"setting.work.sweepOnMount.recommended": "推荐开启。",
			"setting.work.sweepOnMount.tech": "键 work.sweepOnMount；只影响挂载时的回收。",
			"template.injection.title": "结果注入模板",
			"template.injection.desc": "注入到 SPV 会话的消息头与正文；内置默认与改造前的输出逐字节一致。",
			"template.prIssue.title": "PR「有问题」通知正文",
			"template.prIssue.desc": "把 PR 的「有问题」评论发给 SPV 入口会话时使用；评论原文由 comment 占位符承载。",
			"template.spvObjection.title": "SPV 质疑通知正文",
			"template.spvObjection.desc": "把对 SPV 自主决定的质疑写进 outbox 时使用；操作者评论由 comment 占位符承载。",
			refresh: "刷新",
			"filter.label": "筛选",
			"filter.all": "全部",
			"filter.pending": "待审查",
			"filter.issue": "有问题",
			"filter.approved": "已通过",
			"filter.empty": "这个筛选下没有信件。",
			"filter.kind": "信件类型",
			"filter.kind.all": "全部",
			"filter.kind.pr": "PR",
			"filter.kind.spv_message": "SPV 决策",
			"filter.repo": "仓库",
			"filter.repo.all": "全部仓库",
			"filter.time": "时间",
			"filter.time.all": "全部",
			"filter.time.day": "近 24 小时",
			"filter.time.week": "近 7 天",
			"filter.time.custom": "自定义区间",
			"filter.time.since": "起始日期",
			"filter.time.until": "结束日期",
			"kind.pr": "PR",
			"kind.spv_message": "SPV 决策",
			"status.loading": "加载中…",
			"status.loaded": "{count} 封信 · 更新于 {time}",
			"status.failed": "加载失败：{message}",
			"inbox.empty": "收件箱是空的。先运行 “wheelchair-agent inbox watch --once” 拉取 PR，或用 “inbox add” 写一封 SPV 决策信。",
			"card.untitled": "（无标题）",
			"card.files": "{count} 个文件",
			"card.body": "PR 说明",
			"card.bodyEmpty": "（PR 正文为空）",
			"card.letter": "决策说明",
			"card.letterEmpty": "（信件正文为空）",
			"card.thread": "线程：{thread}",
			"card.open": "打开 PR",
			"card.reviews": "审查记录（{count}）",
			"day.unknown": "日期未知",
			"inbox.draftTag": "草稿",
			"inbox.draftHint": "这封信有未保存的审查草稿",
			"status.pending": "待审查",
			"status.approved": "已通过",
			"status.issue": "有问题",
			"form.pass": "通过",
			"form.passHint": "理由可选，只会记录在收件箱里，不会通知智能体。",
			"form.passPlaceholder": "可选：记下你通过的理由（只记录，不通知智能体）。",
			"form.issue": "有问题",
			"form.issueHint.pr": "提交后会通知 SPV。",
			"form.issueHint.spv_message": "提交后会通知 SPV。",
			"form.issuePlaceholder.pr": "写清楚问题在哪；提交后会通知 SPV。",
			"form.issuePlaceholder.spv_message": "写清楚你质疑的地方；提交后会通知 SPV。",
			"form.issueEmpty": "请写下问题再提交。",
			"form.submit": "提交评论",
			"form.approveSubmit": "记录通过",
			"form.cancel": "取消",
			"form.failed": "提交失败：{message}",
			"form.inflight": "提交中…",
			"state.open": "打开",
			"state.merged": "已合并",
			"state.closed": "已关闭"
		};
		const en = {
			panel: "wheelchair-agent",
			"panel.subtitle": "Feature host: wheelchair-agent workflows",
			"nav.features": "Features",
			"sections.label": "Features",
			"section.inbox": "Inbox",
			"feature.inbox.title": "Inbox",
			"feature.inbox.description": "Review GitHub pull requests and SPV decisions. When SPV runs unattended, each call it makes on your behalf becomes a letter recording what it decided and why; you later accept it or object.",
			"section.settings": "Settings",
			"feature.settings.title": "Settings",
			"feature.settings.description": "Adjust how the panel looks, plus the knobs that exist because wheelchair-agent exists: inbox refresh, merge handling, message injection, dispatch text and work reclaim. Changes apply immediately; no service or SPV-session restart is needed.",
			"section.projects": "Projects",
			"feature.projects.title": "Projects",
			"feature.projects.description": "See each spv project, the orchestrator projects it owns, and what is deployed and running under them. This section is read-only; use the wheelchair-agent spv-project and deployment commands to change it.",
			"projects.kind": "SPV project",
			"projects.loading": "Loading projects…",
			"projects.loadFailed": "Could not load projects: {message}",
			"projects.empty": "No spv project is recorded yet. Add one with 「wheelchair-agent spv-project add <root>」.",
			"projects.workerCount": "{count} orchestrator project(s)",
			"projects.noWorkers": "No orchestrator project is bound",
			"projects.undeployed": "not deployed",
			"projects.port": "port {port}",
			"projects.openFullUi": "Open this deployment's full UI",
			"projects.idle": "idle",
			"projects.running": "{count} running ticket(s) · {workers} worker(s)",
			"projects.queued": "{count} queued",
			"projects.unavailable": "unavailable: {reason}",
			"projects.rootMissing": "the spv root does not exist",
			"projects.setup": "setup incomplete: {problem}",
			"projects.status": "{count} spv project(s) · updated {time}",
			"section.hooks": "Hooks",
			"feature.hooks.title": "Hooks",
			"feature.hooks.description": "See what each event means, when it fires, what a script receives, and which built-in and custom rows belong to it. Built-in rows are the core path and can only be renamed; adding a hook is a prompt for an agent, not a shell box here.",
			"hooks.loading": "Loading hooks…",
			"hooks.loadFailed": "Could not load hooks: {message}",
			"hooks.viewMissing": "This host did not return the hook view; update and restart the host to see it.",
			"hooks.viewError": "Could not build the hook view: {message}",
			"hooks.reload": "Refresh",
			"hooks.summary": "{events} events · {builtin} built-in rows · {custom} custom rows",
			"hooks.enabled": "Master switch: on",
			"hooks.disabled": "Master switch: off (records paused only, runs no script)",
			"hooks.interval": "runner checks every {seconds}s (0 = paused)",
			"hooks.saved": "Saved at revision {revision}",
			"hooks.conflict": "Settings changed elsewhere (current revision {revision}). Your rename draft is kept; refresh before saving.",
			"hooks.saveFailed": "Could not save: {message}",
			"hooks.event.when": "When it fires",
			"hooks.event.repeat": "Can it repeat?",
			"hooks.event.repeatable": "Yes.",
			"hooks.event.once": "Once per object.",
			"hooks.event.payload": "Payload fields ({count})",
			"hooks.event.rows": "Rows ({count})",
			"hooks.event.history": "Last {count} runs",
			"hooks.event.noRows": "This event has no built-in or custom rows.",
			"hooks.event.noRuns": "No runs recorded yet.",
			"hooks.row.core": "core path",
			"hooks.row.notCancellable": "This is the core path; it cannot be cancelled or deleted.",
			"hooks.row.renamable": "Built-in rows can be renamed but never disabled or deleted; leave empty to restore the default.",
			"hooks.row.renamed": "Renamed",
			"hooks.row.defaultLabel": "Default name: {label}",
			"hooks.row.template": "The text lives in the {template} template under Settings → Dispatch text; editing it does not change when the row fires.",
			"hooks.row.pointer": "The real implementation is {pointer} in the superagent settings; this is a pointer only, not a copy, shadow or execution site.",
			"hooks.row.openTemplates": "Open the templates group",
			"hooks.row.script": "Script preview (read-only)",
			"hooks.row.enabled": "Enabled",
			"hooks.row.disabled": "Disabled",
			"hooks.rename.label": "Display name",
			"hooks.rename.save": "Save name",
			"hooks.rename.saving": "Saving…",
			"hooks.rename.error.long": "A name can be at most 120 characters.",
			"hooks.rename.error.control": "A name cannot contain control characters.",
			"hooks.prompt.add": "Add",
			"hooks.prompt.close": "Collapse",
			"hooks.prompt.hint": "Have an agent make the change from this prompt.",
			"hooks.prompt.copy": "Copy prompt",
			"hooks.prompt.copied": "Copied",
			"hooks.prompt.copyFailed": "Could not copy; select the text and copy it manually.",
			"hooks.run.ok": "OK",
			"hooks.run.failed": "Failed",
			"hooks.run.timeout": "Timed out",
			"hooks.run.paused": "Paused",
			"hooks.run.pausedName": "(master switch off; one record per occurrence)",
			"hooks.run.duration": "{ms} ms",
			"hooks.run.last": "Last run: ",
			"settings.loading": "Loading settings…",
			"settings.loadFailed": "Could not load settings: {message}",
			"settings.reload": "Reload",
			"settings.save": "Save",
			"settings.saving": "Saving…",
			"settings.saved": "Saved at revision {revision}",
			"settings.unchanged": "No unsaved changes",
			"settings.dirty": "{count} unsaved change(s)",
			"settings.fixErrors": "Some fields are invalid; fix the inline errors before saving.",
			"settings.conflict": "Settings changed elsewhere (current revision {revision}). Your drafts are kept; reload before saving so you do not overwrite the other change.",
			"settings.saveFailed": "Could not save: {message}",
			"settings.fileWarning": "Settings warnings: {warning} The values below are the fallbacks; saving writes only the changed fields, not the whole file.",
			"settings.effective": "Effective: {value}",
			"settings.defaultValue": "Default: {value}",
			"settings.reset": "Reset",
			"settings.resetStaged": "Reset staged; it applies on save.",
			"settings.source.file": "Saved",
			"settings.source.config": "Plugin config",
			"settings.source.env": "Environment",
			"settings.source.default": "Default",
			"settings.overridden": "The effective source is {source}; these lower values are set but overridden and do not apply: {layers}.",
			"settings.envIgnored": "Environment {name}={value} is set but invalid, so it is not used.",
			"settings.on": "On",
			"settings.off": "Off",
			"settings.error.number": "Enter a whole number.",
			"settings.error.range": "Enter a whole number from {min} to {max}.",
			"settings.error.repo": "Use owner/name or name, with letters, digits, dot, dash and underscore only.",
			"settings.group.style": "Appearance",
			"settings.group.inbox": "Inbox refresh",
			"settings.group.merge": "Merge handling",
			"settings.group.injection": "Message injection",
			"settings.group.templates": "Dispatch text",
			"settings.group.work": "Work reclaim",
			"settings.group.other": "Other settings",
			"settings.sources.allDefault": "All settings are at their built-in defaults.",
			"settings.sources.file": "{count} from the settings file",
			"settings.sources.env": "{count} from the environment",
			"settings.sources.config": "{count} from the plugin config",
			"settings.sources.none": "There are no settings to show.",
			"settings.draftTag": "Draft",
			"settings.draftHint": "This row has an unsaved draft",
			"settings.tech": "Technical details",
			"settings.style.minimal": "Minimal",
			"settings.style.fluid": "Fluid",
			"settings.template.preset": "Preset",
			"settings.template.builtinSuffix": " (built-in)",
			"settings.template.placeholders": "Placeholders",
			"settings.template.count": "{count} / {limit} characters",
			"settings.template.readonly": "The built-in default cannot be edited; use \"New preset from this\" to copy it first.",
			"settings.template.newFromThis": "New preset from this",
			"settings.template.presetName": "Preset name",
			"settings.template.create": "Create",
			"settings.template.cancel": "Cancel",
			"settings.template.delete": "Delete preset",
			"settings.template.revert": "Revert to default",
			"settings.template.requiredLegend": "Required: {required} (the facts the receiver needs to act; they cannot be removed)",
			"settings.template.error.unknown": "Unknown placeholder {token}; allowed: {allowed}.",
			"settings.template.error.required": "Missing required placeholder {token}: the receiving agent needs it to act.",
			"settings.template.error.limit": "Over the {limit}-character limit (currently {count}).",
			"settings.template.error.preset": "Preset \"{name}\": {message}",
			"settings.template.error.nameEmpty": "A preset name cannot be empty.",
			"settings.template.error.nameLong": "A preset name must be at most 64 characters.",
			"settings.template.error.nameControl": "A preset name cannot contain control characters.",
			"settings.template.error.nameDefault": "\"default\" is the built-in preset name; pick another.",
			"settings.template.error.nameReserved": "A preset name cannot be __proto__, prototype or constructor.",
			"settings.template.error.nameExists": "A preset with that name already exists; pick another.",
			"settings.notes.recovery": "Recovery-command text is not templated: the cold-install merge notice, the install.sh refusal text and the restart-all plan text stay exact strings.",
			"settings.notes.scope": "superagent's panel owns executor, eval, policy, source:github and source:spv; this page only edits knobs that exist because wheelchair-agent exists, and does not mirror or link them.",
			"settings.notes.live": "The settings file is re-read by the service and the SPV session on use, so a save applies live; only a host-half code change (lib/index.js and the copied core files) needs the next normal service restart, while the browser bundle hot-reloads.",
			"setting.webui.style.label": "Panel style",
			"setting.webui.style.desc": "Decides how the panel looks and moves.",
			"setting.webui.style.changes": "Fluid adds a visible tonal wash, layered shadows, a hover lift and a staggered arrival; Minimal turns those off and keeps flat cards. Switching changes material and motion, never the layout.",
			"setting.webui.style.recommended": "Start with Fluid; switch to Minimal if it feels busy or slow.",
			"setting.webui.style.tech": "Key webui.style, values minimal | fluid; read when the panel loads and applied live after a save, with no restart.",
			"setting.inbox.intervalSeconds.label": "Inbox refresh interval (seconds)",
			"setting.inbox.intervalSeconds.desc": "How often each repository is checked for new letters.",
			"setting.inbox.intervalSeconds.changes": "Smaller finds new PRs sooner, but costs one gh call per repository per round; 0 stops automatic checks while manual Refresh still works.",
			"setting.inbox.intervalSeconds.recommended": "60 seconds is recommended.",
			"setting.inbox.intervalSeconds.tech": "Key inbox.intervalSeconds; env SPV_INBOX_INTERVAL_SECONDS; plugin config intervalSeconds; the file wins.",
			"setting.merge.installRepo.label": "Install-target repository",
			"setting.merge.installRepo.desc": "Which repository needs a cold install after its PRs merge.",
			"setting.merge.installRepo.changes": "Merges of this repository queue a cold-install notice instead of a plain pull; a wrong value means no notice.",
			"setting.merge.installRepo.recommended": "Keep wheelchair-agent.",
			"setting.merge.installRepo.tech": "Key merge.installRepo; owner/name or name; env SPV_INSTALL_REPO.",
			"setting.merge.autoMerge.label": "Auto-merge a ticket PR after delivery",
			"setting.merge.autoMerge.desc": "When on, ticket.delivered makes wheelchair-agent-webui try to merge the open PR for the ticket clone's current branch. PR identity comes from the clone's git branch and origin, never from the queue payload.",
			"setting.merge.autoMerge.changes": "All five gates must hold: exactly one open PR with a head branch/repository matching the clone; not a draft; mergeable is MERGEABLE; statusCheckRollup is non-empty and every check is SUCCESS (no CI checks logs no CI checks and does not merge); files exclude ARCHITECTURE.md, ARCHITECTURE/**, PROGRESS.md and INSTRUCTIONS.md. If any gate fails, the ticket directory is missing, or gh fails/times out, it logs one line and does not merge.",
			"setting.merge.autoMerge.recommended": "Default false: enabling it skips human review.",
			"setting.merge.autoMerge.tech": "Key merge.autoMerge; boolean; effective after a cold install; merges with gh pr merge <n> --repo <owner/name> --squash --delete-branch; the effect has a 120s cap.",
			"setting.injection.intervalMs.label": "Result injection interval (ms)",
			"setting.injection.intervalMs.desc": "How often the result injector checks for messages to send.",
			"setting.injection.intervalMs.changes": "Smaller is more immediate but reads files more often; larger is cheaper but results arrive later.",
			"setting.injection.intervalMs.recommended": "1000 ms is recommended.",
			"setting.injection.intervalMs.tech": "Key injection.intervalMs; range 50–3600000 ms.",
			"setting.injection.maxBodyChars.label": "Injected body limit (characters)",
			"setting.injection.maxBodyChars.desc": "How many characters of a message body reach the SPV session.",
			"setting.injection.maxBodyChars.changes": "Longer bodies are truncated; smaller can drop key facts, larger can make the session longer.",
			"setting.injection.maxBodyChars.recommended": "12000 characters is recommended.",
			"setting.injection.maxBodyChars.tech": "Key injection.maxBodyChars; range 100–200000 characters.",
			"setting.work.keep.label": "work gc newest directories to keep",
			"setting.work.keep.desc": "How many recent ticket directories automatic cleanup keeps by count.",
			"setting.work.keep.changes": "Larger uses more disk; 0 means no count-based keep, so age and rebuildability decide.",
			"setting.work.keep.recommended": "0 is recommended.",
			"setting.work.keep.tech": "Key work.keep; the --keep CLI flag still wins.",
			"setting.work.keepDays.label": "work gc retention days",
			"setting.work.keepDays.desc": "How many days of ticket directories automatic cleanup keeps.",
			"setting.work.keepDays.changes": "Larger keeps longer; 0 means no age-based retention.",
			"setting.work.keepDays.recommended": "0 is recommended.",
			"setting.work.keepDays.tech": "Key work.keepDays; the --keep-days CLI flag still wins.",
			"setting.work.sweepOnMount.label": "Reclaim at mount",
			"setting.work.sweepOnMount.desc": "Whether the service cleans up rebuildable ticket directories when it starts.",
			"setting.work.sweepOnMount.changes": "When off, only a manual wheelchair-agent work gc reclaims.",
			"setting.work.sweepOnMount.recommended": "On is recommended.",
			"setting.work.sweepOnMount.tech": "Key work.sweepOnMount; only the mount-time sweep is affected.",
			"template.injection.title": "Result injection template",
			"template.injection.desc": "The header and body injected into the SPV session; the built-in default reproduces the previous output byte-for-byte.",
			"template.prIssue.title": "PR issue notice text",
			"template.prIssue.desc": "Used when a PR issue comment is sent to the SPV entry session; the comment placeholder carries the original comment.",
			"template.spvObjection.title": "SPV objection notice",
			"template.spvObjection.desc": "Used when an objection to an SPV decision is written to the outbox; the comment placeholder carries the operator's comment.",
			refresh: "Refresh",
			"filter.label": "Filter",
			"filter.all": "All",
			"filter.pending": "Pending review",
			"filter.issue": "Issues",
			"filter.approved": "Approved",
			"filter.empty": "No letters in this filter.",
			"filter.kind": "Letter type",
			"filter.kind.all": "All",
			"filter.kind.pr": "PR",
			"filter.kind.spv_message": "SPV decision",
			"filter.repo": "Repository",
			"filter.repo.all": "All repositories",
			"filter.time": "Time",
			"filter.time.all": "All",
			"filter.time.day": "Last 24 hours",
			"filter.time.week": "Last 7 days",
			"filter.time.custom": "Custom range",
			"filter.time.since": "From",
			"filter.time.until": "To",
			"kind.pr": "PR",
			"kind.spv_message": "SPV decision",
			"status.loading": "Loading…",
			"status.loaded": "{count} letters · updated {time}",
			"status.failed": "Could not load: {message}",
			"inbox.empty": "The inbox is empty. Run “wheelchair-agent inbox watch --once” to fetch pull requests, or “inbox add” to write an SPV decision letter.",
			"card.untitled": "(untitled)",
			"card.files": "{count} files",
			"card.body": "PR description",
			"card.bodyEmpty": "(No PR description)",
			"card.letter": "Decision note",
			"card.letterEmpty": "(No decision note)",
			"card.thread": "Thread: {thread}",
			"card.open": "Open PR",
			"card.reviews": "Review history ({count})",
			"day.unknown": "Unknown date",
			"inbox.draftTag": "Draft",
			"inbox.draftHint": "This letter has an unsaved review draft",
			"status.pending": "Pending review",
			"status.approved": "Approved",
			"status.issue": "Issue",
			"form.pass": "Approve",
			"form.passHint": "The reason is optional and is only recorded in the inbox; it does not notify the agent.",
			"form.passPlaceholder": "Optional: why you accepted it (recorded only, no notification).",
			"form.issue": "Flag issue",
			"form.issueHint.pr": "Submitting notifies SPV.",
			"form.issueHint.spv_message": "Submitting notifies SPV.",
			"form.issuePlaceholder.pr": "Describe the problem; submitting notifies SPV.",
			"form.issuePlaceholder.spv_message": "Describe what you question; submitting notifies SPV.",
			"form.issueEmpty": "Describe the issue before submitting.",
			"form.submit": "Submit comment",
			"form.approveSubmit": "Record approval",
			"form.cancel": "Cancel",
			"form.failed": "Could not submit: {message}",
			"form.inflight": "Submitting…",
			"state.open": "Open",
			"state.merged": "Merged",
			"state.closed": "Closed"
		};

		/**
		* The sidebar glyph: a small inbox outline. The shell passes `size` (and
		* `active`, which this icon does not use); `active` is accepted and ignored so
		* the panel row renders in both wide and narrow columns.
		* @param props - shell-supplied icon presentation.
		* @returns the inbox glyph.
		*/
		function InboxIcon(props) {
			const size = typeof props?.size === "number" ? props.size : 16;
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("path", { d: "M2 9.5h3l1 1.8h4l1-1.8h3" }, "tray"),
					jsx("path", { d: "M2.8 9.5V4.2A1.2 1.2 0 0 1 4 3h8a1.2 1.2 0 0 1 1.2 1.2v5.3" }, "top"),
					jsx("path", { d: "M2.8 9.5v2.3A1.2 1.2 0 0 0 4 13h8a1.2 1.2 0 0 0 1.2-1.2V9.5" }, "bottom")
				]
			});
		}

		//#region inline SVG glyphs owned by this plugin
		/** The disclosure chevron; rotation is CSS so no second icon is needed. */
		function ChevronIcon(props) {
			return jsx("svg", {
				className: "wca-chevron",
				"data-open": props.open ? "true" : "false",
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: jsx("path", { d: "M6 3.5 10.5 8 6 12.5" })
			});
		}
		//#endregion

		//#region Markdown -> React
		//
		// A small, dependency-free CommonMark subset, enough to read a PR body: ATX
		// headings, unordered/ordered (nested) lists, fenced code, inline code, bold,
		// italic, strikethrough, links, blockquotes, horizontal rules, GFM pipe tables
		// and paragraphs. It deliberately does NOT support raw HTML (text becomes React
		// children, so nothing is injected), images, footnotes or math.

		const ESCAPABLE = "\\`*_{}[]()#+-.!|>~";
		const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|>|(?:[-*+]|\d+[.)])[ \t])/;

		/** Count the run of one character starting at `at`. */
		function runLength(text, at, char) {
			let end = at;
			while (end < text.length && text.charAt(end) === char) end += 1;
			return end - at;
		}

		/** Leading spaces of a line; tabs stay literal (collapsing them would corrupt code). */
		function indentOf(line) {
			let end = 0;
			while (end < line.length && line.charAt(end) === " ") end += 1;
			return end;
		}

		/** Normalize CRLF; tab expansion would corrupt tabs inside fenced code. */
		function normalizeSource(text) {
			return String(text ?? "").replace(/\r\n?/g, "\n");
		}

		/** A link destination React may follow: absolute http(s), mailto and protocol-relative. */
		function safeHref(value) {
			const raw = String(value ?? "").trim();
			if (raw === "") return undefined;
			if (!/^(?:https?:|mailto:|\/\/)/i.test(raw)) return undefined;
			try {
				const url = new URL(raw, "https://github.invalid/");
				if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return raw;
			} catch {
				return undefined;
			}
			return undefined;
		}

		/** http(s) only, for the "open PR" link the inbox item carries. */
		function safeWebHref(value) {
			try {
				const url = new URL(String(value ?? ""));
				return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
			} catch {
				return undefined;
			}
		}

		/** Parse an inline `[label](destination "title")` at `at`; undefined when malformed. */
		function parseLink(text, at) {
			if (text.charAt(at) !== "[") return undefined;
			let depth = 0;
			let close = -1;
			for (let index = at; index < text.length; index += 1) {
				const char = text.charAt(index);
				if (char === "\\") {
					index += 1;
					continue;
				}
				if (char === "[") depth += 1;
				else if (char === "]") {
					depth -= 1;
					if (depth === 0) {
						close = index;
						break;
					}
				}
			}
			if (close === -1 || text.charAt(close + 1) !== "(") return undefined;
			let parenthesis = 1;
			let end = -1;
			for (let index = close + 2; index < text.length; index += 1) {
				const char = text.charAt(index);
				if (char === "\\") {
					index += 1;
					continue;
				}
				if (char === "(") parenthesis += 1;
				else if (char === ")") {
					parenthesis -= 1;
					if (parenthesis === 0) {
						end = index;
						break;
					}
				}
			}
			if (end === -1) return undefined;
			const inside = text.slice(close + 2, end).trim();
			const match = /^(<[^<>\s]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*$/.exec(inside);
			if (match === null) return undefined;
			let destination = match[1];
			if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
			const href = safeHref(destination);
			if (href === undefined) return undefined;
			return { label: text.slice(at + 1, close), href, end: end + 1 };
		}

		/**
		* Render inline Markdown into React children.
		* @param text - inline source, possibly containing soft line breaks.
		* @param keyPrefix - stable prefix for generated keys.
		* @param inLink - true while rendering a link label, where nested links are invalid.
		* @returns React children (strings and elements).
		*/
		function inlineNodes(text, keyPrefix, inLink = false) {
			const nodes = [];
			let buffer = "";
			const flush = () => {
				if (buffer !== "") {
					nodes.push(buffer);
					buffer = "";
				}
			};
			const push = (element) => {
				flush();
				nodes.push(element);
			};
			let index = 0;
			while (index < text.length) {
				const char = text.charAt(index);
				if (char === "\\") {
					const next = text.charAt(index + 1);
					if (next === "\n") {
						buffer = buffer.replace(/[ \t]+$/, "");
						push(jsx("br", {}, `${keyPrefix}br${nodes.length}`));
						index += 2;
						continue;
					}
					if (ESCAPABLE.includes(next)) {
						buffer += next;
						index += 2;
						continue;
					}
					buffer += char;
					index += 1;
					continue;
				}
				if (char === "\n") {
					if (/[ ]{2,}$/.test(buffer)) {
						buffer = buffer.replace(/[ \t]+$/, "");
						push(jsx("br", {}, `${keyPrefix}br${nodes.length}`));
					} else if (buffer !== "" && !buffer.endsWith(" ")) {
						buffer += " ";
					}
					index += 1;
					continue;
				}
				if (char === "`") {
					const run = runLength(text, index, "`");
					const close = text.indexOf("`".repeat(run), index + run);
					if (close !== -1) {
						let code = text.slice(index + run, close);
						if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
						push(jsx("code", { children: code }, `${keyPrefix}code${nodes.length}`));
						index = close + run;
						continue;
					}
					buffer += text.slice(index, index + run);
					index += run;
					continue;
				}
				// Images are unsupported; show their alt text as a plain link to the image, not "!" + link.
				if (char === "!" && !inLink && text.charAt(index + 1) === "[") {
					const image = parseLink(text, index + 1);
					if (image !== undefined) {
						const alt = image.label.trim();
						push(
							jsx(
								"a",
								{
									className: "wca-image-link",
									href: image.href,
									target: "_blank",
									rel: "noopener noreferrer",
									title: image.href,
									children: alt === "" ? "image" : alt
								},
								`${keyPrefix}image${nodes.length}`
							)
						);
						index = image.end;
						continue;
					}
				}
				if (char === "[" && !inLink) {
					const link = parseLink(text, index);
					if (link !== undefined) {
						push(
							jsx(
								"a",
								{
									href: link.href,
									target: "_blank",
									rel: "noopener noreferrer",
									children: inlineNodes(link.label, `${keyPrefix}link${nodes.length}-`, true)
								},
								`${keyPrefix}link${nodes.length}`
							)
						);
						index = link.end;
						continue;
					}
				}
				if (char === "*" || char === "_") {
					const previous = index === 0 ? "" : text.charAt(index - 1);
					// Underscores inside a word (snake_case) are literal; asterisks may sit inside one.
					const intraword = char === "_" && /[A-Za-z0-9]/.test(previous);
					const run = runLength(text, index, char);
					if (run >= 3 && !intraword) {
						const triple = new RegExp(`^\\${char}{3}(?=\\S)([\\s\\S]*?\\S)\\${char}{3}`).exec(
							text.slice(index)
						);
						if (triple !== null) {
							push(
								jsx(
									"strong",
									{
										children: jsx("em", {
											children: inlineNodes(triple[1], `${keyPrefix}emstrong${nodes.length}-`, inLink)
										})
									},
									`${keyPrefix}emstrong${nodes.length}`
								)
							);
							index += triple[0].length;
							continue;
						}
					}
					const strong = new RegExp(`^\\${char}{2}(?=\\S)([\\s\\S]*?\\S)\\${char}{2}`).exec(text.slice(index));
					if (strong !== null && !intraword) {
						push(
							jsx(
								"strong",
								{ children: inlineNodes(strong[1], `${keyPrefix}strong${nodes.length}-`, inLink) },
								`${keyPrefix}strong${nodes.length}`
							)
						);
						index += strong[0].length;
						continue;
					}
					const emphasis = new RegExp(`^\\${char}(?=\\S)([\\s\\S]*?\\S)\\${char}`).exec(text.slice(index));
					if (emphasis !== null && !intraword) {
						push(
							jsx(
								"em",
								{ children: inlineNodes(emphasis[1], `${keyPrefix}em${nodes.length}-`, inLink) },
								`${keyPrefix}em${nodes.length}`
							)
						);
						index += emphasis[0].length;
						continue;
					}
				}
				if (char === "~" && text.charAt(index + 1) === "~") {
					const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(text.slice(index));
					if (strike !== null) {
						push(
							jsx(
								"del",
								{ children: inlineNodes(strike[1], `${keyPrefix}del${nodes.length}-`, inLink) },
								`${keyPrefix}del${nodes.length}`
							)
						);
						index += strike[0].length;
						continue;
					}
				}
				buffer += char;
				index += 1;
			}
			flush();
			return nodes;
		}

		/** A single list marker with its indentation and the column its content starts at. */
		function matchListItem(line) {
			const match = /^([ ]*)([-*+]|\d+[.)])([ \t]+)(.*)$/.exec(line);
			if (match === null) return undefined;
			const marker = match[2];
			return {
				indent: match[1].length,
				marker,
				ordered: /\d/.test(marker.charAt(0)),
				contentColumn: match[1].length + marker.length + Math.min(match[3].length, 4),
				content: match[4]
			};
		}

		/** Split one pipe-table row, honoring code spans and escaped pipes. */
		function splitTableRow(line) {
			const cells = [];
			let buffer = "";
			let codeRun = 0;
			for (let index = 0; index < line.length; index += 1) {
				const char = line.charAt(index);
				if (char === "\\" && line.charAt(index + 1) === "|") {
					buffer += "|";
					index += 1;
					continue;
				}
				if (char === "`") {
					const run = runLength(line, index, "`");
					codeRun = codeRun === 0 ? run : codeRun === run ? 0 : codeRun;
					buffer += "`".repeat(run);
					index += run - 1;
					continue;
				}
				if (char === "|" && codeRun === 0) {
					cells.push(buffer);
					buffer = "";
					continue;
				}
				buffer += char;
			}
			cells.push(buffer);
			if (cells.length > 0 && cells[0].trim() === "") cells.shift();
			if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
			return cells;
		}

		/** Parse a GFM table at `start`; undefined when these lines are not a table. */
		function parseTable(lines, start, key) {
			if (start + 1 >= lines.length) return undefined;
			const header = lines[start];
			if (!header.includes("|")) return undefined;
			const delimiter = lines[start + 1];
			if (!delimiter.includes("|")) return undefined;
			if (!/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(delimiter)) {
				return undefined;
			}
			const headCells = splitTableRow(header);
			const delimiterCells = splitTableRow(delimiter);
			if (headCells.length === 0 || headCells.length !== delimiterCells.length) return undefined;
			const align = delimiterCells.map((cell) => {
				const value = cell.trim();
				if (value.startsWith(":") && value.endsWith(":")) return "center";
				if (value.endsWith(":")) return "right";
				if (value.startsWith(":")) return "left";
				return undefined;
			});
			let index = start + 2;
			const bodyRows = [];
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === "" || !line.includes("|")) break;
				bodyRows.push(splitTableRow(line));
				index += 1;
			}
			const headRow = jsxs(
				"thead",
				{
					children: jsx(
						"tr",
						{
							children: headCells.map((cell, column) =>
								jsx(
									"th",
									{
										style: align[column] === undefined ? undefined : { textAlign: align[column] },
										children: inlineNodes(cell.trim(), `${key}h${column}-`)
									},
									`${key}h${column}`
								)
							)
						},
						`${key}hr`
					)
				},
				`${key}thead`
			);
			const body = jsxs(
				"tbody",
				{
					children: bodyRows.map((row, rowIndex) =>
						jsx(
							"tr",
							{
								children: headCells.map((_cell, column) =>
									jsx(
										"td",
										{
											style: align[column] === undefined ? undefined : { textAlign: align[column] },
											children: inlineNodes(String(row[column] ?? "").trim(), `${key}r${rowIndex}c${column}-`)
										},
										`${key}r${rowIndex}c${column}`
									)
								)
							},
							`${key}r${rowIndex}`
						)
					)
				},
				`${key}tbody`
			);
			return {
				next: index,
				node: jsx(
					"div",
					{
						className: "wca-table-scroll",
						children: jsxs("table", { children: [headRow, bodyRows.length > 0 ? body : null] }, `${key}table`)
					},
					key
				)
			};
		}

		/** Parse one list (nested lists arrive through recursion) starting at `start`. */
		function parseList(lines, start, key, depth) {
			const first = matchListItem(lines[start]);
			if (first === undefined) return undefined;
			const baseIndent = first.indent;
			const ordered = first.ordered;
			const startNumber = ordered ? Number.parseInt(first.marker, 10) : 1;
			const items = [];
			let index = start;
			let itemKey = 0;
			while (index < lines.length) {
				const marker = matchListItem(lines[index]);
				if (marker === undefined || marker.indent !== baseIndent || marker.ordered !== ordered) break;
				const content = [marker.content];
				let cursor = index + 1;
				while (cursor < lines.length) {
					const line = lines[cursor];
					if (line.trim() === "") {
						let lookahead = cursor + 1;
						while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead += 1;
						if (lookahead >= lines.length) {
							cursor = lines.length;
							break;
						}
						const nextMarker = matchListItem(lines[lookahead]);
						if (nextMarker !== undefined && nextMarker.indent === baseIndent) {
							// A blank line between same-type items keeps one loose list instead of
							// splitting it into two lists (which would restart ordered numbering).
							if (nextMarker.ordered === ordered) cursor = lookahead;
							break;
						}
						if (indentOf(lines[lookahead]) >= marker.contentColumn) {
							content.push("");
							cursor += 1;
							continue;
						}
						break;
					}
					const nextMarker = matchListItem(line);
					if (nextMarker !== undefined && nextMarker.indent === baseIndent) break;
					const indent = indentOf(line);
					if (indent < marker.contentColumn && indent <= baseIndent) break;
					content.push(line.slice(Math.min(indent, marker.contentColumn)));
					cursor += 1;
				}
				items.push({ lines: content, key: `${key}i${itemKey}` });
				itemKey += 1;
				index = cursor;
			}
			const children = items.map((item) => {
				const blocks = renderBlocks(item.lines, `${item.key}-`, depth + 1);
				// A tight list item renders its text directly, not inside a paragraph: unwrap the
				// leading paragraph and keep any nested blocks (sublists, code, tables) after it.
				const firstBlock = blocks.length > 0 ? blocks[0] : undefined;
				const itemChildren =
					firstBlock !== undefined && firstBlock.type === "p"
						? [...firstBlock.props.children, ...blocks.slice(1)]
						: blocks;
				return jsx("li", { children: itemChildren }, item.key);
			});
			return {
				next: index,
				node: ordered
					? jsx("ol", { start: startNumber === 1 ? undefined : startNumber, children }, key)
					: jsx("ul", { children }, key)
			};
		}

		/** Render the block-level Markdown of one document (or one list item). */
		function renderBlocks(lines, keyPrefix, depth = 0) {
			// A hostile PR body can nest quotes/lists thousands deep; stop before the JavaScript stack
			// runs out and show the remaining source instead of letting a slot crash blank the panel.
			if (depth > 64) {
				return [jsx("pre", { className: "wca-md-deep", children: lines.join("\n") }, `${keyPrefix}deep`)];
			}
			const out = [];
			let index = 0;
			let blockKey = 0;
			const key = () => `${keyPrefix}b${blockKey++}`;
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === "") {
					index += 1;
					continue;
				}
				const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
				if (fence !== null) {
					const fenceChar = fence[1].charAt(0);
					const fenceLength = fence[1].length;
					const info = fence[2].trim();
					const language = /^[A-Za-z0-9_+#.-]*/.exec(info)?.[0] ?? "";
					const openIndent = line.length - line.trimStart().length;
					const body = [];
					index += 1;
					while (index < lines.length) {
						const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]);
						if (closing !== null && closing[1].charAt(0) === fenceChar && closing[1].length >= fenceLength) {
							index += 1;
							break;
						}
						body.push(lines[index].slice(Math.min(openIndent, indentOf(lines[index]))));
						index += 1;
					}
					out.push(
						jsx(
							"pre",
							{
								"data-language": language === "" ? undefined : language,
								children: jsx("code", { children: body.join("\n") })
							},
							key()
						)
					);
					continue;
				}
				const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
				if (heading !== null) {
					const level = heading[1].length;
					const content = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
					const headingKey = key();
					out.push(jsx(`h${level}`, { children: inlineNodes(content, `${headingKey}-`) }, headingKey));
					index += 1;
					continue;
				}
				if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
					out.push(jsx("hr", {}, key()));
					index += 1;
					continue;
				}
				const tableKey = key();
				const table = parseTable(lines, index, tableKey);
				if (table !== undefined) {
					out.push(table.node);
					index = table.next;
					continue;
				}
				if (/^ {0,3}>/.test(line)) {
					const quoted = [];
					while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
						quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ""));
						index += 1;
					}
					const quoteKey = key();
					out.push(
						jsx("blockquote", { children: renderBlocks(quoted, `${quoteKey}-`, depth + 1) }, quoteKey)
					);
					continue;
				}
				const listKey = key();
				const list = parseList(lines, index, listKey, depth);
				if (list !== undefined) {
					out.push(list.node);
					index = list.next;
					continue;
				}
				const paragraph = [line];
				index += 1;
				while (
					index < lines.length &&
					lines[index].trim() !== "" &&
					!BLOCK_START.test(lines[index]) &&
					!/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(lines[index])
				) {
					paragraph.push(lines[index]);
					index += 1;
				}
				const paragraphKey = key();
				out.push(jsx("p", { children: inlineNodes(paragraph.join("\n"), `${paragraphKey}-`) }, paragraphKey));
			}
			return out;
		}

		/**
		* Render a Markdown document as React elements.
		* @param text - Markdown source.
		* @returns the block elements; an empty array for empty input.
		*/
		function renderMarkdown(text) {
			const source = normalizeSource(text);
			if (source.trim() === "") return [];
			try {
				return renderBlocks(source.split("\n"), "");
			} catch (error) {
				// Never let an externally supplied body throw past the component: a slot crash blanks
				// the whole main page. Degrade to the raw source instead.
				return [jsx("pre", { className: "wca-md-deep", children: source }, "markdown-fallback")];
			}
		}

		/** Memoized Markdown body; parsing only happens once per distinct PR body. */
		function Markdown(props) {
			const blocks = react.useMemo(() => renderMarkdown(props.text), [props.text]);
			return jsx("div", { className: "wca-md", children: blocks });
		}
		//#endregion

		//#region styles
		//
		// Styling follows the host: the page uses the Plugin Manager page's padding and
		// max-width rhythm, and controls copy the primitive CSS (Button, Tag,
		// SegmentedTabs, DisclosureRow) with a `wca-` prefix so no host class is
		// reused. Every color comes from a `--dsw-alias-*` token; no literal color is
		// hardcoded, so light and dark themes are both the host's call.
		const STYLES = `
			/* Layout is the same in every style. A variant block may change material, radius and motion,
			   never the structure; adding a third style is one more [data-wca-style] block. */
			.wca-page {
				/* The one width knob for the inbox and the settings page: both are children of this
				   page, so a single custom property moves both frames together and they cannot drift.
				   960 was the old frame; 1200 is the operator's 1.25x request. */
				--wca-content-max: 1200px;
				box-sizing: border-box;
				height: 100%;
				min-height: 100%;
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 22px;
				padding: 0 clamp(20px, 3.2vw, 40px) 48px;
				overflow: auto;
				color: var(--dsw-alias-label-primary);
			}
			.wca-page > * { width: 100%; max-width: var(--wca-content-max); }
			.wca-head {
				box-sizing: border-box;
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 16px;
				padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
			}
			.wca-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
			.wca-subtitle {
				margin: 4px 0 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-nav { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; }
			.wca-nav-label {
				flex: none;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				font-weight: 600;
				letter-spacing: .02em;
			}
			.wca-tabs {
				display: flex;
				gap: 4px;
				width: fit-content;
				min-width: 0;
				overflow-x: auto;
				padding: 4px;
				border-radius: var(--dsw-radius-lg);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-tab {
				height: 34px;
				padding: 0 12px;
				border: 0;
				border-radius: var(--dsw-radius-md);
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 14px;
				line-height: 20px;
				cursor: pointer;
				white-space: nowrap;
			}
			.wca-tab:hover { color: var(--dsw-alias-label-primary); }
			.wca-tab[aria-selected="true"] {
				border: .5px solid var(--dsw-alias-border-l3);
				background: var(--dsw-alias-bg-layer-3);
				color: var(--dsw-alias-label-primary);
				font-weight: 600;
			}
			.wca-tab:focus-visible,
			.wca-select:focus-visible,
			.wca-date:focus-visible,
			.wca-segment:focus-visible,
			.wca-btn:focus-visible,
			.wca-disclosure-toggle:focus-visible,
			.wca-comment:focus-visible,
			.wca-input:focus-visible,
			.wca-textarea:focus-visible,
			.wca-open:focus-visible,
			.wca-tech summary:focus-visible {
				outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
				outline-offset: 2px;
			}
			.wca-feature {
				box-sizing: border-box;
				min-width: 0;
				border: 0;
				background: transparent;
			}
			.wca-feature-head {
				box-sizing: border-box;
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 16px;
				padding: 0 2px 6px;
				flex-wrap: wrap;
			}
			.wca-feature-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
			.wca-feature-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
			.wca-feature-desc {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-toolbar {
				display: flex;
				align-items: center;
				justify-content: flex-end;
				gap: 10px;
				flex-wrap: wrap;
			}
			.wca-segmented {
				display: flex;
				align-items: center;
				gap: 2px;
				padding: 2px;
				border-radius: var(--dsw-radius-md);
				background: var(--dsw-alias-interactive-bg-hover);
			}
			.wca-segment {
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				gap: 6px;
				height: 26px;
				padding: 0 9px;
				border: .5px solid transparent;
				border-radius: var(--dsw-radius-sm);
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 12px;
				line-height: 18px;
				cursor: pointer;
				white-space: nowrap;
			}
			.wca-segment:hover { color: var(--dsw-alias-label-primary); }
			.wca-segment[aria-pressed="true"] {
				border-color: var(--dsw-alias-border-l3);
				background: var(--dsw-alias-bg-layer-1);
				color: var(--dsw-alias-label-primary);
				font-weight: 500;
			}
			.wca-segment-count,
			.wca-template-count,
			.wca-diff { font-variant-numeric: tabular-nums; }
			.wca-segment-count { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
			.wca-filterbar {
				display: flex;
				align-items: flex-end;
				gap: 10px 16px;
				flex-wrap: wrap;
				padding: 4px 2px 2px;
			}
			.wca-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
			.wca-field-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
			.wca-select,
			.wca-date {
				box-sizing: border-box;
				height: 30px;
				padding: 0 8px;
				border: .5px solid var(--dsw-alias-border-l3);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
			}
			.wca-select:disabled { opacity: .5; cursor: not-allowed; }
			.wca-date { color-scheme: light dark; }
			.wca-hint {
				margin: 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-feature-body { display: flex; flex-direction: column; min-width: 0; }
			.wca-status {
				margin: 12px 2px 0;
				min-height: 20px;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }

			/* Inbox: one card per letter; days are separated by spacing only. Each card carries its
			   own timestamp, so there is no date rail and no empty column on the left. */
			.wca-days { display: flex; flex-direction: column; gap: 24px; padding-top: 10px; }
			.wca-day { display: flex; flex-direction: column; min-width: 0; }
			.wca-cards { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

			.wca-letter {
				position: relative;
				box-sizing: border-box;
				display: flex;
				flex-direction: column;
				gap: 10px;
				min-width: 0;
				padding: 14px 16px 14px 18px;
				border: 1px solid var(--dsw-alias-border-l2);
				border-radius: 8px;
				background: var(--dsw-alias-bg-layer-1);
				overflow: hidden;
			}
			.wca-letter::before {
				content: "";
				position: absolute;
				inset-block: 0;
				inset-inline-start: 0;
				width: 4px;
				background: var(--wca-spine, var(--dsw-alias-label-tertiary));
			}
			.wca-letter[data-kind="project"] { --wca-spine: var(--dsw-alias-state-business-primary); }
			.wca-project-workers { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
			.wca-project-worker {
				display: flex;
				flex-direction: column;
				gap: 5px;
				padding-top: 10px;
				border-top: 1px solid var(--dsw-alias-border-l2);
			}
			.wca-project-worker:first-child { border-top: 0; padding-top: 0; }
			.wca-project-worker-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.wca-project-worker-head strong { font-size: 13px; font-weight: 600; }
			.wca-project-jump { margin-top: 2px; }
			.wca-project-jump a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
			.wca-project-jump a:hover { text-decoration: underline; }
			.wca-project-path {
				font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
				font-size: 12px;
				overflow-wrap: anywhere;
			}
			.wca-project-running {
				margin: 0;
				padding-left: 18px;
				color: var(--dsw-alias-label-secondary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-project-running li { overflow-wrap: anywhere; }
			.wca-letter[data-kind="pr"] { --wca-tint: var(--dsw-alias-button-primary-fill); }
			.wca-letter[data-kind="spv_message"] {
				--wca-tint: var(--dsw-alias-state-business-primary);
				border-radius: 14px;
				padding-inline: 22px 20px;
			}
			.wca-letter[data-kind="spv_message"]::before { width: 5px; }
			.wca-letter[data-status="pending"] { --wca-spine: color-mix(in oklab, var(--dsw-alias-label-tertiary) 72%, transparent); }
			.wca-letter[data-status="approved"] { --wca-spine: var(--dsw-alias-state-success-primary); }
			.wca-letter[data-status="issue"] { --wca-spine: var(--dsw-alias-state-error-primary); }
			.wca-letter[data-status="approved"] .wca-letter-title {
				color: var(--dsw-alias-label-secondary);
				font-weight: 500;
			}
			.wca-letter[data-draft="true"] { border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2)); }
			.wca-letter-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
			}
			.wca-letter-origin { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
			.wca-letter-glyph { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
			.wca-kind {
				color: var(--dsw-alias-label-tertiary);
				font-size: 11px;
				line-height: 16px;
				font-weight: 600;
				letter-spacing: .04em;
				text-transform: uppercase;
			}
			.wca-state-tag { font-weight: 400; }
			.wca-repo { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
			.wca-repo strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
			.wca-letter-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
			.wca-meta {
				display: flex;
				align-items: baseline;
				gap: 10px;
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-meta-diff { min-width: 0; }
			.wca-letter-time {
				flex: none;
				margin-inline-start: auto;
				color: var(--dsw-alias-label-tertiary);
				font-variant-numeric: tabular-nums;
				white-space: nowrap;
			}
			.wca-diff { font: var(--dsw-font-markdown-code-block-small); }
			.wca-added { color: var(--dsw-alias-state-success-primary); }
			.wca-removed { color: var(--dsw-alias-state-error-primary); }
			.wca-letter-body {
				display: flex;
				flex-direction: column;
				gap: 8px;
				min-width: 0;
				padding-top: 10px;
			}
			.wca-letter-foot .wca-form { flex: 1 1 260px; }
			.wca-letter-foot {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				flex-wrap: wrap;
				margin-top: auto;
				padding-top: 2px;
			}
			.wca-tag {
				display: inline-flex;
				align-items: center;
				border-radius: 999px;
				padding: 1px 8px;
				font-size: 11px;
				line-height: 17px;
				font-weight: 500;
				white-space: nowrap;
			}
			.wca-tag[data-tone="success"] {
				background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
				color: var(--dsw-alias-state-success-primary);
			}
			.wca-tag[data-tone="info"] {
				background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
				color: var(--dsw-alias-state-business-primary);
			}
			.wca-tag[data-tone="warning"] {
				background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
				color: var(--dsw-alias-state-warn-primary);
			}
			.wca-tag[data-tone="danger"] {
				background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
				color: var(--dsw-alias-state-error-primary);
			}
			.wca-tag[data-tone="neutral"] {
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
			}
			.wca-status-pill {
				position: relative;
				isolation: isolate;
				display: inline-flex;
				align-items: center;
				flex: none;
				padding: 1px 8px;
				border-radius: 999px;
				font-size: 11px;
				line-height: 17px;
				font-weight: 500;
				white-space: nowrap;
			}
			.wca-status-pill::before {
				content: "";
				position: absolute;
				inset: 0;
				z-index: -1;
				border-radius: inherit;
				background: var(--wca-pill, var(--dsw-alias-bg-module-platform));
			}
			.wca-status-pill[data-tone="pending"] {
				color: var(--dsw-alias-label-tertiary);
				--wca-pill: var(--dsw-alias-bg-module-platform);
			}
			.wca-status-pill[data-tone="success"] {
				color: var(--dsw-alias-state-success-primary);
				--wca-pill: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
			}
			.wca-status-pill[data-tone="danger"] {
				color: var(--dsw-alias-state-error-primary);
				--wca-pill: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
			}
			.wca-btn {
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 4px;
				height: 28px;
				padding: 0 10px;
				border: 0;
				border-radius: var(--dsw-radius-sm);
				background: transparent;
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 12px;
				line-height: 18px;
				cursor: pointer;
			}
			.wca-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
			.wca-btn:disabled { opacity: .4; cursor: not-allowed; }
			.wca-btn[data-variant="primary"] {
				background: var(--dsw-alias-button-primary-fill);
				color: var(--dsw-alias-label-primary-foreground);
			}
			.wca-btn[data-variant="primary"]:hover:not(:disabled) {
				background: var(--dsw-alias-button-primary-hover);
			}
			.wca-btn[data-variant="outline"] { border: .5px solid var(--dsw-alias-border-l3); }
			.wca-disclosure { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
			.wca-disclosure-toggle {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				width: fit-content;
				padding: 2px 0;
				border: 0;
				background: none;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
				cursor: pointer;
			}
			.wca-disclosure-toggle:hover { color: var(--dsw-alias-label-primary); }
			.wca-chevron { flex: none; }
			.wca-chevron[data-open="true"] { transform: rotate(90deg); }
			.wca-disclosure-body {
				display: grid;
				grid-template-rows: 0fr;
				opacity: 0;
				visibility: hidden;
				min-width: 0;
			}
			.wca-disclosure-body[data-open="true"] { grid-template-rows: 1fr; opacity: 1; visibility: visible; }
			.wca-disclosure-inner { min-height: 0; overflow: hidden; min-width: 0; opacity: 0; }
			.wca-disclosure-body[data-open="true"] .wca-disclosure-inner { opacity: 1; }
			.wca-reviews { display: flex; flex-direction: column; gap: 8px; }
			.wca-reviews-title { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
			.wca-review {
				padding: 8px 10px;
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-review-head { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
			.wca-review-time { color: var(--dsw-alias-label-tertiary); }
			.wca-review-text {
				margin: 2px 0 0;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
				font-size: var(--dsh-content-font-size-secondary, 13px);
				line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
			}
			.wca-form { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
			.wca-issue-box {
				display: flex;
				flex-direction: column;
				gap: 8px;
				padding: 10px;
				border: .5px solid var(--dsw-alias-border-l2);
				border-radius: var(--dsw-radius-md);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-comment {
				box-sizing: border-box;
				width: 100%;
				min-height: 64px;
				resize: vertical;
				padding: 8px 10px;
				border: .5px solid var(--dsw-alias-border-l4);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
			}
			.wca-comment::placeholder { color: var(--dsw-alias-label-dimmed); }
			.wca-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
			.wca-form-error {
				margin: 0;
				min-height: 18px;
				color: var(--dsw-alias-state-error-primary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-open {
				width: fit-content;
				color: var(--dsw-alias-link);
				font-size: 13px;
				line-height: 20px;
				text-decoration: none;
			}
			.wca-open:hover { text-decoration: underline; }
			.wca-empty { margin: 16px 2px 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }

			/* Markdown body: type, spacing and code surfaces follow the host Markdown. */
			.wca-md {
				min-width: 0;
				overflow-wrap: anywhere;
				font: var(--dsw-font-markdown-base);
				color: var(--dsw-alias-label-primary);
			}
			.wca-md > :first-child { margin-top: 0; }
			.wca-md > :last-child { margin-bottom: 0; }
			.wca-md strong { font-weight: 600; }
			.wca-md h1 { font: var(--dsw-font-markdown-h1); margin: 24px 0 12px; }
			.wca-md h2 { font: var(--dsw-font-markdown-h2); margin: 22px 0 10px; }
			.wca-md h3 { font: var(--dsw-font-markdown-h3); margin: 20px 0 8px; }
			.wca-md h4 { font: var(--dsw-font-markdown-h4); margin: 16px 0 6px; }
			.wca-md :is(h5, h6) { font: var(--dsw-font-markdown-base-strong); margin: 14px 0 6px; }
			.wca-md p { margin: 12px 0; }
			.wca-md :where(ul, ol) { margin: 12px 0; padding-left: 22px; }
			.wca-md li:not(:first-child) { margin-top: 4px; }
			.wca-md li::marker { color: var(--dsw-alias-label-secondary); }
			.wca-md li > :where(ul, ol) { margin-top: 4px; }
			.wca-md a { color: var(--dsw-alias-link); font-weight: 500; text-decoration: none; }
			.wca-md a:hover { text-decoration: underline; text-underline-offset: 3px; }
			.wca-md :not(pre) > code {
				font: var(--dsw-font-markdown-code);
				font-size: .875em;
				background: var(--dsw-alias-markdown-inline-code);
				border: .5px solid var(--dsw-alias-border-l1);
				border-radius: var(--dsw-radius-sm);
				padding: 0 5px;
			}
			.wca-md pre {
				margin: 12px 0;
				padding: 12px 14px;
				overflow: auto;
				border: .5px solid var(--dsw-alias-border-l1);
				border-radius: var(--dsw-radius-lg);
				background: var(--dsw-alias-markdown-code-block);
				color: var(--dsw-alias-label-primary);
				font: var(--dsw-font-markdown-code-block-small);
			}
			.wca-md pre code { font: inherit; background: none; border: 0; padding: 0; }
			.wca-md blockquote {
				margin: 12px 0;
				padding-left: 14px;
				border-left: 2px solid var(--dsw-alias-label-caption);
				color: var(--dsw-alias-label-secondary);
			}
			.wca-md hr { height: .5px; margin: 20px 0; border: 0; background: var(--dsw-alias-border-l2); }
			.wca-md .wca-table-scroll { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
			.wca-md table { border-collapse: collapse; width: max-content; max-width: 100%; }
			.wca-md th,
			.wca-md td {
				max-width: min(30vw, 320px);
				padding: 8px 12px;
				border: .5px solid var(--dsw-alias-border-l2);
				text-align: start;
				vertical-align: top;
				overflow-wrap: anywhere;
			}
			.wca-md th { background: var(--dsw-alias-bg-module-platform); font: var(--dsw-font-markdown-table-head); }
			.wca-md td { font: var(--dsw-font-markdown-table); }

			/* Settings: one card per group, two-column rows. No rule between groups or rows. */
			.wca-settings { display: flex; flex-direction: column; gap: 12px; padding: 6px 0 16px; }
			.wca-settings-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
			.wca-settings-status {
				margin: 0;
				min-height: 20px;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-settings-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
			.wca-settings-status[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
			.wca-settings-summary {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-settings-banner {
				box-sizing: border-box;
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 12px;
				margin: 0;
				padding: 10px 12px;
				border: .5px solid var(--dsw-alias-border-l2);
				border-left: 3px solid var(--dsw-alias-state-warn-primary);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-module-platform);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-settings-banner[data-tone="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
			.wca-settings-banner[data-tone="info"] { border-left-color: var(--dsw-alias-state-business-primary); }
			.wca-settings-banners { display: flex; flex-direction: column; gap: 8px; }
			.wca-settings-banner-text { margin: 0; min-width: 0; overflow-wrap: anywhere; }
			.wca-settings-group {
				display: flex;
				flex-direction: column;
				gap: 4px;
				min-width: 0;
				padding: 14px 16px;
				border: 1px solid var(--dsw-alias-border-l2);
				border-radius: 16px;
				background: var(--dsw-alias-bg-layer-1);
			}
			.wca-settings-group-title {
				margin: 0 0 2px;
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
				font-weight: 600;
				letter-spacing: .02em;
			}
			.wca-setting {
				display: grid;
				grid-template-columns: minmax(0, 1.45fr) minmax(240px, 1fr);
				gap: 8px 28px;
				align-items: start;
				min-width: 0;
				padding: 12px 0;
			}
			.wca-setting[data-draft="true"] .wca-setting-label { color: var(--dsw-alias-label-primary); }
			.wca-setting-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
			.wca-setting-side {
				display: flex;
				flex-direction: column;
				align-items: flex-start;
				gap: 6px;
				min-width: 0;
			}
			.wca-setting-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
			.wca-setting-label { font-size: 14px; line-height: 20px; font-weight: 500; }
			.wca-setting-desc {
				margin: 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-setting-effect,
			.wca-setting-recommended {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-setting-recommended { color: var(--dsw-alias-label-secondary); }
			.wca-tech { display: block; }
			.wca-tech summary {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 18px;
				height: 18px;
				border: .5px solid var(--dsw-alias-border-l4);
				border-radius: 999px;
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
				font-size: 11px;
				font-weight: 600;
				line-height: 16px;
				cursor: pointer;
				list-style: none;
			}
			.wca-tech summary::-webkit-details-marker { display: none; }
			.wca-tech[open] summary { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l4); }
			.wca-tech-text {
				display: block;
				margin: 4px 0 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-setting-meta {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				font-variant-numeric: tabular-nums;
			}
			.wca-setting-values { display: flex; align-items: flex-end; gap: 10px 16px; flex-wrap: wrap; width: 100%; }
			.wca-input {
				box-sizing: border-box;
				height: 30px;
				min-width: 0;
				width: min(320px, 100%);
				padding: 0 8px;
				border: .5px solid var(--dsw-alias-border-l3);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
			}
			.wca-input:disabled { opacity: .5; cursor: not-allowed; }
			.wca-switch {
				display: inline-flex;
				align-items: center;
				gap: 8px;
				font-size: 13px;
				line-height: 20px;
				cursor: pointer;
			}
			.wca-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
			.wca-switch-track {
				position: relative;
				display: inline-block;
				width: 34px;
				height: 20px;
				border-radius: 999px;
				background: var(--dsw-alias-border-l3);
			}
			.wca-switch-track::after {
				content: "";
				position: absolute;
				top: 2px;
				left: 2px;
				width: 16px;
				height: 16px;
				border-radius: 50%;
				background: var(--dsw-alias-bg-layer-1);
				box-shadow: 0 1px 2px color-mix(in oklab, var(--dsw-alias-label-primary) 18%, transparent);
			}
			.wca-switch input:checked + .wca-switch-track { background: var(--dsw-alias-state-business-primary); }
			.wca-switch input:checked + .wca-switch-track::after { transform: translateX(14px); }
			.wca-switch input:focus-visible + .wca-switch-track {
				outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
				outline-offset: 2px;
			}
			.wca-setting-note {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-setting-error,
			.wca-template-error {
				margin: 0;
				min-height: 18px;
				color: var(--dsw-alias-state-error-primary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-template {
				display: flex;
				flex-direction: column;
				gap: 8px;
				min-width: 0;
				padding: 12px;
				border: .5px solid var(--dsw-alias-border-l2);
				border-radius: var(--dsw-radius-md);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-template-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
			.wca-template-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
			.wca-template-desc { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
			.wca-template-controls { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
			.wca-template-controls .wca-field { flex-direction: row; align-items: center; gap: 6px; }
			.wca-textarea {
				box-sizing: border-box;
				width: 100%;
				min-height: 120px;
				resize: vertical;
				padding: 8px 10px;
				border: .5px solid var(--dsw-alias-border-l4);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: var(--dsw-font-markdown-code-block-small);
				font-size: 12px;
				line-height: 19px;
			}
			.wca-textarea:read-only { opacity: .85; }
			.wca-textarea:disabled { opacity: .5; cursor: not-allowed; }
			.wca-template-meta {
				display: flex;
				align-items: baseline;
				justify-content: space-between;
				gap: 8px 16px;
				flex-wrap: wrap;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-template-meta[data-over="true"] .wca-template-count { color: var(--dsw-alias-state-error-primary); }
			.wca-template-placeholders { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
			.wca-placeholders { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
			.wca-placeholder {
				padding: 1px 6px;
				border: .5px solid var(--dsw-alias-border-l2);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-secondary);
				font: var(--dsw-font-markdown-code);
				font-size: 11px;
				line-height: 17px;
			}
			.wca-placeholder[data-required="true"] { border-color: var(--dsw-alias-border-l4); color: var(--dsw-alias-label-primary); }
			.wca-template-new { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
			.wca-settings-notes { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px 0; }

			/* Hooks: one card per event. The card is a reading surface, not a control surface: the
			   only writable thing is a built-in row's display name, which goes through the same
			   revision-checked settings PUT as the Settings section. */
			.wca-hooks { display: flex; flex-direction: column; gap: 12px; padding: 6px 0 16px; }
			.wca-hooks-summary {
				display: flex;
				align-items: center;
				gap: 8px 14px;
				flex-wrap: wrap;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-hooks-summary[data-off="true"] { color: var(--dsw-alias-state-warn-primary); }
			.wca-hooks-event {
				display: flex;
				flex-direction: column;
				gap: 10px;
				min-width: 0;
				padding: 16px;
				border: 1px solid var(--dsw-alias-border-l2);
				border-radius: 16px;
				background: var(--dsw-alias-bg-layer-1);
			}
			.wca-hooks-event-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
			.wca-hooks-event-title { margin: 0; font-size: 15px; font-weight: 500; line-height: 22px; }
			.wca-hooks-code {
				color: var(--dsw-alias-label-secondary);
				font: var(--dsw-font-markdown-code);
				font-size: 11px;
				line-height: 17px;
				overflow-wrap: anywhere;
			}
			.wca-hooks-badge {
				padding: 1px 7px;
				border-radius: 999px;
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
				font-size: 11px;
				line-height: 17px;
				white-space: nowrap;
			}
			.wca-hooks-explanation {
				margin: 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 13px;
				line-height: 20px;
				overflow-wrap: anywhere;
			}
			.wca-hooks-explanation .wca-md,
			.wca-hooks-row-desc .wca-md,
			.wca-hooks-meta dd .wca-md { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
			.wca-hooks-explanation .wca-md p,
			.wca-hooks-row-desc .wca-md p,
			.wca-hooks-meta dd .wca-md p { margin: 0; }
			.wca-hooks-meta {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
				gap: 8px 20px;
				margin: 0;
			}
			.wca-hooks-meta div { min-width: 0; }
			.wca-hooks-meta dt {
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				font-weight: 600;
			}
			.wca-hooks-meta dd {
				margin: 1px 0 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-hooks-payload summary,
			.wca-hooks-script summary {
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
				cursor: pointer;
			}
			.wca-hooks-payload ul { margin: 6px 0 0; padding-inline-start: 18px; }
			.wca-hooks-payload li {
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-hooks-rows { display: flex; flex-direction: column; gap: 8px; }
			.wca-hooks-row {
				display: flex;
				flex-direction: column;
				gap: 6px;
				min-width: 0;
				padding: 10px 12px;
				border: .5px solid var(--dsw-alias-border-l3);
				border-radius: 12px;
				background: var(--dsw-alias-bg-base);
			}
			.wca-hooks-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
			.wca-hooks-row-name { font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
			.wca-hooks-row-desc,
			.wca-hooks-row-note {
				margin: 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
				overflow-wrap: anywhere;
			}
			.wca-hooks-row-note { color: var(--dsw-alias-label-tertiary); }
			.wca-hooks-rename { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.wca-hooks-rename-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
			.wca-hooks-input {
				box-sizing: border-box;
				width: min(320px, 100%);
				height: 30px;
				padding: 0 8px;
				border: .5px solid var(--dsw-alias-border-l3);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
			}
			.wca-hooks-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
			.wca-hooks-runs { display: flex; flex-direction: column; gap: 6px; }
			.wca-hooks-run {
				display: grid;
				grid-template-columns: 150px 150px minmax(0, 1fr) 84px auto;
				gap: 4px 10px;
				align-items: baseline;
				padding: 6px 8px;
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-hooks-run[data-status="ok"] .wca-hooks-run-status { color: var(--dsw-alias-state-success-primary); }
			.wca-hooks-run[data-status="failed"] .wca-hooks-run-status { color: var(--dsw-alias-state-error-primary); }
			.wca-hooks-run[data-status="timeout"] .wca-hooks-run-status { color: var(--dsw-alias-state-warn-primary); }
			.wca-hooks-run-status { font-weight: 600; }
			.wca-hooks-run-time,
			.wca-hooks-run-event,
			.wca-hooks-run-duration {
				color: var(--dsw-alias-label-tertiary);
				font-variant-numeric: tabular-nums;
			}
			.wca-hooks-run-name { min-width: 0; overflow-wrap: anywhere; }
			.wca-hooks-run-duration { text-align: end; }
			.wca-hooks-stderr {
				grid-column: 1 / -1;
				margin: 4px 0 0;
				padding: 8px;
				max-height: 140px;
				overflow: auto;
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-secondary);
				font: var(--dsw-font-markdown-code);
				font-size: 11px;
				line-height: 17px;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}
			.wca-hooks-script pre {
				margin: 6px 0 0;
				padding: 8px;
				max-height: 180px;
				overflow: auto;
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
				font: var(--dsw-font-markdown-code);
				font-size: 11px;
				line-height: 17px;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}
			.wca-hooks-add { display: flex; flex-direction: column; gap: 8px; padding-top: 2px; }
			.wca-hooks-prompt { display: flex; flex-direction: column; gap: 8px; }
			.wca-hooks-prompt-actions { display: flex; gap: 8px; flex-wrap: wrap; }
			.wca-hooks-prompt-text {
				margin: 0;
				padding: 12px;
				max-height: 360px;
				overflow: auto;
				border: .5px solid var(--dsw-alias-border-l3);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: var(--dsw-font-markdown-code);
				font-size: 12px;
				line-height: 18px;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
				user-select: text;
			}
			@media (max-width: 760px) {
				.wca-hooks-run { grid-template-columns: minmax(0, 1fr) auto; }
				.wca-hooks-run-event,
				.wca-hooks-run-name { grid-column: 1 / -1; }
			}

			/* Fluid: token-only material and physical motion. This is the only block allowed to animate.
			   The page under a card is an opaque token surface, so a backdrop blur would blur nothing;
			   the material instead comes from a visible tinted wash, a tinted hairline border and a
			   two-layer shadow that reads as elevation on that surface. */
			.wca-page[data-wca-style="fluid"] {
				--wca-ease-enter: cubic-bezier(.22, 1, .36, 1);
				--wca-ease-exit: cubic-bezier(.4, 0, .2, 1);
				--wca-shadow-contact: 0 1px 2px color-mix(in oklab, var(--dsw-alias-label-primary) 10%, transparent);
				--wca-shadow-ambient: 0 16px 34px -18px color-mix(in oklab, var(--dsw-alias-label-primary) 38%, transparent);
				--wca-shadow-hover: 0 22px 44px -18px color-mix(in oklab, var(--dsw-alias-label-primary) 54%, transparent);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter,
			.wca-page[data-wca-style="fluid"] .wca-settings-group,
			.wca-page[data-wca-style="fluid"] .wca-hooks-event {
				/* PR and SPV letters set --wca-tint; settings groups and any other surface fall back to
				   the info family, so every fluid card carries a wash instead of matching the page. */
				--wca-wash: var(--wca-tint, var(--dsw-alias-state-business-primary));
				border-color: color-mix(in oklab, var(--wca-wash) 24%, var(--dsw-alias-border-l2));
				background:
					linear-gradient(
						165deg,
						color-mix(in oklab, var(--wca-wash) 18%, var(--dsw-alias-bg-layer-1)),
						color-mix(in oklab, var(--wca-wash) 5%, var(--dsw-alias-bg-layer-1)) 52%,
						var(--dsw-alias-bg-layer-1)
					);
				box-shadow: var(--wca-shadow-contact), var(--wca-shadow-ambient);
				transition:
					box-shadow 220ms var(--wca-ease-enter),
					transform 220ms var(--wca-ease-enter),
					border-color 220ms var(--wca-ease-exit);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter[data-draft="true"] {
				border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2));
			}
			.wca-page[data-wca-style="fluid"] .wca-letter:hover,
			.wca-page[data-wca-style="fluid"] .wca-settings-group:hover,
			.wca-page[data-wca-style="fluid"] .wca-hooks-event:hover {
				border-color: color-mix(in oklab, var(--wca-wash) 38%, var(--dsw-alias-border-l2));
				box-shadow: var(--wca-shadow-contact), var(--wca-shadow-hover);
				transform: translateY(-2px);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter:active {
				box-shadow: var(--wca-shadow-contact);
				transform: translateY(0) scale(.998);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter::before {
				transition: background-color 220ms var(--wca-ease-exit);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter[data-status="approved"]:not(:hover):not(:active) { transform: translateY(1px); }
			.wca-page[data-wca-style="fluid"] .wca-status-pill[data-wipe="true"]::before { animation: wca-wipe 200ms var(--wca-ease-enter); }
			.wca-page[data-wca-style="fluid"] .wca-chevron,
			.wca-page[data-wca-style="fluid"] .wca-switch-track,
			.wca-page[data-wca-style="fluid"] .wca-switch-track::after {
				transition:
					transform 180ms var(--wca-ease-enter),
					background-color 180ms var(--wca-ease-exit);
			}
			.wca-page[data-wca-style="fluid"] .wca-btn,
			.wca-page[data-wca-style="fluid"] .wca-segment,
			.wca-page[data-wca-style="fluid"] .wca-tab,
			.wca-page[data-wca-style="fluid"] .wca-disclosure-toggle {
				transition:
					transform 120ms var(--wca-ease-enter),
					background-color 160ms var(--wca-ease-exit),
					color 160ms var(--wca-ease-exit),
					box-shadow 120ms var(--wca-ease-enter);
			}
			.wca-page[data-wca-style="fluid"] .wca-btn:active:not(:disabled),
			.wca-page[data-wca-style="fluid"] .wca-segment:active,
			.wca-page[data-wca-style="fluid"] .wca-tab:active {
				transform: scale(.985);
				box-shadow: none;
			}
			.wca-page[data-wca-style="fluid"] .wca-disclosure-body {
				transition:
					grid-template-rows 240ms var(--wca-ease-enter),
					opacity 240ms var(--wca-ease-exit),
					visibility 0s 240ms;
			}
			.wca-page[data-wca-style="fluid"] .wca-disclosure-body[data-open="true"] {
				transition:
					grid-template-rows 240ms var(--wca-ease-enter),
					opacity 240ms var(--wca-ease-exit),
					visibility 0s 0s;
			}
			.wca-page[data-wca-style="fluid"] .wca-disclosure-inner {
				transition: opacity 160ms var(--wca-ease-enter) 40ms;
			}
			/* Every letter animates in once on mount and on a browser refresh; the 30ms stagger comes
			   from the item's position, not from "this id is new", so an ordinary load moves too.
			   The marker is cleared on animation end so a later status re-render cannot replay it. */
			.wca-page[data-wca-style="fluid"] .wca-letter[data-arriving="true"] {
				animation: wca-arrive 280ms var(--wca-ease-enter) backwards;
				animation-delay: calc(var(--wca-new-index, 0) * 30ms);
			}
			.wca-page[data-wca-style="fluid"] .wca-letter[data-settling="true"] { animation: wca-settle 220ms var(--wca-ease-enter); }
			@keyframes wca-arrive {
				from { opacity: 0; transform: translateY(8px); }
				to { opacity: 1; transform: translateY(0); }
			}
			@keyframes wca-wipe {
				from { clip-path: inset(0 0 0 100%); }
				to { clip-path: inset(0 0 0 0); }
			}
			@keyframes wca-settle {
				0% { transform: translateY(0); }
				100% { transform: translateY(1px); }
			}
			.wca-page[data-wca-style="minimal"] .wca-letter,
			.wca-page[data-wca-style="minimal"] .wca-settings-group,
			.wca-page[data-wca-style="minimal"] .wca-hooks-event {
				background: var(--dsw-alias-bg-layer-1);
				box-shadow: none;
				animation: none;
			}
			/* Settings rows collapse where the wider frame is still close to the old 960px comfortable
			   width; going lower would squeeze the 240px control column on tablets. The removed day
			   rail no longer needs its own breakpoint. */
			@media (max-width: 1100px) {
				.wca-setting { grid-template-columns: minmax(0, 1fr); gap: 6px; }
				.wca-setting-side { width: 100%; }
			}
			@media (prefers-reduced-motion: reduce) {
				.wca-page,
				.wca-page *,
				.wca-page *::before,
				.wca-page *::after {
					animation: none !important;
					transition: none !important;
					scroll-behavior: auto !important;
				}
				.wca-page[data-wca-style="fluid"] .wca-letter:hover,
				.wca-page[data-wca-style="fluid"] .wca-settings-group:hover,
				.wca-page[data-wca-style="fluid"] .wca-hooks-event:hover { transform: none; }
			}
		`;
		//#endregion

		//#region style + draft helpers

		/** localStorage keys: one map keyed by item id, one envelope for the settings form. */
		const INBOX_DRAFT_KEY = "wheelchair-agent:inbox-drafts:v1";
		const SETTINGS_DRAFT_KEY = "wheelchair-agent:settings-drafts:v1";
		const DRAFT_MODES = new Set(["approve", "issue"]);
		/** The settings draft survives section switches even when localStorage is denied. */
		let settingsDraftMemory = null;
		/** How often the panel re-reads the inbox while it is open (the host poller runs separately). */
		const INBOX_REFRESH_MS = 60000;

		/**
		* The stored style with a safe default. Unknown values are passed through so a third style added
		* later only needs its own [data-wca-style] CSS block; the base layout is the fallback.
		*/
		function styleOf(snapshot) {
			const raw = snapshot?.effective?.["webui.style"] ?? snapshot?.values?.["webui.style"];
			const value = String(raw ?? "").trim();
			return value === "" ? "fluid" : value;
		}

		/** A stable draft key: the item id, exactly as the inbox list keys its rows. */
		function itemDraftKey(item) {
			return String(item?.id ?? item?.pr ?? "");
		}

		/**
		* The arrival indexes for one refresh: only ids absent from the previous response animate, and the
		* index gives each one its 30ms stagger. A whole-list refresh therefore never replays the animation.
		*/
		function freshItemIndices(previousIds, list) {
			const next = new Map();
			if (previousIds === null) return next;
			let index = 0;
			for (const item of list) {
				const id = itemDraftKey(item);
				if (!previousIds.has(id)) next.set(id, index++);
			}
			return next;
		}

		/** One review draft in the only shape the form understands; anything else is discarded. */
		function sanitizeInboxDraft(draft) {
			if (draft === null || typeof draft !== "object" || Array.isArray(draft)) return undefined;
			const mode = String(draft.mode ?? "");
			if (!DRAFT_MODES.has(mode)) return undefined;
			return { mode, text: typeof draft.text === "string" ? draft.text : "" };
		}

		/**
		* A tiny JSON map over localStorage, keyed by item id, with an in-memory fallback when storage is
		* unavailable (privacy mode, a sandboxed frame). Dependency-injected storage keeps it testable.
		*/
		function createDraftStore(storage, key) {
			let memory = null;
			const readAll = () => {
				let raw;
				try {
					raw = storage === null || storage === undefined ? memory : storage.getItem(key);
				} catch {
					raw = null;
				}
				if (typeof raw !== "string" || raw === "") return {};
				try {
					const parsed = JSON.parse(raw);
					return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
				} catch {
					return {};
				}
			};
			const writeAll = (all) => {
				const text = JSON.stringify(all);
				try {
					if (storage === null || storage === undefined) memory = text;
					else storage.setItem(key, text);
				} catch {
					memory = text;
				}
			};
			const store = {
				all() {
					return readAll();
				},
				get(id) {
					return sanitizeInboxDraft(readAll()[itemDraftKey({ id })]);
				},
				set(id, draft) {
					const clean = sanitizeInboxDraft(draft);
					const all = readAll();
					if (clean === undefined) delete all[itemDraftKey({ id })];
					else all[itemDraftKey({ id })] = clean;
					writeAll(all);
					return clean;
				},
				clear(id) {
					const all = readAll();
					delete all[itemDraftKey({ id })];
					writeAll(all);
				},
			};
			return store;
		}

		/** The browser's localStorage, or null when the frame denies it. */
		function browserStorage() {
			try {
				return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
			} catch {
				return null;
			}
		}

		/**
		* Restore the settings form after leaving the section. A stored envelope belongs to the revision it
		* was drafted against: when the server moved on, the stale draft is dropped instead of being replayed.
		* Only keys/templates that still exist survive.
		*/
		function restoreSettingsDrafts(snapshot, stored) {
			const empty = { valueDrafts: {}, templateDrafts: {}, resets: new Set() };
			if (snapshot === null || typeof snapshot !== "object") return empty;
			if (stored === null || typeof stored !== "object") return empty;
			if (Number(stored.revision) !== Number(snapshot.revision)) return empty;
			const rows = new Set((Array.isArray(snapshot.rows) ? snapshot.rows : []).map((row) => String(row.key)));
			const templates = new Set(Object.keys(snapshot.templates ?? {}));
			const valueDrafts = {};
			for (const [key, value] of Object.entries(stored.valueDrafts ?? {})) {
				if (rows.has(key) && typeof value === "string") valueDrafts[key] = value;
			}
			const templateDrafts = {};
			for (const [id, draft] of Object.entries(stored.templateDrafts ?? {})) {
				if (!templates.has(id) || draft === null || typeof draft !== "object") continue;
				const active = typeof draft.active === "string" ? draft.active : "default";
				const presets = {};
				for (const [name, text] of Object.entries(draft.presets ?? {})) {
					if (typeof text === "string" && name !== "default" && name !== "") presets[name] = text;
				}
				templateDrafts[id] = { active, presets };
			}
			const resets = new Set();
			for (const key of Array.isArray(stored.resets) ? stored.resets : []) {
				if (rows.has(String(key))) resets.add(String(key));
			}
			return { valueDrafts, templateDrafts, resets };
		}

		/** Count the layers actually in effect, for the one quiet line above the groups. */
		function sourceSummary(snapshot) {
			const counts = { file: 0, config: 0, env: 0, default: 0 };
			for (const row of Array.isArray(snapshot?.rows) ? snapshot.rows : []) {
				const source = String(row.source ?? "default");
				if (Object.hasOwn(counts, source)) counts[source] += 1;
			}
			return counts;
		}

		//#region data + components

		/** Format one timestamp for the review list. */
		function formatTime(value) {
			const date = new Date(String(value ?? ""));
			if (Number.isNaN(date.getTime())) return String(value ?? "");
			return date.toLocaleString(undefined, { hour12: false });
		}

		/**
		* One letter's own timestamp. It reads the same field `groupByDay` sorts by and includes the
		* time of day because the day heading is no longer painted as a rail label. `title` keeps the
		* complete value that the compact label trims.
		* @param item - inbox item.
		* @returns `{ label, title, datetime }`; `datetime` is undefined for an unparseable value.
		*/
		function letterTimeOf(item) {
			const value = item?.at ?? item?.createdAt ?? item?.updatedAt;
			const date = new Date(String(value ?? ""));
			if (Number.isNaN(date.getTime())) {
				const raw = String(value ?? "");
				return { label: raw, title: raw, datetime: undefined };
			}
			return {
				label: date.toLocaleString(undefined, {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false
				}),
				title: date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }),
				datetime: date.toISOString()
			};
		}

		/**
		* Whether one `animationend` event is this card's own arrival. The article also runs the
		* approve settle and can host child animations; neither may clear the arrival marker.
		*/
		function clearsArrival(event) {
			return event?.target === event?.currentTarget && event?.animationName === "wca-arrive";
		}

		/**
		* Normalize one review kind for display. Old records used `question`/`fix`; both mean
		* "this PR has a problem". The disk record is never rewritten — only the view normalizes.
		* @param review - stored review entry.
		* @returns `"approve"` or `"issue"`.
		*/
		function reviewKindOf(review) {
			return String(review?.kind ?? "").trim().toLowerCase() === "approve" ? "approve" : "issue";
		}

		/**
		* Derive an item's review status from its latest review entry; there is no stored status
		* field, so the log stays the single source of truth. GitHub's merge state is deliberately
		* NOT consulted: merging is not reviewing, so a merged PR with no review is still pending.
		* @param item - inbox item.
		* @returns `"pending"`, `"approved"` or `"issue"`.
		*/
		function statusOf(item) {
			const reviews = Array.isArray(item?.review) ? item.review : [];
			if (reviews.length === 0) return "pending";
			return reviewKindOf(reviews[reviews.length - 1]) === "approve" ? "approved" : "issue";
		}

		/**
		* Normalize the item's GitHub state for the separate PR-state chip (open / merged / closed).
		* This is display context only; it never feeds statusOf().
		* @param item - inbox item.
		* @returns the lower-case state, or "" when the item carries none.
		*/
		function stateOf(item) {
			return String(item?.state ?? "").trim().toLowerCase();
		}

		/** Map a derived status to a Tag tone. */
		function statusTone(status) {
			switch (status) {
				case "approved":
					return "success";
				case "issue":
					return "danger";
				default:
					return "pending";
			}
		}

		/** The derived status pill. The status change wipes its fill in; the label never moves. */
		function StatusBadge(props) {
			return jsx(
				"span",
				{
					className: "wca-status-pill",
					"data-tone": statusTone(props.status),
					"data-wipe": props.wipe === true ? "true" : "false",
					children: jsx("span", { children: props.t(`status.${props.status}`) }, "label")
				},
				"status"
			);
		}

		/** Map an item's GitHub state to a neutral Tag tone (context only, not review status). */
		function stateTone(state) {
			switch (String(state ?? "").toUpperCase()) {
				case "OPEN":
					return "info";
				case "MERGED":
					return "success";
				case "CLOSED":
					return "danger";
				default:
					return "neutral";
			}
		}

		/** The localized label of one PR state, falling back to the raw state. */
		function stateLabel(t, state) {
			if (state === "") return "";
			const key = `state.${state.toLowerCase()}`;
			const label = t(key);
			return label === key ? state : label;
		}

		/** Render one review entry (kind badge, time, and the issue text when present). */
		function ReviewRow(props) {
			const review = props.review;
			const kind = reviewKindOf(review);
			const text = String(review?.text ?? "");
			return jsxs(
				"div",
				{
					className: "wca-review",
					children: [
						jsxs(
							"div",
							{
								className: "wca-review-head",
								children: [
									jsx(
										"span",
										{
											className: "wca-tag",
											"data-tone": kind === "approve" ? "success" : "danger",
											children: props.t(kind === "approve" ? "status.approved" : "status.issue")
										},
										"kind"
									),
									jsx("span", { className: "wca-review-time", children: formatTime(review?.at) }, "time")
								]
							},
							"head"
						),
						text === "" ? null : jsx("p", { className: "wca-review-text", children: text }, "text")
					]
				},
				String(review?.at ?? "") + kind
			);
		}

		/** The letter type of an item; legacy records without `kind` are PRs. */
		function kindOfItem(item) {
			return item?.kind === "spv_message" ? "spv_message" : "pr";
		}

		/**
		* The elemental letter glyph: a branch for a PR, a quoted dot for an SPV decision. Inline SVG and
		* currentColor only, so it inherits the token colour in both themes.
		*/
		function KindGlyph(props) {
			const pr = props.kind !== "spv_message";
			return jsx(
				"span",
				{
					className: "wca-letter-glyph",
					"aria-hidden": "true",
					children: jsx(
						"svg",
						{
							width: 12,
							height: 12,
							viewBox: "0 0 12 12",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 1.4,
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: pr
								? [
									jsx("circle", { cx: 3, cy: 3, r: 1.4 }, "a"),
									jsx("circle", { cx: 3, cy: 9, r: 1.4 }, "b"),
									jsx("circle", { cx: 9, cy: 3, r: 1.4 }, "c"),
									jsx("path", { d: "M3 4.4v4.2M9 4.4v1.2c0 1.4-1.2 2.4-2.6 2.4H4.4" }, "path")
								]
								: [
									jsx("path", { d: "M2.5 3.2h7v5.2H6.2L4 10.2v-1.8H2.5z" }, "bubble"),
									jsx("circle", { cx: 4.6, cy: 5.8, r: .6, fill: "currentColor", stroke: "none" }, "dot-a"),
									jsx("circle", { cx: 7.4, cy: 5.8, r: .6, fill: "currentColor", stroke: "none" }, "dot-b")
								]
						},
						"glyph"
					)
				},
				"glyph"
			);
		}

		/**
		* The two review actions. The half-written comment lives in the inbox's draft map (keyed by item
		* id), not in this component, so switching a filter or another section cannot discard it. "Approve"
		* opens an optional comment box recorded only; "Flag issue" requires a comment.
		*/
		function ReviewForm(props) {
			const t = props.t;
			const kind = props.kind;
			const draft = props.draft;
			const mode = draft === undefined ? null : draft.mode;
			const text = draft === undefined ? "" : draft.text;
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const mounted = react.useRef(true);
			const textarea = react.useRef(null);
			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			react.useEffect(() => {
				if (mode !== null && textarea.current !== null) textarea.current.focus();
			}, [mode]);
			const openMode = (next) => {
				if (mode === next) return;
				setError("");
				props.onDraft(next, "");
			};
			const submit = async (reviewKind) => {
				const value = text.trim();
				if (reviewKind === "issue" && value === "") {
					setError(t("form.issueEmpty"));
					if (textarea.current !== null) textarea.current.focus();
					return;
				}
				setBusy(true);
				setError("");
				try {
					const response = await fetch(REVIEW_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: props.item.id, kind: reviewKind, text: value })
					});
					const payload = await response.json().catch(() => ({}));
					if (!response.ok || payload.ok !== true) {
						throw new Error(payload?.message ?? `HTTP ${response.status}`);
					}
					props.onSubmitted(reviewKind);
					if (!mounted.current) return;
				} catch (failure) {
					if (!mounted.current) return;
					setError(t("form.failed", { message: failure instanceof Error ? failure.message : String(failure) }));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const hint =
				mode === "approve"
					? t("form.passHint")
					: mode === "issue"
						? t(`form.issueHint.${kind}`)
						: "";
			const placeholder =
				mode === "approve"
					? t("form.passPlaceholder")
					: mode === "issue"
						? t(`form.issuePlaceholder.${kind}`)
						: "";
			return jsxs(
				"div",
				{
					className: "wca-form",
					children: [
						jsxs(
							"div",
							{
								className: "wca-actions",
								children: [
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: busy || props.status === "approved",
											"aria-expanded": mode === "approve",
											onClick: () => openMode("approve"),
											children: t("form.pass")
										},
										"approve"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "primary",
											disabled: busy,
											"aria-expanded": mode === "issue",
											onClick: () => openMode("issue"),
											children: t("form.issue")
										},
										"issue"
									)
								]
							},
							"actions"
						),
						mode === null
							? null
							: jsxs(
									"div",
									{
										className: "wca-issue-box",
										children: [
											jsx("p", { className: "wca-hint", children: hint }, "hint"),
											jsx("textarea", {
												ref: textarea,
												className: "wca-comment",
												rows: 3,
												placeholder,
												"aria-label": hint === "" ? placeholder : hint,
												value: text,
												disabled: busy,
												onChange: (event) => {
													props.onDraft(mode, event.target.value);
													if (error !== "") setError("");
												}
											}),
											jsxs(
												"div",
												{
													className: "wca-actions",
													children: [
														jsx(
															"button",
															{
																type: "button",
																className: "wca-btn",
																"data-variant": "primary",
																disabled: busy,
																onClick: () => submit(mode),
																children: busy
																	? t("form.inflight")
																	: mode === "approve"
																		? t("form.approveSubmit")
																		: t("form.submit")
															},
															"submit"
														),
														jsx(
															"button",
															{
																type: "button",
																className: "wca-btn",
																"data-variant": "outline",
																disabled: busy,
																onClick: () => {
																	props.onDraft(null, "");
																	setError("");
																},
																children: t("form.cancel")
															},
															"cancel"
														)
													]
												},
												"box-actions"
											)
										]
									},
									"box"
							  ),
						jsx("p", { className: "wca-form-error", role: "alert", children: error }, "error")
					]
				},
				"form"
			);
		}

		/**
		* The collapsed-by-default body disclosure. The body stays mounted so the height and opacity can be
		* transitioned in 240ms (the content fades in 40ms behind the container) instead of snapping open.
		*/
		function BodyDisclosure(props) {
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			const hasBody = typeof props.text === "string" && props.text.trim() !== "";
			const labelKey = props.labelKey ?? "card.body";
			const emptyKey = props.emptyKey ?? "card.bodyEmpty";
			return jsxs(
				"div",
				{
					className: "wca-disclosure",
					children: [
						jsxs(
							"button",
							{
								type: "button",
								className: "wca-disclosure-toggle",
								"aria-expanded": open,
								onClick: () => setOpen((value) => !value),
								children: [jsx(ChevronIcon, { open }, "chevron"), jsx("span", { children: t(labelKey) }, "label")]
							},
							"toggle"
						),
						jsx(
							"div",
							{
								className: "wca-disclosure-body",
								"data-open": open ? "true" : "false",
								"aria-hidden": open ? "false" : "true",
								children: jsx(
									"div",
									{
										className: "wca-disclosure-inner",
										children: jsx(Markdown, { text: hasBody ? props.text : t(emptyKey) })
									},
									"inner"
								)
							},
							"body"
						)
					]
				},
				"disclosure"
			);
		}

		/**
		* One letter card: the elemental letter (status spine, one inset seam), a two-column-ish header,
		* the body disclosures, and the review actions pinned to the card's bottom edge. PRs and
		* `spv_message` differ only by radius, inset, spine width, glyph and tint family.
		*/
		function InboxItem(props) {
			const item = props.item;
			const t = props.t;
			const kind = kindOfItem(item);
			const isMessage = kind === "spv_message";
			const reviews = Array.isArray(item.review) ? item.review : [];
			const status = statusOf(item);
			const prState = isMessage ? "" : stateOf(item);
			const href = isMessage ? undefined : safeWebHref(item.url);
			const additions = Number.isFinite(Number(item.additions)) ? Number(item.additions) : 0;
			const deletions = Number.isFinite(Number(item.deletions)) ? Number(item.deletions) : 0;
			const files = Number.isFinite(Number(item.changedFiles)) ? Number(item.changedFiles) : 0;
			const draft = props.draft;
			const stamp = letterTimeOf(item);
			const stampLabel = stamp.label === "" ? t("day.unknown") : stamp.label;
			// The entry animation runs once per mounted card. Clearing the marker when its own
			// animation ends keeps a later settle/wipe re-render from replaying the arrival. A
			// timer covers minimal and reduced-motion, where no animation event ever fires.
			const [arriving, setArriving] = react.useState(true);
			react.useEffect(() => {
				if (!arriving) return undefined;
				const timer = setTimeout(() => setArriving(false), 900);
				return () => clearTimeout(timer);
			}, [arriving]);
			const [wipe, setWipe] = react.useState(false);
			const [settling, setSettling] = react.useState(false);
			const lastStatus = react.useRef(status);
			react.useEffect(() => {
				if (lastStatus.current === status) return;
				lastStatus.current = status;
				setWipe(true);
				setSettling(status === "approved");
				const timer = setTimeout(() => {
					setWipe(false);
					setSettling(false);
				}, 280);
				return () => clearTimeout(timer);
			}, [status]);
			const origin = isMessage
				? jsx(
						"span",
						{ className: "wca-repo", children: t("card.thread", { thread: String(item.thread || "main") }) },
						"thread"
				  )
				: jsxs(
						"span",
						{
							className: "wca-repo",
							children: [jsx("strong", { children: String(item.repo ?? "") }), ` #${String(item.pr ?? "")}`]
						},
						"repo"
				  );
			return jsxs(
				"article",
				{
					className: "wca-letter",
					"data-kind": kind,
					"data-status": status,
					"data-draft": draft === undefined ? "false" : "true",
					"data-new": props.isNew === true ? "true" : undefined,
					"data-arriving": arriving ? "true" : undefined,
					"data-settling": settling ? "true" : undefined,
					onAnimationEnd: (event) => {
						if (clearsArrival(event)) setArriving(false);
					},
					style: { "--wca-new-index": String(props.arrivalIndex ?? 0) },
					children: [
						jsxs(
							"div",
							{
								className: "wca-letter-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-letter-origin",
											children: [
												jsx(KindGlyph, { kind }, "glyph"),
												jsx(
													"span",
													{ className: "wca-kind", children: t(isMessage ? "kind.spv_message" : "kind.pr") },
													"kind"
												),
												origin,
												prState === ""
													? null
													: jsx(
															"span",
															{
																className: "wca-tag wca-state-tag",
																"data-tone": stateTone(prState),
																children: stateLabel(t, prState)
															},
															"pr-state"
														  ),
												draft === undefined
													? null
													: jsx(
															"span",
															{
																className: "wca-tag",
																"data-tone": "warning",
																title: t("inbox.draftHint"),
																children: t("inbox.draftTag")
															},
															"draft"
													  )
											]
										},
										"origin"
									),
									jsx(StatusBadge, { status, wipe, t }, "status")
								]
							},
							"head"
						),
						jsx("h3", { className: "wca-letter-title", children: String(item.title ?? "") || t("card.untitled") }, "title"),
						jsxs(
							"p",
							{
								className: "wca-meta",
								children: [
									isMessage
										? null
										: jsxs(
												"span",
												{
													className: "wca-meta-diff",
													children: [
														jsx("span", { className: "wca-diff wca-added", children: `+${additions}` }, "add"),
														" ",
														jsx("span", { className: "wca-diff wca-removed", children: `−${deletions}` }, "del"),
														" ",
														jsx("span", { children: t("card.files", { count: files }) }, "files")
													]
												},
												"diff"
										  ),
									jsx(
										"time",
										{
											className: "wca-letter-time",
											dateTime: stamp.datetime,
											title: stamp.title === "" ? stampLabel : stamp.title,
											children: stampLabel
										},
										"time"
									)
								]
							},
							"meta"
						),
						jsxs(
							"div",
							{
								className: "wca-letter-body",
								children: [
									jsx(
										BodyDisclosure,
										{
											text: item.body,
											t,
											labelKey: isMessage ? "card.letter" : "card.body",
											emptyKey: isMessage ? "card.letterEmpty" : "card.bodyEmpty"
										},
										"body"
									),
									reviews.length === 0
										? null
										: jsxs(
												"div",
												{
													className: "wca-reviews",
													children: [
														jsx(
															"div",
															{ className: "wca-reviews-title", children: t("card.reviews", { count: reviews.length }) },
															"title"
														),
														reviews.map((review, index) => jsx(ReviewRow, { review, t }, `review-${index}`))
													]
												},
												"reviews"
											  )
								]
							},
							"body-wrap"
						),
						jsxs(
							"div",
							{
								className: "wca-letter-foot",
								children: [
									jsx(
										ReviewForm,
										{
											item,
											t,
											kind,
											status,
											draft,
											onDraft: props.onDraft,
											onSubmitted: props.onSubmitted
										},
										"form"
									),
									href === undefined
										? null
										: jsx(
												"a",
												{
													className: "wca-open",
													href,
													target: "_blank",
													rel: "noopener noreferrer",
													children: t("card.open")
												},
												"open"
											  )
								]
							},
							"foot"
						)
					]
				},
				String(item.id ?? item.pr ?? "")
			);
		}

		/** The four inbox filters; the default view is pending. */
		const FILTERS = [
			{ id: "all", labelKey: "filter.all" },
			{ id: "pending", labelKey: "filter.pending" },
			{ id: "issue", labelKey: "filter.issue" },
			{ id: "approved", labelKey: "filter.approved" }
		];

		/** ISO start/end of one `<input type="date">` value, in the operator's local time. */
		function dayStartIso(value) {
			const date = new Date(`${String(value)}T00:00:00`);
			return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
		}
		function dayEndIso(value) {
			const date = new Date(`${String(value)}T23:59:59.999`);
			return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
		}

		/**
		* The items query for the current filter state. Built on every load (not memoized) so
		* "last 24 hours" / "last 7 days" slide when the operator presses Refresh instead of
		* freezing the window at the moment the option was selected.
		*/
		function itemsQuery(filters) {
			const params = new URLSearchParams();
			if (filters.kind !== "all") params.set("kind", filters.kind);
			if (filters.repo !== "all") params.set("repo", filters.repo);
			if (filters.time === "day" || filters.time === "week") {
				const hours = filters.time === "day" ? 24 : 24 * 7;
				params.set("since", new Date(Date.now() - hours * 60 * 60 * 1000).toISOString());
			} else if (filters.time === "custom") {
				const from = filters.since === "" ? undefined : dayStartIso(filters.since);
				const to = filters.until === "" ? undefined : dayEndIso(filters.until);
				if (from !== undefined) params.set("since", from);
				if (to !== undefined) params.set("until", to);
			}
			const encoded = params.toString();
			return encoded === "" ? "" : `?${encoded}`;
		}

		/** Local calendar day of an item, stable across a timezone change during the session. */
		function dayKeyOf(item) {
			const value = item?.at ?? item?.createdAt ?? item?.updatedAt;
			const date = new Date(String(value ?? ""));
			if (Number.isNaN(date.getTime())) return "unknown";
			const pad = (number) => String(number).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		}

		/** The uppercase date label of one day group; the CSS uppercases it. */
		function dayLabelOf(key, t) {
			if (key === "unknown") return t("day.unknown");
			const date = new Date(`${key}T00:00:00`);
			if (Number.isNaN(date.getTime())) return key;
			return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
		}

		/** Group the visible letters by local day, keeping the server's newest-first order. */
		function groupByDay(items) {
			const groups = [];
			const index = new Map();
			for (const item of items) {
				const key = dayKeyOf(item);
				let group = index.get(key);
				if (group === undefined) {
					group = { key, items: [] };
					index.set(key, group);
					groups.push(group);
				}
				group.items.push(item);
			}
			return groups;
		}

		/**
		* One day's letters. The day is now only structure and an accessible name: there is no date
		* rail, sticky label or sentinel, so the cards start at the same left edge as the settings
		* groups and use the full content width. Every card carries its own timestamp.
		*/
		function DayGroup(props) {
			return jsxs(
				"section",
				{
					className: "wca-day",
					"data-day": props.day,
					"aria-label": props.label,
					children: jsx(
						"div",
						{
							className: "wca-cards",
							children: props.items.map((item, index) =>
								jsx(
									InboxItem,
									{
										item,
										t: props.t,
										draft: props.drafts[itemDraftKey(item)],
										isNew: props.newIds.get(itemDraftKey(item)) !== undefined,
										arrivalIndex: Math.min((props.startIndex ?? 0) + index, 8),
										onDraft: (mode, text) => props.onDraft(item, mode, text),
										onSubmitted: () => props.onSubmitted(item)
									},
									String(item.id ?? index)
								)
							)
						},
						"cards"
					)
				},
				props.day
			);
		}

		/**
		* The inbox feature panel: feature header and toolbar, the three server-side filters (letter type,
		* repository, time), the derived-status filter, day groups and the letter cards. Review drafts are
		* keyed by item id, persisted to localStorage, restored after switching sections, and cleared only
		* by a successful submit.
		*/
		function InboxSection(props) {
			const t = props.t;
			const feature = props.feature;
			const [items, setItems] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState("");
			const [updatedAt, setUpdatedAt] = react.useState(null);
			const [statusFilter, setStatusFilter] = react.useState("pending");
			const [kind, setKind] = react.useState("all");
			const [repo, setRepo] = react.useState("all");
			const [time, setTime] = react.useState("all");
			const [since, setSince] = react.useState("");
			const [until, setUntil] = react.useState("");
			const [repos, setRepos] = react.useState([]);
			const [newIds, setNewIds] = react.useState(() => new Map());
			const store = react.useRef(null);
			if (store.current === null) store.current = createDraftStore(browserStorage(), INBOX_DRAFT_KEY);
			const [drafts, setDrafts] = react.useState(() => {
				const clean = {};
				for (const [id, draft] of Object.entries(store.current.all())) {
					const value = sanitizeInboxDraft(draft);
					if (value !== undefined) clean[id] = value;
				}
				return clean;
			});
			const alive = react.useRef(true);
			const requestId = react.useRef(0);
			const lastIds = react.useRef(null);
			const lastQuery = react.useRef(null);
			const load = react.useCallback((silent = false) => {
				const current = ++requestId.current;
				const query = itemsQuery({ kind, repo, time, since, until });
				if (!silent) setLoading(true);
				return (async () => {
					try {
						const response = await fetch(`${ITEMS_URL}${query}`, {
							headers: { accept: "application/json" },
							cache: "no-store"
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (!alive.current || current !== requestId.current) return;
						const list = Array.isArray(payload.items) ? payload.items : [];
						const keys = new Set(list.map((item) => itemDraftKey(item)));
						if (lastQuery.current === query) setNewIds(freshItemIndices(lastIds.current, list));
						else setNewIds(new Map());
						lastQuery.current = query;
						lastIds.current = keys;
						setItems(list);
						setRepos((previous) => {
							const next = new Set(previous);
							for (const item of list) {
								if (typeof item.repo === "string" && item.repo !== "") next.add(item.repo);
							}
							return Array.from(next).sort();
						});
						setUpdatedAt(new Date());
						setError("");
					} catch (failure) {
						if (!alive.current || current !== requestId.current) return;
						setError(t("status.failed", { message: failure instanceof Error ? failure.message : String(failure) }));
					} finally {
						if (alive.current && current === requestId.current) setLoading(false);
					}
				})();
			}, [t, kind, repo, time, since, until]);
			react.useEffect(() => {
				alive.current = true;
				load();
				return () => {
					alive.current = false;
				};
			}, [load]);
			// The host poller writes new letters; this quiet refresh makes them visible without a click.
			// Back-off on a hidden tab keeps a background panel from fetching every minute for nothing.
			react.useEffect(() => {
				const timer = setInterval(() => {
					if (typeof document === "undefined" || document.visibilityState !== "hidden") load(true);
				}, INBOX_REFRESH_MS);
				return () => clearInterval(timer);
			}, [load]);
			const counts = react.useMemo(() => {
				const next = { all: 0, pending: 0, issue: 0, approved: 0 };
				for (const item of items ?? []) {
					next.all += 1;
					next[statusOf(item)] += 1;
				}
				return next;
			}, [items]);
			const visible = react.useMemo(() => {
				const list = items ?? [];
				return statusFilter === "all" ? list : list.filter((item) => statusOf(item) === statusFilter);
			}, [items, statusFilter]);
			const days = react.useMemo(() => {
				let start = 0;
				return groupByDay(visible).map((day) => {
					const startIndex = start;
					start += day.items.length;
					return { ...day, startIndex };
				});
			}, [visible]);
			const setDraft = (item, mode, text) => {
				const id = itemDraftKey(item);
				const next = { ...drafts };
				if (mode === null) {
					delete next[id];
					store.current.clear(id);
				} else {
					next[id] = { mode, text: String(text ?? "") };
					store.current.set(id, next[id]);
				}
				setDrafts(next);
			};
			const submitted = (item) => {
				const id = itemDraftKey(item);
				const next = { ...drafts };
				delete next[id];
				store.current.clear(id);
				setDrafts(next);
				load();
			};
			const status =
				error !== ""
					? error
					: loading || items === null
						? t("status.loading")
						: t("status.loaded", {
								count: items.length,
								time: updatedAt === null ? "" : updatedAt.toLocaleTimeString(undefined, { hour12: false })
							});
			const titleId = `wca-feature-${feature.id}`;
			const hasServerFilter =
				kind !== "all" ||
				repo !== "all" ||
				(time !== "all" && (time !== "custom" || since !== "" || until !== ""));
			return jsxs(
				"section",
				{
					className: "wca-feature",
					"aria-labelledby": titleId,
					children: [
						jsxs(
							"header",
							{
								className: "wca-feature-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-feature-heading",
											children: [
												jsx("h2", { id: titleId, className: "wca-feature-title", children: t(feature.titleKey) }, "title"),
												jsx("p", { className: "wca-feature-desc", children: t(feature.descriptionKey) }, "desc")
											]
										},
										"heading"
									),
									jsxs(
										"div",
										{
											className: "wca-toolbar",
											children: [
												jsx(
													"div",
													{
														className: "wca-segmented",
														role: "group",
														"aria-label": t("filter.label"),
														children: FILTERS.map((option) =>
															jsx(
																"button",
																{
																	type: "button",
																	className: "wca-segment",
																	"aria-pressed": statusFilter === option.id,
																	onClick: () => setStatusFilter(option.id),
																	children: [
																		t(option.labelKey),
																		jsx("span", { className: "wca-segment-count", children: counts[option.id] }, "count")
																	]
																},
																option.id
																)
														)
													},
													"filters"
												),
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "outline",
														disabled: loading,
														onClick: () => load(),
														children: t("refresh")
													},
													"refresh"
												)
											]
										},
										"toolbar"
									)
								]
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-feature-body",
								children: [
									jsxs(
										"div",
										{
											className: "wca-filterbar",
											role: "group",
											"aria-label": t("filter.label"),
											children: [
												jsxs(
													"label",
													{
														className: "wca-field",
														children: [
															jsx("span", { className: "wca-field-label", children: t("filter.kind") }, "label"),
															jsxs(
																"select",
																{
																	className: "wca-select",
																	value: kind,
																	onChange: (event) => {
																		const next = event.target.value;
																		setKind(next);
																		if (next === "spv_message") setRepo("all");
																	},
																	children: [
																		jsx("option", { value: "all", children: t("filter.kind.all") }, "all"),
																		jsx("option", { value: "pr", children: t("filter.kind.pr") }, "pr"),
																		jsx("option", { value: "spv_message", children: t("filter.kind.spv_message") }, "spv_message")
																	]
																},
																"kind"
																)
															]
													},
													"kind-field"
												),
												jsxs(
													"label",
													{
														className: "wca-field",
														children: [
															jsx("span", { className: "wca-field-label", children: t("filter.repo") }, "label"),
															jsxs(
																"select",
																{
																	className: "wca-select",
																	value: repo,
																	disabled: kind === "spv_message",
																	onChange: (event) => setRepo(event.target.value),
																	children: [
																		jsx("option", { value: "all", children: t("filter.repo.all") }, "all"),
																		...repos.map((value) =>
																			jsx("option", { value, children: value }, value)
																		)
																	]
																},
																"repo"
																)
															]
													},
													"repo-field"
												),
												jsxs(
													"label",
													{
														className: "wca-field",
														children: [
															jsx("span", { className: "wca-field-label", children: t("filter.time") }, "label"),
															jsxs(
																"select",
																{
																	className: "wca-select",
																	value: time,
																	onChange: (event) => setTime(event.target.value),
																	children: [
																		jsx("option", { value: "all", children: t("filter.time.all") }, "all"),
																		jsx("option", { value: "day", children: t("filter.time.day") }, "day"),
																		jsx("option", { value: "week", children: t("filter.time.week") }, "week"),
																		jsx("option", { value: "custom", children: t("filter.time.custom") }, "custom")
																	]
																},
																"time"
																)
															]
													},
													"time-field"
												),
												time === "custom"
													? jsxs(
															react.Fragment,
															{
																children: [
																	jsxs(
																		"label",
																		{
																			className: "wca-field",
																			children: [
																				jsx("span", { className: "wca-field-label", children: t("filter.time.since") }, "label"),
																				jsx("input", {
																					type: "date",
																					className: "wca-date",
																					value: since,
																					onChange: (event) => setSince(event.target.value)
																				})
																			]
																		},
																		"since"
																	),
																	jsxs(
																		"label",
																		{
																			className: "wca-field",
																			children: [
																				jsx("span", { className: "wca-field-label", children: t("filter.time.until") }, "label"),
																				jsx("input", {
																					type: "date",
																					className: "wca-date",
																					value: until,
																					onChange: (event) => setUntil(event.target.value)
																				})
																			]
																		},
																		"until"
																	)
																	]
																},
																"custom"
															  )
													: null
											]
										},
										"filterbar"
									),
									jsx(
										"p",
										{
											className: "wca-status",
											"data-tone": error !== "" ? "error" : undefined,
											role: error !== "" ? "alert" : undefined,
											children: status
										},
										"status"
									),
									items !== null && items.length === 0 && !hasServerFilter
										? jsx("p", { className: "wca-empty", children: t("inbox.empty") }, "empty")
										: null,
									items !== null && (hasServerFilter || items.length > 0) && visible.length === 0
										? jsx("p", { className: "wca-empty", children: t("filter.empty") }, "filtered-empty")
										: null,
									items !== null && visible.length > 0
										? jsx(
												"div",
												{
													className: "wca-days",
													children: days.map((day) =>
														jsx(
															DayGroup,
															{
																day: day.key,
																label: dayLabelOf(day.key, t),
																items: day.items,
																startIndex: day.startIndex,
																t,
																drafts,
																newIds,
																onDraft: setDraft,
																onSubmitted: submitted
															},
															day.key
														)
												)
												},
												"items"
											  )
										: null
								]
							},
							"body"
						)
					]
				},
				"feature"
			);
		}

		//#region settings
		//
		// The Settings section edits the store that only exists because wheelchair-agent exists. The
		// GET snapshot is the baseline; every control writes a local draft, and one Save sends only the
		// changed values, changed templates and staged resets with the snapshot's revision. The server
		// owns validation and optimistic concurrency (a stale revision is a 409 and nothing is written);
		// the client mirrors the visible constraints for fast feedback and never replaces them.

		/** Visible integer bounds, mirrored from KEY_SPECS for inline feedback; the server enforces them. */
		const SETTING_LIMITS = {
			"inbox.intervalSeconds": { min: 0, max: 2147483 },
			"injection.intervalMs": { min: 50, max: 3600000 },
			"injection.maxBodyChars": { min: 100, max: 200000 },
			"work.keep": { min: 0, max: 100000 },
			"work.keepDays": { min: 0, max: 36500 }
		};

		/** The install-target repo shape accepted by the settings store: `owner/name` or `name`. */
		const INSTALL_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

		/** Display order; the template editors form their own group between injection and work. */
		const SETTINGS_GROUPS = [
			{ id: "style", titleKey: "settings.group.style", keys: ["webui.style"] },
			{ id: "inbox", titleKey: "settings.group.inbox", keys: ["inbox.intervalSeconds"] },
			{ id: "merge", titleKey: "settings.group.merge", keys: ["merge.installRepo", "merge.autoMerge"] },
			{ id: "injection", titleKey: "settings.group.injection", keys: ["injection.intervalMs", "injection.maxBodyChars"] },
			{ id: "templates", titleKey: "settings.group.templates", templates: true },
			{ id: "work", titleKey: "settings.group.work", keys: ["work.keep", "work.keepDays", "work.sweepOnMount"] }
		];

		const SETTING_SOURCE_KEYS = {
			file: "settings.source.file",
			config: "settings.source.config",
			env: "settings.source.env",
			default: "settings.source.default"
		};

		/** The preset a template is editing: the active one, else the built-in default. */
		function activePreset(template) {
			const presets = Array.isArray(template?.presets) ? template.presets : [];
			const wanted = String(template?.active ?? "default");
			const found = presets.find((preset) => String(preset?.name ?? "") === wanted);
			if (found !== undefined) return found;
			const builtin = presets.find((preset) => preset?.builtin === true || String(preset?.name ?? "") === "default");
			if (builtin !== undefined) return builtin;
			return {
				name: "default",
				text: typeof template?.defaultText === "string" ? template.defaultText : "",
				builtin: true
			};
		}

		/** Every `{...}` token in a text, in order; validation compares it with the declared list. */
		function placeholderTokens(text) {
			const tokens = [];
			const source = typeof text === "string" ? text : "";
			const pattern = /\{([^{}]*)\}/g;
			for (const match of source.matchAll(pattern)) tokens.push(`{${match[1]}}`);
			return tokens;
		}

		/** One value as text: booleans use the localized On/Off, everything else its string form. */
		function settingText(t, value) {
			if (typeof value === "boolean") return value ? t("settings.on") : t("settings.off");
			return String(value ?? "");
		}

		/** The draft string for one row; booleans are staged as "true"/"false". */
		function settingDraft(value) {
			if (typeof value === "boolean") return value ? "true" : "false";
			return String(value ?? "");
		}

		function valueDraftsOf(snapshot) {
			const drafts = {};
			for (const row of Array.isArray(snapshot?.rows) ? snapshot.rows : []) {
				drafts[String(row.key)] = settingDraft(row.value);
			}
			return drafts;
		}

		/** Custom presets of a stored template; the built-in default is never part of the draft set. */
		function customPresetsOf(template) {
			const customs = {};
			for (const preset of Array.isArray(template?.presets) ? template.presets : []) {
				if (preset?.builtin === true) continue;
				const name = String(preset?.name ?? "");
				if (name === "" || name === "default") continue;
				customs[name] = String(preset?.text ?? "");
			}
			return customs;
		}

		function templateDraftsOf(snapshot) {
			const drafts = {};
			for (const id of Object.keys(snapshot?.templates ?? {})) {
				const template = snapshot.templates[id];
				drafts[id] = {
					active: String(template?.active ?? "default"),
					presets: customPresetsOf(template)
				};
			}
			return drafts;
		}

		/** The text of the preset the draft edits; the built-in default is immutable text. */
		function templateDraftText(template, draft) {
			if (draft === undefined || draft.active === "default") return String(template?.defaultText ?? "");
			const text = draft.presets?.[draft.active];
			return typeof text === "string" ? text : String(template?.defaultText ?? "");
		}

		/** Whether the draft's active preset differs from the stored one. */
		function templateActiveChanged(template, draft) {
			return draft.active !== String(template?.active ?? "default");
		}

		/** Whether the draft's custom preset set (names or texts) differs from the stored set. */
		function templateCustomsChanged(template, draft) {
			const before = customPresetsOf(template);
			const after = draft.presets ?? {};
			const names = new Set([...Object.keys(before), ...Object.keys(after)]);
			for (const name of names) if (before[name] !== after[name]) return true;
			return false;
		}

		function templateDraftChanged(template, draft) {
			return templateActiveChanged(template, draft) || templateCustomsChanged(template, draft);
		}

		/**
		* The PUT shape of a custom preset set: `{ name: { text } }`. `builtin` is the server's business and
		* the built-in `default` preset is always preserved server-side, so neither is sent; sending raw
		* strings here is the 400 that used to make every preset action dead.
		*/
		function presetPayload(presets) {
			const payload = {};
			for (const [name, text] of Object.entries(presets ?? {})) payload[name] = { text: String(text) };
			return payload;
		}

		/** Mirror validateTemplate(): unknown token, missing required token, then the length limit. */
		function templateTextError(template, text, t) {
			const placeholders = Array.isArray(template?.placeholders) ? template.placeholders.map(String) : [];
			const allowed = new Set(placeholders);
			const seen = new Set();
			for (const token of placeholderTokens(text)) {
				const name = token.slice(1, -1);
				if (!allowed.has(name)) {
					return t("settings.template.error.unknown", {
						token,
						allowed: placeholders.map((item) => `{${item}}`).join(", ")
					});
				}
				seen.add(name);
			}
			for (const name of Array.isArray(template?.required) ? template.required : []) {
				if (!seen.has(String(name))) return t("settings.template.error.required", { token: `{${name}}` });
			}
			const limit = Number(template?.limit);
			if (Number.isFinite(limit) && text.length > limit) {
				return t("settings.template.error.limit", { limit, count: text.length });
			}
			return "";
		}

		/** Every custom preset must pass the server's rules before the draft can be saved. */
		function templateSaveError(template, draft, t) {
			for (const [name, text] of Object.entries(draft.presets ?? {})) {
				const message = templateTextError(template, text, t);
				if (message !== "") return t("settings.template.error.preset", { name, message });
			}
			return "";
		}

		function settingDraftChanged(row, draft) {
			if (typeof row.value === "boolean") return (draft === "true") !== row.value;
			if (typeof row.value === "number") return String(draft).trim() !== String(row.value);
			return String(draft).trim() !== String(row.value ?? "");
		}

		/** The typed value of a valid draft; only called after settingDraftError() returned "". */
		function settingDraftValue(row, draft) {
			if (typeof row.value === "boolean") return draft === "true";
			if (typeof row.value === "number") return Number(String(draft).trim());
			return String(draft).trim();
		}

		function settingDraftError(row, draft, t) {
			if (typeof row.value === "boolean") return "";
			const text = String(draft ?? "").trim();
			if (typeof row.value === "number") {
				if (!/^-?\d+$/.test(text)) return t("settings.error.number");
				const value = Number(text);
				if (!Number.isFinite(value) || !Number.isInteger(value)) return t("settings.error.number");
				const limit = SETTING_LIMITS[row.key];
				if (limit !== undefined && (value < limit.min || value > limit.max)) {
					return t("settings.error.range", { min: limit.min, max: limit.max });
				}
				return "";
			}
			if (row.key === "merge.installRepo" && !INSTALL_REPO.test(text)) return t("settings.error.repo");
			return "";
		}

		/**
		* Diff the drafts against the snapshot. Only changed rows enter `values`; staged resets stay
		* apart so the same PUT can say "remove the override" without re-sending a value. A changed but
		* invalid draft produces an inline error and is not staged.
		*/
		function stagedChanges(snapshot, drafts, templateDrafts, resets, t) {
			const values = {};
			const valueErrors = {};
			for (const row of Array.isArray(snapshot?.rows) ? snapshot.rows : []) {
				const key = String(row.key);
				const draft = drafts[key];
				if (draft === undefined || resets.has(key)) continue;
				if (!settingDraftChanged(row, draft)) continue;
				const error = settingDraftError(row, draft, t);
				if (error !== "") valueErrors[key] = error;
				else values[key] = settingDraftValue(row, draft);
			}
			const templates = {};
			const templateErrors = {};
			for (const id of Object.keys(templateDrafts)) {
				const template = snapshot?.templates?.[id];
				const draft = templateDrafts[id];
				if (template === undefined || draft === undefined) continue;
				if (!templateDraftChanged(template, draft)) continue;
				const error = templateSaveError(template, draft, t);
				if (error !== "") {
					templateErrors[id] = error;
					continue;
				}
				// Send only the parts that changed: an activate-only change omits `presets`, so the server
				// keeps the stored customs; a text/edit/delete change sends the new custom set.
				const entry = {};
				if (templateActiveChanged(template, draft)) entry.active = draft.active;
				if (templateCustomsChanged(template, draft)) entry.presets = presetPayload(draft.presets);
				templates[id] = entry;
			}
			return { values, valueErrors, templates, templateErrors, reset: [...resets] };
		}

		function presetNameError(name, presets, t) {
			const value = String(name ?? "").trim();
			if (value === "") return t("settings.template.error.nameEmpty");
			if (value.length > 64) return t("settings.template.error.nameLong");
			if (/[\u0000-\u001f\u007f]/.test(value)) return t("settings.template.error.nameControl");
			if (value === "default") return t("settings.template.error.nameDefault");
			// Prototype keys are not safe dictionary entries; refuse them here so the page never stages a
			// preset the server has to reject (and so a name like __proto__ cannot mutate the draft object).
			if (value === "__proto__" || value === "prototype" || value === "constructor") {
				return t("settings.template.error.nameReserved");
			}
			if (Object.hasOwn(presets ?? {}, value)) return t("settings.template.error.nameExists");
			return "";
		}

		/** Attach a server 400 to the row/template it names; an unrecognized message stays page-level. */
		function fieldOfMessage(message) {
			const text = String(message ?? "");
			for (const group of SETTINGS_GROUPS) {
				for (const key of group.keys ?? []) if (text.includes(key)) return key;
			}
			for (const id of Object.keys({ injection: true, prIssue: true, spvObjection: true })) {
				if (text.includes(`"${id}"`) || text.includes(`'${id}'`)) return id;
			}
			return "";
		}

		/** The localized label of an enum value, falling back to the raw value. */
		function enumLabel(t, value) {
			const key = `settings.style.${value}`;
			const label = t(key);
			return label === key ? value : label;
		}

		/**
		* One two-column setting row: what it is, what changes if you touch it and the recommended value on
		* the left, the control plus effective/default and Reset on the right. The technical detail stays
		* behind a `?` so the row reads in plain language first.
		*/
		function SettingRow(props) {
			const t = props.t;
			const row = props.row;
			const overridden = Array.isArray(row.overridden) ? row.overridden : [];
			const sourceKey = SETTING_SOURCE_KEYS[row.source] ?? SETTING_SOURCE_KEYS.default;
			const layers = overridden
				.map(
					(entry) =>
						`${t(SETTING_SOURCE_KEYS[entry.source] ?? SETTING_SOURCE_KEYS.default)} = ${settingText(t, entry.value)}`
				)
				.join(" · ");
			const envNote =
				row.env !== null &&
				row.env !== undefined &&
				row.env.present === true &&
				row.source !== "env" &&
				!overridden.some((entry) => entry.source === "env")
					? t("settings.envIgnored", { name: row.env.name, value: String(row.env.value ?? "") })
					: "";
			const label = t(`setting.${row.key}.label`);
			const description = t(`setting.${row.key}.desc`);
			const changes = t(`setting.${row.key}.changes`);
			const recommended = t(`setting.${row.key}.recommended`);
			const technical = t(`setting.${row.key}.tech`);
			const options = Array.isArray(row.options) ? row.options : undefined;
			const boolean = typeof row.value === "boolean";
			const numeric = typeof row.value === "number";
			const inputId = `wca-setting-${row.key}`;
			let control;
			if (options !== undefined) {
				control = jsx(
					"select",
					{
						id: inputId,
						className: "wca-select",
						value: props.draft,
						disabled: props.saving,
						"aria-label": label,
						onChange: (event) => props.onChange(event.target.value),
						children: options.map((value) =>
							jsx("option", { value, children: enumLabel(t, value) }, value)
						)
					},
					"control"
				);
			} else if (boolean) {
				control = jsxs(
					"label",
					{
						className: "wca-switch",
						htmlFor: inputId,
						children: [
							jsx(
								"input",
								{
									id: inputId,
									type: "checkbox",
									checked: props.draft === "true",
									disabled: props.saving,
									onChange: (event) => props.onChange(event.target.checked ? "true" : "false")
								},
								"check"
							),
							jsx("span", { className: "wca-switch-track", "aria-hidden": "true" }, "track"),
							jsx("span", { children: props.draft === "true" ? t("settings.on") : t("settings.off") }, "text")
						]
					},
					"control"
				);
			} else {
				const limit = SETTING_LIMITS[row.key];
				control = jsx(
					"input",
					{
						id: inputId,
						className: "wca-input",
						type: numeric ? "number" : "text",
						inputMode: numeric ? "numeric" : undefined,
						step: numeric ? 1 : undefined,
						min: numeric && limit !== undefined ? limit.min : undefined,
						max: numeric && limit !== undefined ? limit.max : undefined,
						spellCheck: false,
						autoComplete: "off",
						value: props.draft,
						disabled: props.saving,
						"aria-label": label,
						onChange: (event) => props.onChange(event.target.value)
					},
					"control"
				);
			}
			return jsxs(
				"div",
				{
					className: "wca-setting",
					"data-setting": row.key,
					"data-draft": props.draftChanged ? "true" : "false",
					children: [
						jsxs(
							"div",
							{
								className: "wca-setting-main",
								children: [
									jsxs(
										"div",
										{
											className: "wca-setting-title",
											children: [
												jsx("span", { className: "wca-setting-label", children: label }, "label"),
												jsx("span", { className: "wca-tag", "data-tone": "neutral", children: t(sourceKey) }, "source"),
												props.draftChanged
													? jsx(
															"span",
															{
																className: "wca-tag",
																"data-tone": "warning",
																title: t("settings.draftHint"),
																children: t("settings.draftTag")
															},
															"draft"
													  )
													: null
											]
										},
										"title"
									),
									jsx("p", { className: "wca-setting-desc", children: description }, "desc"),
									jsx("p", { className: "wca-setting-effect", children: changes }, "changes"),
									jsx("p", { className: "wca-setting-recommended", children: recommended }, "recommended"),
									jsxs(
										"details",
										{
											className: "wca-tech",
											children: [
												jsx("summary", { "aria-label": t("settings.tech"), children: "?" }, "summary"),
												jsx("span", { className: "wca-tech-text", children: technical }, "text")
											]
										},
										"tech"
									)
								]
							},
							"main"
						),
						jsxs(
							"div",
							{
								className: "wca-setting-side",
								children: [
									jsx("div", { className: "wca-setting-values", children: control }, "values"),
									jsx(
										"p",
										{
											className: "wca-setting-meta",
											children: `${t("settings.effective", { value: settingText(t, row.value) })} · ${t("settings.defaultValue", {
												value: settingText(t, row.default)
											})}`
										},
										"meta"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: props.saving || row.source === "default" || props.pendingReset,
											onClick: props.onReset,
											children: t("settings.reset")
										},
										"reset"
									),
									props.pendingReset
										? jsx("p", { className: "wca-setting-note", children: t("settings.resetStaged") }, "staged")
										: null,
									overridden.length === 0
										? null
										: jsx(
												"p",
												{
													className: "wca-setting-note",
													children: t("settings.overridden", { source: t(sourceKey), layers })
												},
												"overridden"
										  ),
									envNote === "" ? null : jsx("p", { className: "wca-setting-note", children: envNote }, "env"),
									props.error === ""
										? null
										: jsx("p", { className: "wca-setting-error", role: "alert", children: props.error }, "error")
								]
							},
							"side"
						)
					]
				},
				row.key
			);
		}

		/** One template editor: preset selector, textarea, preset actions, placeholders and errors. */
		function TemplateEditor(props) {
			const t = props.t;
			const template = props.template;
			const draft = props.draft;
			const [creating, setCreating] = react.useState(false);
			const [name, setName] = react.useState("");
			const [nameError, setNameError] = react.useState("");
			const builtin = draft.active === "default";
			const text = templateDraftText(template, draft);
			const limit = Number(template.limit);
			const over = Number.isFinite(limit) && text.length > limit;
			const presets = [{ name: "default", builtin: true }];
			for (const presetName of Object.keys(draft.presets)) presets.push({ name: presetName, builtin: false });
			const required = new Set((Array.isArray(template.required) ? template.required : []).map(String));
			const requiredList = (Array.isArray(template.required) ? template.required : [])
				.map((item) => `{${item}}`)
				.join(", ");
			const create = () => {
				const failure = presetNameError(name, draft.presets, t);
				if (failure !== "") {
					setNameError(failure);
					return;
				}
				props.onCreate(String(name).trim());
				setCreating(false);
				setName("");
				setNameError("");
			};
			return jsxs(
				"div",
				{
					className: "wca-template",
					"data-template": props.id,
					children: [
						jsxs(
							"div",
							{
								className: "wca-template-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-setting-title",
											children: [
												jsx("h3", { className: "wca-template-title", children: t(`template.${props.id}.title`) }, "title"),
												props.draftChanged
													? jsx(
															"span",
															{
																className: "wca-tag",
																"data-tone": "warning",
																title: t("settings.draftHint"),
																children: t("settings.draftTag")
															},
															"draft"
													  )
													: null
											]
										},
										"title-row"
									),
									jsx("p", { className: "wca-template-desc", children: t(`template.${props.id}.desc`) }, "desc")
								]
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-template-controls",
								children: [
									jsxs(
										"label",
										{
											className: "wca-field",
											children: [
												jsx("span", { className: "wca-field-label", children: t("settings.template.preset") }, "label"),
												jsx(
													"select",
													{
														className: "wca-select",
														value: draft.active,
														disabled: props.saving,
														onChange: (event) => props.onActive(event.target.value),
														children: presets.map((preset) =>
															jsx(
																"option",
																{
																	value: preset.name,
																	children: preset.builtin
																		? `${preset.name}${t("settings.template.builtinSuffix")}`
																		: preset.name
																},
																preset.name
															)
														)
													},
													"select"
												)
											]
										},
										"preset"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: props.saving,
											onClick: () => {
												setCreating(true);
												setName("");
												setNameError("");
											},
											children: t("settings.template.newFromThis")
										},
										"new"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: props.saving || builtin,
											onClick: props.onDelete,
											children: t("settings.template.delete")
										},
										"delete"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: props.saving || builtin,
											onClick: props.onRevert,
											children: t("settings.template.revert")
										},
										"revert"
									)
								]
							},
							"controls"
						),
						creating
							? jsxs(
									"div",
									{
										className: "wca-template-new",
										children: [
											jsxs(
												"label",
												{
													className: "wca-field",
													children: [
														jsx("span", { className: "wca-field-label", children: t("settings.template.presetName") }, "label"),
														jsx(
															"input",
															{
																className: "wca-input",
																type: "text",
																value: name,
																maxLength: 64,
																spellCheck: false,
																autoComplete: "off",
																disabled: props.saving,
																onChange: (event) => {
																	setName(event.target.value);
																	setNameError("");
																},
																onKeyDown: (event) => {
																	if (event.key === "Enter") {
																		event.preventDefault();
																		create();
																	}
																}
															},
															"input"
														)
													]
												},
												"field"
											),
											jsx(
												"button",
												{
													type: "button",
													className: "wca-btn",
													"data-variant": "primary",
													disabled: props.saving,
													onClick: create,
													children: t("settings.template.create")
												},
												"create"
											),
											jsx(
												"button",
												{
													type: "button",
													className: "wca-btn",
													"data-variant": "outline",
													disabled: props.saving,
													onClick: () => {
														setCreating(false);
														setName("");
														setNameError("");
													},
													children: t("settings.template.cancel")
												},
												"cancel"
											)
										]
									},
									"new-form"
							  )
							: null,
						nameError === ""
							? null
							: jsx("p", { className: "wca-template-error", role: "alert", children: nameError }, "name-error"),
						jsx(
							"textarea",
							{
								className: "wca-textarea",
								rows: 7,
								value: text,
								readOnly: builtin,
								disabled: props.saving,
								spellCheck: false,
								"aria-label": t(`template.${props.id}.title`),
								onChange: (event) => props.onText(event.target.value)
							},
							"text"
						),
						builtin ? jsx("p", { className: "wca-setting-note", children: t("settings.template.readonly") }, "readonly") : null,
						jsxs(
							"div",
							{
								className: "wca-template-meta",
								"data-over": over ? "true" : "false",
								children: [
									jsx(
										"span",
										{ className: "wca-template-count", children: t("settings.template.count", { count: text.length, limit }) },
										"count"
									),
									jsx("span", { children: t("settings.template.requiredLegend", { required: requiredList }) }, "required")
								]
							},
							"meta"
						),
						jsxs(
							"div",
							{
								className: "wca-template-placeholders",
								children: [
									jsx("span", { className: "wca-field-label", children: t("settings.template.placeholders") }, "label"),
									jsx(
										"span",
										{
											className: "wca-placeholders",
											children: (Array.isArray(template.placeholders) ? template.placeholders : []).map((item) =>
												jsx(
													"code",
													{
														className: "wca-placeholder",
														"data-required": required.has(String(item)) ? "true" : "false",
														children: `{${item}}`
													},
													String(item)
												)
											)
										},
										"tokens"
									)
								]
							},
							"placeholders"
						),
						props.error === ""
							? null
							: jsx("p", { className: "wca-template-error", role: "alert", children: props.error }, "error")
					]
				},
				props.id
			);
		}

		/** The Settings feature panel: loads the snapshot, edits it locally, saves one PUT at a time. */
		function SettingsSection(props) {
			const t = props.t;
			const feature = props.feature;
			const focusGroup = typeof props.focusGroup === "string" ? props.focusGroup : null;
			const [snapshot, setSnapshot] = react.useState(null);
			const [drafts, setDrafts] = react.useState({});
			const [templateDrafts, setTemplateDrafts] = react.useState({});
			const [resets, setResets] = react.useState(() => new Set());
			const [fieldErrors, setFieldErrors] = react.useState({});
			const [pageError, setPageError] = react.useState("");
			const [loading, setLoading] = react.useState(true);
			const [saving, setSaving] = react.useState(false);
			const [conflict, setConflict] = react.useState(null);
			const [savedRevision, setSavedRevision] = react.useState(null);
			const alive = react.useRef(true);
			const requestId = react.useRef(0);
			const focusApplied = react.useRef(false);
			const storage = react.useRef(null);
			if (storage.current === null) storage.current = browserStorage();
			const draftsRef = react.useRef(drafts);
			draftsRef.current = drafts;

			/** The settings form survives a section switch in localStorage, scoped to its revision. */
			const readEnvelope = () => {
				let raw = null;
				try {
					raw = storage.current === null ? settingsDraftMemory : storage.current.getItem(SETTINGS_DRAFT_KEY);
				} catch {
					raw = settingsDraftMemory;
				}
				try {
					return typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null;
				} catch {
					return null;
				}
			};
			const writeEnvelope = (envelope) => {
				const text = JSON.stringify(envelope);
				settingsDraftMemory = text;
				try {
					if (storage.current !== null) storage.current.setItem(SETTINGS_DRAFT_KEY, text);
				} catch {
					/* storage unavailable: the in-memory copy still survives section switches */
				}
			};

			const applyStyle = (value) => {
				if (typeof props.onStyleChange === "function") props.onStyleChange(String(value));
			};
			const adopt = react.useCallback(
				(payload, restore, keepDrafts = false) => {
					setSnapshot(payload);
					if (restore === true) {
						const stored = readEnvelope();
						const restored = restoreSettingsDrafts(payload, stored);
						setDrafts({ ...valueDraftsOf(payload), ...restored.valueDrafts });
						setTemplateDrafts({ ...templateDraftsOf(payload), ...restored.templateDrafts });
						setResets(restored.resets);
						applyStyle(restored.valueDrafts["webui.style"] ?? styleOf(payload));
					} else if (keepDrafts === true) {
						// A 409 says the server moved on, not that the operator's work is disposable. Rebase the
						// in-memory drafts onto the fresh snapshot so Reload keeps them, then filter out keys /
						// templates the other writer deleted.
						const rows = new Set((Array.isArray(payload.rows) ? payload.rows : []).map((row) => String(row.key)));
						const templates = new Set(Object.keys(payload.templates ?? {}));
						setDrafts((previous) => {
							const next = { ...valueDraftsOf(payload) };
							for (const [key, value] of Object.entries(previous)) if (rows.has(key)) next[key] = value;
							return next;
						});
						setTemplateDrafts((previous) => {
							const next = { ...templateDraftsOf(payload) };
							for (const [id, draft] of Object.entries(previous)) if (templates.has(id)) next[id] = draft;
							return next;
						});
						setResets((previous) => new Set([...previous].filter((key) => rows.has(key))));
						applyStyle(draftsRef.current["webui.style"] ?? styleOf(payload));
					} else {
						setDrafts(valueDraftsOf(payload));
						setTemplateDrafts(templateDraftsOf(payload));
						setResets(new Set());
						settingsDraftMemory = null;
						try {
							if (storage.current !== null) storage.current.removeItem(SETTINGS_DRAFT_KEY);
						} catch {
							/* nothing to clear */
						}
						applyStyle(styleOf(payload));
					}
					setFieldErrors({});
					setPageError("");
					setConflict(null);
					setSavedRevision(null);
				},
				// reads the current drafts through refs; including them here would re-run the mount load
				[props.onStyleChange]
			);

			const load = react.useCallback(
				(restore = false, keepDrafts = false) => {
					const current = ++requestId.current;
					setLoading(true);
					return (async () => {
						try {
							const response = await fetch(SETTINGS_URL, {
								headers: { accept: "application/json" },
								cache: "no-store"
							});
							const payload = await response.json().catch(() => ({}));
							if (!alive.current || current !== requestId.current) return;
							if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
							adopt(payload, restore, keepDrafts);
						} catch (failure) {
							if (!alive.current || current !== requestId.current) return;
							setPageError(
								t("settings.loadFailed", {
									message: failure instanceof Error ? failure.message : String(failure)
								})
							);
						} finally {
							if (alive.current && current === requestId.current) setLoading(false);
						}
					})();
				},
				[adopt, t]
			);

			react.useEffect(() => {
				alive.current = true;
				load(true);
				return () => {
					alive.current = false;
				};
			}, [load]);

			// A hook's "open the templates group" button lands here with the group id. The panel remounts
			// on a section switch, so scrolling once after that mount is enough.
			react.useEffect(() => {
				if (focusGroup === null || snapshot === null || focusApplied.current || typeof document === "undefined") return;
				const node = document.getElementById(`wca-settings-group-${focusGroup}`);
				if (node === null) return;
				focusApplied.current = true;
				node.scrollIntoView({ block: "start", behavior: "auto" });
			}, [focusGroup, snapshot]);

			// Persist after every edit; a successful save or an explicit Reload clears it in adopt().
			react.useEffect(() => {
				if (snapshot === null) return;
				writeEnvelope({
					revision: snapshot.revision,
					valueDrafts: drafts,
					templateDrafts,
					resets: [...resets]
				});
			}, [snapshot, drafts, templateDrafts, resets]);

			const staged = react.useMemo(
				() => stagedChanges(snapshot, drafts, templateDrafts, resets, t),
				[snapshot, drafts, templateDrafts, resets, t]
			);
			const changeCount =
				Object.keys(staged.values).length + Object.keys(staged.templates).length + staged.reset.length;
			const errorCount = Object.keys(staged.valueErrors).length + Object.keys(staged.templateErrors).length;
			const dirty = changeCount > 0 || errorCount > 0;

			const clearError = (key) =>
				setFieldErrors((previous) => {
					if (previous[key] === undefined) return previous;
					const next = { ...previous };
					delete next[key];
					return next;
				});
			const setValue = (key, value) => {
				setDrafts((previous) => ({ ...previous, [key]: value }));
				setResets((previous) => {
					if (!previous.has(key)) return previous;
					const next = new Set(previous);
					next.delete(key);
					return next;
				});
				// The style is a preview: the panel changes immediately, and Save makes it stick.
				if (key === "webui.style" && typeof props.onStyleChange === "function") props.onStyleChange(value);
				clearError(key);
			};
			const stageReset = (row) => {
				setResets((previous) => new Set(previous).add(String(row.key)));
				setDrafts((previous) => ({ ...previous, [String(row.key)]: settingDraft(row.default) }));
				if (row.key === "webui.style" && typeof props.onStyleChange === "function") {
					props.onStyleChange(settingDraft(row.default));
				}
				clearError(String(row.key));
			};
			const setActive = (id, active) => {
				clearError(id);
				setTemplateDrafts((previous) => ({ ...previous, [id]: { ...previous[id], active } }));
			};
			const setText = (id, text) => {
				clearError(id);
				setTemplateDrafts((previous) => {
					const draft = previous[id];
					if (draft === undefined || draft.active === "default") return previous;
					return { ...previous, [id]: { ...draft, presets: { ...draft.presets, [draft.active]: text } } };
				});
			};
			const createPreset = (id, name) => {
				clearError(id);
				setTemplateDrafts((previous) => {
					const draft = previous[id];
					if (draft === undefined) return previous;
					const text = templateDraftText(snapshot?.templates?.[id], draft);
					return { ...previous, [id]: { active: name, presets: { ...draft.presets, [name]: text } } };
				});
			};
			const deletePreset = (id) => {
				clearError(id);
				setTemplateDrafts((previous) => {
					const draft = previous[id];
					if (draft === undefined || draft.active === "default") return previous;
					const presets = { ...draft.presets };
					delete presets[draft.active];
					return { ...previous, [id]: { active: "default", presets } };
				});
			};
			const revertPreset = (id) => setActive(id, "default");

			const save = async () => {
				if (snapshot === null || saving || conflict !== null) return;
				const next = stagedChanges(snapshot, drafts, templateDrafts, resets, t);
				if (Object.keys(next.valueErrors).length > 0 || Object.keys(next.templateErrors).length > 0) {
					setFieldErrors({ ...next.valueErrors, ...next.templateErrors });
					setPageError(t("settings.fixErrors"));
					return;
				}
				if (
					Object.keys(next.values).length === 0 &&
					Object.keys(next.templates).length === 0 &&
					next.reset.length === 0
				) {
					setPageError("");
					return;
				}
				const body = { revision: snapshot.revision };
				if (Object.keys(next.values).length > 0) body.values = next.values;
				if (Object.keys(next.templates).length > 0) body.templates = next.templates;
				if (next.reset.length > 0) body.reset = { values: next.reset };
				setSaving(true);
				setPageError("");
				try {
					const response = await fetch(SETTINGS_URL, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body)
					});
					const payload = await response.json().catch(() => ({}));
					if (!alive.current) return;
					if (response.status === 409) {
						const revision = Number(payload?.revision);
						const current = Number.isFinite(revision) ? revision : "?";
						setConflict({ revision: Number.isFinite(revision) ? revision : null, message: String(payload?.message ?? "") });
						setPageError(t("settings.conflict", { revision: current }));
						return;
					}
					if (!response.ok) {
						const message = String(payload?.message ?? `HTTP ${response.status}`);
						const field = fieldOfMessage(message);
						if (field !== "") setFieldErrors({ [field]: message });
						setPageError(t("settings.saveFailed", { message }));
						return;
					}
					adopt(payload, false);
					const revision = Number(payload?.revision);
					setSavedRevision(Number.isFinite(revision) ? revision : null);
				} catch (failure) {
					if (!alive.current) return;
					setPageError(
						t("settings.saveFailed", {
							message: failure instanceof Error ? failure.message : String(failure)
						})
					);
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const rowByKey = new Map();
			for (const row of Array.isArray(snapshot?.rows) ? snapshot.rows : []) rowByKey.set(String(row.key), row);
			const covered = new Set();
			for (const group of SETTINGS_GROUPS) for (const key of group.keys ?? []) covered.add(key);
			const extraRows = (Array.isArray(snapshot?.rows) ? snapshot.rows : []).filter(
				(row) => !covered.has(String(row.key))
			);
			const groups =
				extraRows.length === 0
					? SETTINGS_GROUPS
					: [
							...SETTINGS_GROUPS,
							{ id: "other", titleKey: "settings.group.other", keys: extraRows.map((row) => String(row.key)) }
						];

			const renderRow = (key) => {
				const row = rowByKey.get(key);
				if (row === undefined) return null;
				return jsx(
					SettingRow,
					{
						row,
						t,
						draft: drafts[key] ?? settingDraft(row.value),
						draftChanged:
							resets.has(key) ||
							(drafts[key] !== undefined && settingDraftChanged(row, drafts[key])),
						pendingReset: resets.has(key),
						error: String(fieldErrors[key] ?? staged.valueErrors[key] ?? ""),
						saving,
						onChange: (value) => setValue(key, value),
						onReset: () => stageReset(row)
					},
					key
				);
			};

			const banners = [];
			const fileWarning =
				snapshot === null || snapshot.warning === undefined || snapshot.warning === null
					? ""
					: String(snapshot.warning);
			// A missing file is no longer a banner: install/first run ships one. A corrupt or manually
			// edited file still raises its warning, because the values below are fallbacks, not saved ones.
			if (snapshot !== null && fileWarning !== "") {
				banners.push(
					jsx(
						"p",
						{
							className: "wca-settings-banner",
							"data-tone": "warning",
							children: jsx("span", { className: "wca-settings-banner-text", children: t("settings.fileWarning", { warning: fileWarning }) }, "text")
						},
						"file"
					)
				);
			}
			if (pageError !== "") {
				banners.push(
					jsxs(
						"div",
						{
							className: "wca-settings-banner",
							"data-tone": "error",
							role: "alert",
							children: [
								jsx("p", { className: "wca-settings-banner-text", children: pageError }, "text"),
								conflict === null && snapshot !== null
									? null
									: jsx(
											"button",
											{
												type: "button",
												className: "wca-btn",
												"data-variant": "outline",
												disabled: saving,
												onClick: () => load(false, conflict !== null),
												children: t("settings.reload")
											},
											"reload"
										)
							]
						},
						"page"
					)
				);
			}

			const counts = sourceSummary(snapshot);
			const summaryParts = [];
			if (counts.file > 0) summaryParts.push(t("settings.sources.file", { count: counts.file }));
			if (counts.config > 0) summaryParts.push(t("settings.sources.config", { count: counts.config }));
			if (counts.env > 0) summaryParts.push(t("settings.sources.env", { count: counts.env }));
			const summary =
				snapshot === null
					? ""
					: summaryParts.length === 0
						? t("settings.sources.allDefault")
						: summaryParts.join(" · ");
			const status =
				snapshot === null
					? loading
						? t("settings.loading")
						: ""
					: dirty
						? errorCount > 0
							? t("settings.fixErrors")
							: t("settings.dirty", { count: changeCount })
						: savedRevision !== null
							? t("settings.saved", { revision: savedRevision })
							: t("settings.unchanged");
			const titleId = `wca-feature-${feature.id}`;
			return jsxs(
				"section",
				{
					className: "wca-feature",
					"aria-labelledby": titleId,
					children: [
						jsxs(
							"header",
							{
								className: "wca-feature-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-feature-heading",
											children: [
												jsx("h2", { id: titleId, className: "wca-feature-title", children: t(feature.titleKey) }, "title"),
												jsx("p", { className: "wca-feature-desc", children: t(feature.descriptionKey) }, "desc")
											]
										},
										"heading"
									),
									jsxs(
										"div",
										{
											className: "wca-settings-toolbar",
											children: [
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "outline",
														disabled: saving,
														onClick: () => load(false),
														children: t("settings.reload")
													},
													"reload"
												),
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "primary",
														disabled: saving || snapshot === null || conflict !== null || !dirty,
														onClick: () => save(),
														children: saving ? t("settings.saving") : t("settings.save")
													},
													"save"
												)
											]
										},
										"toolbar"
									)
								]
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-settings",
								children: [
									banners.length === 0
										? null
										: jsx("div", { className: "wca-settings-banners", children: banners }, "banners"),
									jsx(
										"p",
										{
											className: "wca-settings-status",
											"data-tone":
												errorCount > 0 && !loading
													? "error"
													: savedRevision !== null && !dirty
														? "success"
														: undefined,
											role: errorCount > 0 ? "alert" : undefined,
											children: status
										},
										"status"
									),
									snapshot === null
										? null
										: jsx("p", { className: "wca-settings-summary", children: summary }, "summary"),
									snapshot === null
										? null
										: jsx(
												react.Fragment,
												{
													children: groups.map((group) => {
														const hasContent =
															group.templates === true
																? Object.keys(snapshot.templates ?? {}).length > 0
																: (group.keys ?? []).some((key) => rowByKey.has(key));
														if (!hasContent) return null;
														const content =
															group.templates === true
																? Object.keys(snapshot.templates ?? {}).map((id) =>
																		jsx(
																			TemplateEditor,
																			{
																				id,
																				t,
																				template: snapshot.templates[id],
																				draft: templateDrafts[id] ?? { active: "default", presets: {} },
																		draftChanged: templateDraftChanged(snapshot.templates[id], templateDrafts[id] ?? { active: "default", presets: {} }),
																				saving,
																				error: String(fieldErrors[id] ?? staged.templateErrors[id] ?? ""),
																				onActive: (active) => setActive(id, active),
																				onText: (text) => setText(id, text),
																				onCreate: (name) => createPreset(id, name),
																				onDelete: () => deletePreset(id),
																				onRevert: () => revertPreset(id)
																			},
																			id
																		)
																  )
																: (group.keys ?? []).map((key) => renderRow(key));
														return jsxs(
															"div",
															{
																id: `wca-settings-group-${group.id}`,
																className: "wca-settings-group",
																children: [
																	jsx("h3", { className: "wca-settings-group-title", children: t(group.titleKey) }, "title"),
																	content
																]
															},
															group.id
														);
													})
												},
												"groups"
										  ),
									jsxs(
										"div",
										{
											className: "wca-settings-notes",
											children: [
												jsx("p", { className: "wca-hint", children: t("settings.notes.recovery") }, "recovery"),
												jsx("p", { className: "wca-hint", children: t("settings.notes.scope") }, "scope"),
												jsx("p", { className: "wca-hint", children: t("settings.notes.live") }, "live")
											]
										},
										"notes"
									)
								]
							},
							"body"
						)
					]
				},
				"feature"
			);
		}
		// ------------------------------------------------------------------ hooks

		/** Format one recorded run time; an unparseable timestamp is shown verbatim instead of "Invalid Date". */
		function hookRunTime(at) {
			if (typeof at !== "string" || at === "") return "";
			const date = new Date(at);
			if (!Number.isFinite(date.getTime())) return at;
			return date.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false
			});
		}

		/**
		* The full `hooks.labels` object a rename PUT must send: the server replaces the whole map, so
		* omitting the other overrides would silently drop them. An empty or default label removes the
		* override and restores `defaultLabel`.
		*/
		function nextHookLabels(view, row, draft) {
			const labels = { ...(view?.labels ?? {}) };
			const value = String(draft ?? "").trim();
			if (value === "" || value === String(row?.defaultLabel ?? "")) delete labels[String(row?.id ?? "")];
			else labels[String(row?.id ?? "")] = value;
			return labels;
		}

		/** Mirror the server's label rules for inline feedback; the server still owns the final check. */
		function hookLabelError(label, t) {
			const value = String(label ?? "").trim();
			if (value.length > 120) return t("hooks.rename.error.long");
			if (/[\u0000-\u001f\u007f]/.test(value)) return t("hooks.rename.error.control");
			return "";
		}

		function hookStatusText(t, status) {
			const known = new Set(["ok", "failed", "timeout", "paused"]);
			return t(`hooks.run.${known.has(status) ? status : "failed"}`);
		}

		/** One row of the "last N runs" list; stderr is already trimmed and capped server-side. */
		function HookRunRow(props) {
			const t = props.t;
			const run = props.run;
			const detail = run.stderrTail !== "" ? run.stderrTail : run.error ?? "";
			return jsxs(
				"div",
				{
					className: "wca-hooks-run",
					"data-status": run.status,
					children: [
						jsx("span", { className: "wca-hooks-run-time", children: hookRunTime(run.at) }, "time"),
						jsx("code", { className: "wca-hooks-run-event", children: run.event }, "event"),
						jsx(
							"span",
							{
								className: "wca-hooks-run-name",
								children: run.name ?? t("hooks.run.pausedName")
							},
							"name"
						),
						jsx("span", { className: "wca-hooks-run-status", children: hookStatusText(t, run.status) }, "status"),
						jsx(
							"span",
							{
								className: "wca-hooks-run-duration",
								children: run.durationMs === null ? "" : t("hooks.run.duration", { ms: run.durationMs })
							},
							"duration"
						),
						detail === ""
							? null
							: jsx("pre", { className: "wca-hooks-stderr", children: detail }, "stderr")
					]
				},
				props.rowKey
			);
		}

		/** A compact "last run" line inside a row (the full list lives at the card foot). */
		function HookRunLine(props) {
			const t = props.t;
			const run = props.run;
			if (run === null) return null;
			return jsxs(
				"p",
				{
					className: "wca-hooks-row-note",
					children: [
						jsx("span", { children: t("hooks.run.last") }, "label"),
						jsx("span", { children: hookStatusText(t, run.status) }, "status"),
						run.durationMs === null
							? null
							: jsx("span", { children: ` · ${t("hooks.run.duration", { ms: run.durationMs })}` }, "duration")
					]
				},
				"last"
			);
		}

		/**
		* One event card: meaning, payload, built-in and custom rows, last five runs, and the "Add"
		* disclosure. Every prose field comes from the host snapshot, which renders `hook-events.js`;
		* this component never retypes an event explanation or a prompt.
		*/
		function HookEvent(props) {
			const t = props.t;
			const event = props.event;
			const view = props.view;
			const rows = Array.isArray(event.rows) ? event.rows : [];
			const customRows = Array.isArray(event.customRows) ? event.customRows : [];
			const runs = Array.isArray(event.lastRuns) ? event.lastRuns : [];
			const open = props.openPrompt === event.id;
			const copied = props.copied === event.id;
			const renderBuiltin = row => {
				const draft = Object.hasOwn(props.labelDrafts, row.id) ? props.labelDrafts[row.id] : row.label;
				const trimmed = String(draft ?? "").trim();
				const changed = row.renamed ? trimmed !== row.label : trimmed !== "" && trimmed !== row.label;
				const error = String(props.rowErrors[row.id] ?? "");
				const saving = props.savingId === row.id;
				return jsxs(
					"div",
					{
						className: "wca-hooks-row",
						"data-kind": "builtin",
						"data-row-id": row.id,
						children: [
							jsxs(
								"div",
								{
									className: "wca-hooks-row-head",
									children: [
										jsx("span", { className: "wca-hooks-row-name", children: row.label }, "name"),
										jsx("code", { className: "wca-hooks-code", children: row.id }, "id"),
										jsx("span", { className: "wca-hooks-badge", children: t("hooks.row.core") }, "core"),
										row.renamed
											? jsx("span", { className: "wca-hooks-badge", children: t("hooks.row.renamed") }, "renamed")
											: null
									]
								},
								"head"
							),
							row.description === undefined
								? null
								: jsx(
										"div",
										{
											className: "wca-hooks-row-desc",
											children: jsx(Markdown, { text: row.description }, "markdown")
										},
										"desc"
									),
							jsx("p", { className: "wca-hooks-row-note", children: t("hooks.row.notCancellable") }, "core-note"),
							row.template === undefined
								? null
								: jsxs(
										"p",
										{
											className: "wca-hooks-row-note",
											children: [
												jsx("span", { children: t("hooks.row.template", { template: `\`${row.template}\`` }) }, "text"),
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "outline",
														onClick: () => props.onNavigate("settings", "templates"),
														children: t("hooks.row.openTemplates")
													},
													"open"
												)
											]
										},
										"template"
									),
							row.pointer === undefined
								? null
								: jsx(
										"p",
										{
											className: "wca-hooks-row-note",
											children: t("hooks.row.pointer", { pointer: `\`${row.pointer}\`` })
										},
										"pointer"
									),
							jsxs(
								"div",
								{
									className: "wca-hooks-rename",
									children: [
										jsx("label", { className: "wca-hooks-rename-label", htmlFor: `wca-hook-label-${row.id}`, children: t("hooks.rename.label") }, "label"),
										jsx("input", {
											id: `wca-hook-label-${row.id}`,
											className: "wca-hooks-input",
											type: "text",
											value: draft,
											maxLength: 120,
											placeholder: row.defaultLabel,
											"aria-invalid": error !== "",
											disabled: saving,
											onChange: change => props.onLabelDraft(row.id, change.target.value)
										}, "input"),
										jsx(
											"button",
											{
												type: "button",
												className: "wca-btn",
												"data-variant": "outline",
												disabled: !changed || saving || props.savingId !== "" || props.conflict === true,
												onClick: () => props.onSaveLabel(row, draft),
												children: saving ? t("hooks.rename.saving") : t("hooks.rename.save")
											},
											"save"
										)
									]
								},
								"rename"
							),
							row.renamed
								? jsx("p", { className: "wca-hooks-row-note", children: t("hooks.row.defaultLabel", { label: row.defaultLabel }) }, "default")
								: null,
							error === "" ? null : jsx("p", { className: "wca-hooks-error", role: "alert", children: error }, "error"),
							jsx("p", { className: "wca-hooks-row-note", children: t("hooks.row.renamable") }, "rename-note"),
							jsx(HookRunLine, { t, run: row.lastRun ?? null }, "last")
						]
					},
					row.id
				);
			};
			const renderCustom = row =>
				jsxs(
					"div",
					{
						className: "wca-hooks-row",
						"data-kind": "custom",
						"data-row-id": row.id,
						children: [
							jsxs(
								"div",
								{
									className: "wca-hooks-row-head",
									children: [
										jsx("span", { className: "wca-hooks-row-name", children: row.name }, "name"),
										jsx("code", { className: "wca-hooks-code", children: row.id }, "id"),
										jsx(
											"span",
											{
												className: "wca-hooks-badge",
												children: row.enabled === false ? t("hooks.row.disabled") : t("hooks.row.enabled")
											},
											"enabled"
										)
									]
								},
								"head"
							),
							jsxs(
								"details",
								{
									className: "wca-hooks-script",
									children: [
										jsx("summary", { children: t("hooks.row.script") }, "summary"),
										jsx("pre", { children: row.script }, "script")
									]
								},
								"script"
							),
							jsx(HookRunLine, { t, run: row.lastRun ?? null }, "last")
						]
					},
					row.id
				);
			return jsxs(
				"article",
				{
					className: "wca-hooks-event",
					"data-event-id": event.id,
					children: [
						jsxs(
							"div",
							{
								className: "wca-hooks-event-head",
								children: [
									jsx("code", { className: "wca-hooks-code", children: event.id }, "id"),
									jsx("h3", { className: "wca-hooks-event-title", children: event.title }, "title"),
									jsx("span", { className: "wca-hooks-badge", children: t("hooks.event.rows", { count: rows.length + customRows.length }) }, "count"),
									jsx(
										"span",
										{
											className: "wca-hooks-badge",
											children: event.repeatable ? t("hooks.event.repeatable") : t("hooks.event.once")
										},
										"repeat"
									)
								]
							},
							"head"
						),
						jsx(
							"div",
							{
								className: "wca-hooks-explanation",
								children: jsx(Markdown, { text: event.explanation }, "markdown")
							},
							"explanation"
						),
						jsxs(
							"dl",
							{
								className: "wca-hooks-meta",
								children: [
									jsxs(
										"div",
										{
											children: [
												jsx("dt", { children: t("hooks.event.when") }, "label"),
												jsx("dd", { children: jsx(Markdown, { text: event.when }, "markdown") }, "value")
											]
										},
										"when"
									),
									jsxs(
										"div",
										{
											children: [
												jsx("dt", { children: t("hooks.event.repeat") }, "label"),
												jsx(
													"dd",
													{
														children: jsx(
															Markdown,
															{
																text: `${event.repeatable ? t("hooks.event.repeatable") : t("hooks.event.once")} ${event.repeatNote}`
															},
															"markdown"
														)
													},
													"value"
												)
											]
										},
										"repeat"
									)
								]
							},
							"meta"
						),
						jsxs(
							"details",
							{
								className: "wca-hooks-payload",
								children: [
									jsx("summary", { children: t("hooks.event.payload", { count: event.payload.length }) }, "summary"),
									jsx(
										"ul",
										{
											children: event.payload.map(field =>
												jsxs(
													"li",
													{
														children: [
															jsx("code", { children: field.name }, "name"),
															" ",
															jsx("span", { children: field.description }, "desc")
														]
													},
													field.name
												)
											)
										},
										"list"
									)
								]
							},
							"payload"
						),
						jsxs(
							"div",
							{
								className: "wca-hooks-rows",
								children: [
									jsx("p", { className: "wca-hooks-row-note", children: t("hooks.event.rows", { count: rows.length + customRows.length }) }, "label"),
									...rows.map(renderBuiltin),
									...customRows.map(renderCustom),
									rows.length + customRows.length === 0
										? jsx("p", { className: "wca-hooks-row-note", children: t("hooks.event.noRows") }, "empty")
										: null
								]
							},
							"rows"
						),
						jsxs(
							"div",
							{
								className: "wca-hooks-runs",
								children: [
									jsx("p", { className: "wca-hooks-row-note", children: t("hooks.event.history", { count: view.runLimit }) }, "label"),
									runs.length === 0
										? jsx("p", { className: "wca-hooks-row-note", children: t("hooks.event.noRuns") }, "empty")
										: runs.map((run, index) => jsx(HookRunRow, { t, run, rowKey: `${event.id}-${index}` }, `${event.id}-${index}`))
								]
							},
							"runs"
						),
						jsxs(
							"div",
							{
								className: "wca-hooks-add",
								children: [
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											"aria-expanded": open,
											onClick: () => props.onTogglePrompt(event.id),
											children: open ? t("hooks.prompt.close") : t("hooks.prompt.add")
										},
										"toggle"
									),
									open
										? jsxs(
												"div",
												{
													className: "wca-hooks-prompt",
													children: [
														jsx("p", { className: "wca-hint", children: t("hooks.prompt.hint") }, "hint"),
														jsxs(
															"div",
															{
																className: "wca-hooks-prompt-actions",
																children: [
																	jsx(
																		"button",
																		{
																			type: "button",
																			className: "wca-btn",
																			"data-variant": "primary",
																			onClick: () => props.onCopyPrompt(event),
																			children: copied ? t("hooks.prompt.copied") : t("hooks.prompt.copy")
																		},
																		"copy"
																	)
																]
															},
															"actions"
														),
														jsx(
															"pre",
															{
																className: "wca-hooks-prompt-text",
																tabIndex: 0,
																children: event.prompt
															},
															"text"
														)
													]
												},
												"prompt"
											)
										: null
								]
							},
							"add"
						)
					]
				},
				event.id
			);
		}

		/** The third feature: a read-only hook view with one revision-checked rename writer. */
		function HooksSection(props) {
			const t = props.t;
			const feature = props.feature;
			const [snapshot, setSnapshot] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [pageError, setPageError] = react.useState("");
			const [conflict, setConflict] = react.useState(null);
			const [labelDrafts, setLabelDrafts] = react.useState({});
			const [rowErrors, setRowErrors] = react.useState({});
			const [savingId, setSavingId] = react.useState("");
			const [savedRevision, setSavedRevision] = react.useState(null);
			const [openPrompt, setOpenPrompt] = react.useState(null);
			const [copied, setCopied] = react.useState(null);
			const alive = react.useRef(true);
			const requestId = react.useRef(0);
			const hintTimer = react.useRef(null);
			const view = snapshot?.hookView ?? null;

			const load = react.useCallback(() => {
				const current = ++requestId.current;
				setLoading(true);
				return (async () => {
					try {
						const response = await fetch(SETTINGS_URL, {
							headers: { accept: "application/json" },
							cache: "no-store"
						});
						const payload = await response.json().catch(() => ({}));
						if (!alive.current || current !== requestId.current) return;
						if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
						setSnapshot(payload);
						setLabelDrafts({});
						setRowErrors({});
						setConflict(null);
						setSavedRevision(null);
						setPageError("");
					} catch (failure) {
						if (!alive.current || current !== requestId.current) return;
						setPageError(t("hooks.loadFailed", { message: failure instanceof Error ? failure.message : String(failure) }));
					} finally {
						if (alive.current && current === requestId.current) setLoading(false);
					}
				})();
			}, [t]);

			react.useEffect(() => {
				alive.current = true;
				load();
				return () => {
					alive.current = false;
					if (hintTimer.current !== null) clearTimeout(hintTimer.current);
				};
			}, [load]);

			const setLabelDraft = (id, value) => {
				setLabelDrafts(previous => ({ ...previous, [id]: value }));
				setRowErrors(previous => {
					if (previous[id] === undefined) return previous;
					const next = { ...previous };
					delete next[id];
					return next;
				});
			};

			const saveLabel = async (row, draft) => {
				if (snapshot === null || view === null || savingId !== "" || conflict !== null) return;
				const error = hookLabelError(draft, t);
				if (error !== "") {
					setRowErrors(previous => ({ ...previous, [row.id]: error }));
					return;
				}
				const labels = nextHookLabels(view, row, draft);
				setSavingId(row.id);
				setPageError("");
				setRowErrors(previous => {
					const next = { ...previous };
					delete next[row.id];
					return next;
				});
				try {
					const response = await fetch(SETTINGS_URL, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ revision: snapshot.revision, hooks: { labels } })
					});
					const payload = await response.json().catch(() => ({}));
					if (!alive.current) return;
					if (response.status === 409) {
						const revision = Number(payload?.revision);
						const current = Number.isFinite(revision) ? revision : "?";
						setConflict({ revision: Number.isFinite(revision) ? revision : null });
						setPageError(t("hooks.conflict", { revision: current }));
						return;
					}
					if (!response.ok) {
						const message = String(payload?.message ?? `HTTP ${response.status}`);
						setRowErrors(previous => ({ ...previous, [row.id]: message }));
						setPageError(t("hooks.saveFailed", { message }));
						return;
					}
					setSnapshot(payload);
					setLabelDrafts(previous => {
						const next = { ...previous };
						delete next[row.id];
						return next;
					});
					setConflict(null);
					const revision = Number(payload?.revision);
					setSavedRevision(Number.isFinite(revision) ? revision : null);
				} catch (failure) {
					if (!alive.current) return;
					setPageError(t("hooks.saveFailed", { message: failure instanceof Error ? failure.message : String(failure) }));
				} finally {
					if (alive.current) setSavingId("");
				}
			};

			const copyPrompt = async event => {
				const text = String(event.prompt ?? "");
				let ok = false;
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
						await navigator.clipboard.writeText(text);
						ok = true;
					}
				} catch {
					ok = false;
				}
				if (!ok && typeof document !== "undefined") {
					try {
						const node = document.createElement("textarea");
						node.value = text;
						node.setAttribute("readonly", "");
						node.style.position = "fixed";
						node.style.opacity = "0";
						document.body.appendChild(node);
						node.select();
						ok = document.execCommand("copy");
						node.remove();
					} catch {
						ok = false;
					}
				}
				setCopied(ok ? event.id : null);
				setPageError(ok ? "" : t("hooks.prompt.copyFailed"));
				if (hintTimer.current !== null) clearTimeout(hintTimer.current);
				if (ok) {
					hintTimer.current = setTimeout(() => {
						if (alive.current) setCopied(null);
					}, 1800);
				}
			};

			const eventCount = view === null ? 0 : view.events.length;
			const rowCount = view === null ? 0 : view.events.reduce((count, event) => count + event.rows.length + event.customRows.length, 0);
			const summary = view === null
				? ""
				: t("hooks.summary", {
						events: eventCount,
						builtin: view.builtin.length,
						custom: view.items.length
					});
			const status =
				pageError !== ""
					? pageError
					: loading
						? t("hooks.loading")
						: savedRevision !== null
							? t("hooks.saved", { revision: savedRevision })
							: "";
			const titleId = `wca-feature-${feature.id}`;
			return jsxs(
				"section",
				{
					className: "wca-feature",
					"aria-labelledby": titleId,
					children: [
						jsxs(
							"header",
							{
								className: "wca-feature-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-feature-heading",
											children: [
												jsx("h2", { id: titleId, className: "wca-feature-title", children: t(feature.titleKey) }, "title"),
												jsx("p", { className: "wca-feature-desc", children: t(feature.descriptionKey) }, "desc")
											]
										},
										"heading"
									),
									jsxs(
										"div",
										{
											className: "wca-settings-toolbar",
											children: [
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "outline",
														disabled: loading || savingId !== "",
														onClick: () => load(),
														children: t("hooks.reload")
													},
													"reload"
												)
											]
										},
										"toolbar"
									)
								]
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-feature-body",
								children: [
									jsx(
										"p",
										{
											className: "wca-status",
											"data-tone": pageError !== "" ? "error" : savedRevision !== null ? "success" : undefined,
											role: pageError !== "" ? "alert" : undefined,
											children: status
										},
										"status"
									),
									view === null
										? jsx(
												"p",
												{
													className: "wca-hint",
													children:
														snapshot !== null && typeof snapshot.hookViewError === "string"
															? t("hooks.viewError", { message: snapshot.hookViewError })
															: t("hooks.viewMissing")
												},
												"missing"
											)
										: jsxs(
												"div",
												{
													className: "wca-hooks",
													children: [
														jsxs(
															"div",
															{
																className: "wca-hooks-summary",
																"data-off": view.enabled === false,
																children: [
																	jsx("span", { children: summary }, "summary"),
																	jsx("span", { children: view.enabled === false ? t("hooks.disabled") : t("hooks.enabled") }, "switch"),
																	jsx("span", { children: t("hooks.interval", { seconds: view.intervalSeconds }) }, "interval"),
																	jsx("span", { children: t("hooks.event.rows", { count: rowCount }) }, "rows")
																]
															},
															"summary"
														),
														...view.events.map(event =>
															jsx(
																HookEvent,
																{
																	t,
																	event,
																	view,
																	labelDrafts,
																	rowErrors,
																	savingId,
																	openPrompt,
																	copied,
																	conflict: conflict !== null,
																	onLabelDraft: setLabelDraft,
																	onSaveLabel: saveLabel,
																	onTogglePrompt: id => setOpenPrompt(previous => (previous === id ? null : id)),
																	onCopyPrompt: copyPrompt,
																	onNavigate: id => {
																		if (typeof props.onNavigate === "function") props.onNavigate(id);
																	}
																},
																event.id
															)
														)
													]
												},
												"body"
											)
								]
							},
							"content"
						)
					]
				},
				"feature"
			);
		}
		//#endregion


		//#region projects
		//
		// A read-only view over the spv project registry. The host route probes every registered
		// deployment's own panel API concurrently (2s each) and turns a failure into that worker's
		// unavailable reason, so one stopped deployment never stalls this page.

		function ProjectsSection(props) {
			const t = props.t;
			const feature = props.feature;
			const [payload, setPayload] = react.useState(null);
			const [error, setError] = react.useState("");
			const [loading, setLoading] = react.useState(true);
			const [updatedAt, setUpdatedAt] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const load = async (silent) => {
					if (!silent) setLoading(true);
					try {
						const response = await fetch(PROJECTS_URL, {
							headers: { accept: "application/json" },
							cache: "no-store"
						});
						const body = await response.json().catch(() => ({}));
						if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
						if (!alive) return;
						setPayload(body);
						setUpdatedAt(new Date());
						setError("");
					} catch (failure) {
						if (!alive) return;
						setError(t("projects.loadFailed", { message: failure instanceof Error ? failure.message : String(failure) }));
					} finally {
						if (alive) setLoading(false);
					}
				};
				load(false);
				const timer = setInterval(() => {
					if (typeof document === "undefined" || document.visibilityState !== "hidden") load(true);
				}, PROJECTS_REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [t]);
			const projects = Array.isArray(payload?.spvProjects) ? payload.spvProjects : [];
			const status =
				error !== ""
					? error
					: loading || payload === null
						? t("projects.loading")
						: t("projects.status", {
								count: projects.length,
								time: updatedAt === null ? "" : updatedAt.toLocaleTimeString(undefined, { hour12: false })
							});
			const titleId = `wca-feature-${feature.id}`;
			return jsxs(
				"section",
				{
					className: "wca-feature",
					"aria-labelledby": titleId,
					children: [
						jsx(
							"header",
							{
								className: "wca-feature-head",
								children: jsxs(
									"div",
									{
										className: "wca-feature-heading",
										children: [
											jsx("h2", { id: titleId, className: "wca-feature-title", children: t(feature.titleKey) }, "title"),
											jsx("p", { className: "wca-feature-desc", children: t(feature.descriptionKey) }, "desc")
										]
									},
									"heading"
								)
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-feature-body",
								children: [
									jsx(
										"p",
										{
											className: "wca-status",
											"data-tone": error !== "" ? "error" : undefined,
											role: error !== "" ? "alert" : undefined,
											children: status
										},
										"status"
									),
									payload !== null && projects.length === 0
										? jsx("p", { className: "wca-empty", children: t("projects.empty") }, "empty")
										: null,
									projects.length > 0
										? jsx(
												"div",
												{
													className: "wca-cards",
													children: projects.map(project =>
														jsx(ProjectCard, { t, project }, String(project.root))
													)
												},
												"cards"
											)
										: null
								]
							},
							"body"
						)
					]
				},
				"feature"
			);
		}

		function ProjectCard(props) {
			const t = props.t;
			const project = props.project;
			const workers = Array.isArray(project.workers) ? project.workers : [];
			return jsxs(
				"article",
				{
					className: "wca-letter",
					"data-kind": "project",
					children: [
						jsx(
							"div",
							{
								className: "wca-letter-head",
								children: jsx(
									"div",
									{
										className: "wca-letter-origin",
										children: [
											jsx("span", { className: "wca-kind", children: t("projects.kind") }, "kind"),
											jsx("span", { className: "wca-tag", children: t("projects.workerCount", { count: workers.length }) }, "count")
										]
									},
									"origin"
								)
							},
							"head"
						),
						jsx("h3", { className: "wca-letter-title wca-project-path", children: String(project.root ?? "") }, "root"),
						project.exists === false
							? jsx("p", { className: "wca-meta", children: t("projects.rootMissing") }, "missing")
							: null,
						jsx(
							"div",
							{
								className: "wca-letter-body",
								children:
									workers.length === 0
										? jsx("p", { className: "wca-meta", children: t("projects.noWorkers") }, "none")
										: jsx(
												"div",
												{
													className: "wca-project-workers",
													children: workers.map(worker =>
														jsx(ProjectWorkerRow, { t, worker }, String(worker.project))
													)
												},
												"workers"
											)
							},
							"body"
						)
					]
				},
				"card"
			);
		}

		function ProjectWorkerRow(props) {
			const t = props.t;
			const worker = props.worker;
			const state = worker.state ?? { kind: "unavailable", reason: "no state was returned" };
			const unavailable = state.kind !== "ok";
			const running = Array.isArray(state.running) ? state.running : [];
			const workers = Number.isInteger(state.workers) ? state.workers : running.length;
			return jsxs(
				"div",
				{
					className: "wca-project-worker",
					children: [
						jsxs(
							"div",
							{
								className: "wca-project-worker-head",
								children: [
									jsx("strong", { children: String(worker.project ?? "") }, "project"),
									worker.deployment === null || worker.deployment === undefined
										? jsx("span", { className: "wca-tag", children: t("projects.undeployed") }, "port")
										: jsx(
												"span",
												{ className: "wca-tag", children: t("projects.port", { port: worker.deployment.port }) },
												"port"
											),
									jsx(
										"span",
										{
											className: "wca-tag",
											"data-tone": unavailable ? "error" : running.length > 0 || workers > 0 ? "success" : undefined,
											children: unavailable
												? t("projects.unavailable", { reason: state.reason })
												: running.length > 0 || workers > 0
													? t("projects.running", { count: running.length, workers })
													: t("projects.idle")
										},
										"state"
									)
								]
							},
							"head"
						),
						state.kind === "ok" && typeof worker.deployment?.url === "string" && worker.deployment.url !== ""
							? jsx(
									"p",
									{
										className: "wca-meta wca-project-jump",
										children: jsx(
											"a",
											{
												href: worker.deployment.url,
												target: "_blank",
												rel: "noreferrer",
												children: t("projects.openFullUi")
											},
											"link"
										)
									},
									"jump"
								)
							: null,
						jsx("p", { className: "wca-meta wca-project-path", children: String(worker.path ?? "") }, "path"),
						running.length > 0
							? jsx(
									"ul",
									{
										className: "wca-project-running",
										children: running.map(ticket =>
											jsx("li", { children: String(ticket.title ?? "") || String(ticket.id ?? "") }, String(ticket.id))
										)
									},
									"running"
								)
							: null,
						Number.isInteger(state.queued) && state.queued > 0
							? jsx("p", { className: "wca-meta", children: t("projects.queued", { count: state.queued }) }, "queued")
							: null,
						typeof state.setupProblem === "string" && state.setupProblem !== ""
							? jsx(
									"p",
									{ className: "wca-meta", children: t("projects.setup", { problem: state.setupProblem }) },
									"setup"
								)
							: null
					]
				},
				"worker"
			);
		}
		//#endregion

		/**
		* The features this page hosts. Adding a feature is exactly one array entry plus its
		* component; the feature nav and the active body are generated from this list.
		*/
		const SECTIONS = [
			{
				id: "inbox",
				labelKey: "section.inbox",
				titleKey: "feature.inbox.title",
				descriptionKey: "feature.inbox.description",
				Component: InboxSection
			},
			{
				id: "settings",
				labelKey: "section.settings",
				titleKey: "feature.settings.title",
				descriptionKey: "feature.settings.description",
				Component: SettingsSection
			},
			{
				id: "hooks",
				labelKey: "section.hooks",
				titleKey: "feature.hooks.title",
				descriptionKey: "feature.hooks.description",
				Component: HooksSection
			},
			{
				id: "projects",
				labelKey: "section.projects",
				titleKey: "feature.projects.title",
				descriptionKey: "feature.projects.description",
				Component: ProjectsSection
			}
		];

		/** The `main` slot page: title, feature navigation, and the active feature panel. */
		function PanelPage(props) {
			const t = props.t;
			const [active, setActive] = react.useState(SECTIONS[0].id);
			const [focusGroup, setFocusGroup] = react.useState(null);
			const [style, setStyle] = react.useState("fluid");
			const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0];
			const Component = section.Component;
			// Apply the saved style at load. The Settings section calls setStyle after a save and while the
			// operator previews the select, so switching never reloads the page. A failed read keeps the
			// default (fluid) rather than blocking the panel.
			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const response = await fetch(SETTINGS_URL, {
							headers: { accept: "application/json" },
							cache: "no-store"
						});
						if (!response.ok) return;
						const payload = await response.json().catch(() => ({}));
						if (alive) setStyle(styleOf(payload));
					} catch {
						/* old host or offline: keep the browser-side default */
					}
				})();
				return () => {
					alive = false;
				};
			}, []);
			return jsxs(
				"div",
				{
					className: "wca-page",
					"data-wca-style": style,
					children: [
						jsx("style", { children: STYLES }, "style"),
						jsxs(
							"header",
							{
								className: "wca-head",
								children: [
									jsxs(
										"div",
										{
											children: [
												jsx("h1", { className: "wca-title", children: t("panel") }, "title"),
												jsx("p", { className: "wca-subtitle", children: t("panel.subtitle") }, "subtitle")
											]
										},
										"heading"
									)
								]
							},
							"head"
						),
						jsxs(
							"nav",
							{
								className: "wca-nav",
								children: [
									jsx("span", { className: "wca-nav-label", children: t("nav.features") }, "label"),
									jsx(
										"div",
										{
											className: "wca-tabs",
											role: "tablist",
											"aria-label": t("sections.label"),
											children: SECTIONS.map((candidate) =>
												jsx(
													"button",
													{
														type: "button",
														role: "tab",
														id: `wca-tab-${candidate.id}`,
														"aria-controls": `wca-panel-${candidate.id}`,
														className: "wca-tab",
														"aria-selected": candidate.id === section.id,
														onClick: () => {
															setFocusGroup(null);
															setActive(candidate.id);
														},
														children: t(candidate.labelKey)
													},
													candidate.id
												)
											)
										},
										"tabs"
									)
								]
							},
							"nav"
						),
						jsx(
							"div",
							{
								id: `wca-panel-${section.id}`,
								role: "tabpanel",
								"aria-labelledby": `wca-tab-${section.id}`,
								children: jsx(Component, {
									t,
									feature: section,
									onStyleChange: setStyle,
									focusGroup,
									onNavigate: (id, group) => {
										setFocusGroup(typeof group === "string" ? group : null);
										setActive(id);
									}
								})
							},
							"section"
						)
					]
				},
				"page"
			);
		}
		//#endregion

		const inject = ["slots", "locale"];
		/**
		* Fill the sidebar panel list and the main page with the review inbox.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "wheelchair-agent-webui: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				locale: NS,
				label: () => t("panel")
			}, InboxIcon));
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					t
				})
			}, PanelPage));
		}
		exports.apply = apply;
		exports.inject = inject;
		/* Pure helpers exposed for the offline UI-status test; not a slot/module API. */
		exports.__test = {
			statusOf,
			stateOf,
			kindOfItem,
			activePreset,
			placeholderTokens,
			stagedChanges,
			valueDraftsOf,
			templateDraftsOf,
			presetNameError,
			STYLES,
			styleOf,
			itemDraftKey,
			freshItemIndices,
			INBOX_REFRESH_MS,
			sanitizeInboxDraft,
			createDraftStore,
			restoreSettingsDrafts,
			sourceSummary,
			groupByDay,
			dayKeyOf,
			letterTimeOf,
			clearsArrival,
			InboxItem,
			DayGroup,
			nextHookLabels,
			hookLabelError,
			hookRunTime,
			hookStatusText
		};
		return module.exports;
	}
});
