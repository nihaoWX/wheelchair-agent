# spv 项目（spv 项目 → worker 项目的绑定）

`INSTRUCTIONS.md` 的「spv项目和worker项目」段：`~/bioagentforge` 这样的目录**是**一个 spv 项目（spv 的工作
目录），它下面的小仓（`tools/<a tool>`、`research/<a task>`）是 worker 项目，**不能**再当 spv 项目。
这份文档记的是这条规则怎么落成数据、命令与面板。

## 数据形状（`<data root>/spv-projects.json`）

```json
{"version": 1, "spvProjects": [{"root": "/home/nihao/bioagentforge",
                               "workers": ["tools/wheelchair-agent", "tools/pitfalls-manager"]}]}
```

- 与 `deployments.json` 平级、互不内嵌：**部署**回答"这个 worker 项目跑在哪份 superagent 实例上"，
  **spv 项目**回答"这个 worker 项目归哪个 spv 管"。一个 worker 项目现在只能绑定**一个** spv 项目
  （`INSTRUCTIONS.md` 把这标为待定；真要放开时把 `workers` 换成带 `spvProject` 字段的记录即可）。
- 读：文件不存在 = 没有登记（`{exists:false}`）；坏 JSON **报错且一字不改**（与注册表同一套措辞：
  `... is not valid JSON ... It is never rewritten automatically`）。
- 写：同目录 pid 临时文件 + `chmod 0644` + `rename`；内容相同不动 mtime。

## 四条校验（都有测试）

1. spv 根必须存在，且**不是**已登记 worker 项目的 checkout —— 那两种目录的角色不同，混用会让面板把
   一个 project 同时说成"根"和"worker"。
2. 两个 spv 根**不能互相嵌套**（`bioagentforge` 与 `bioagentforge/tools/svg_grid` 不能同时登记）——
   这正是 `INSTRUCTIONS.md` 要防的"随意嵌套"。
3. `workers` 的每一项必须落在该 spv 根之下，形态是 `tools/*` / `research/*`。
4. 同一个 worker 不能同时出现在两个 spv 项目的 `workers` 里（读取时就报错，不静默取第一个）。

## 命令

| 命令 | 做什么 |
|---|---|
| `wheelchair-agent spv-project list [--json]` | 列出 spv 项目与它们绑定的 worker |
| `wheelchair-agent spv-project add <root> [--worker <project>]...` | 登记/更新；相同内容重复执行打印 `nothing changed` 且不写盘 |
| `wheelchair-agent spv-project remove <root>` | 还绑着 worker 时必须 `--force`（提示里列出会解绑哪些） |
| `wheelchair-agent deployment add <project> … --spv <root>` | 登记部署的同时把 worker 绑进那个 spv 项目；省略时只在"恰好一个 spv 根是它的祖先"时自动推断，0 个或 ≥2 个都要求显式 |
| `wheelchair-agent deployment remove <project>` | 同时把该 worker 从 spv 项目的 `workers` 里摘掉 |

## 面板「项目」段（只读）

- `GET /wheelchair-projects` 是 `src/spv/panel-routes.js` 里的一条 core 路由，所以 dsh 插件宿主与独立面板
  **都**有它（`#52` 的双宿主结构）。
- 数据拼装是 `src/spv/projects-view.js`：本地读 `spv-projects.json` + `deployments.json`，然后**并发**问
  每份部署的 `GET /orchestrator/api/{state,overview,tickets?state=working&limit=20}`。
- 单份部署 **2s 超时**（`PROJECT_PROBE_TIMEOUT_MS`），任何失败只把**那张 worker 行**标成
  `unavailable` 并带上最直接的原因（连接拒绝 / `timed out after 2000ms` / `HTTP 5xx`），整页永远不失败、
  不长时间转圈。
- 卡片只展示：spv 根、绑定的 worker、每个 worker 的部署端口（没有部署就写"未部署"）、正在跑的工单/worker。
  **没有按钮**：操作者原话是"只是展示，暂时没有修改的能力"；改数据走上面的 CLI。
- 前端 30 秒刷新一次，与收件箱的刷新节奏同源。

## 边界

- 这份表不参与派单：派单仍旧只看 `deployments.json`（`project → 队列`）。spv 项目是**展示与规划**用的，
  将来要"按 spv 项目批量操作"（例如一次给某个根下所有 worker 建部署）时再让它参与决策。
- 面板不写 `spv-projects.json`；`install.sh` 不创建它（没有登记就是没有登记）。
