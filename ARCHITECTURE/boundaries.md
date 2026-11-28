# 边界：两个程序，三个入口

进入这个项目最先要分清的两件事。`ARCHITECTURE.md` 只留指针，正文在这里。

## 一、SPV 与 superagent 严格分开，互不 import

这是本项目最容易混淆的地方：

| | 我们的 SPV | superagent |
|---|---|---|
| 是什么 | 我们自己定义的 dsh **agent preset** | 另一个 dsh profile 里的**常驻服务** |
| 谁对话 | **用户** | 无人（后台进程） |
| profile | `dsh-tui` | `superagent` |
| preset | `spv`（`~/.dsh/.agent-presets/spv/`） | `dsh-superagent-router` / `-worker`（它 bundle 自带） |
| cwd | `bioagentforge`（读根版 AGENTS.md） | 独立 stateDir |
| 工具集 | 普通 dsh 会话的全套标准工具 + `spv_*` | `orchestrator_*` |
| 职责 | 听懂用户、派任务、报结果 | 准入判断、建 Ticket、路由、派工 |
| 唯一的接口 | **文件队列**（写 `pending/`、读 `outbox/`） | 同一个队列（反向） |

**不要把它们当成一个系统的两层。** 它们是两个独立程序，共享的只有队列文件格式。SPV 不读 superagent 的
代码，superagent 不知道 SPV 存在。

---

"新增工具必须注入"没有替代方案：模型可见的工具只能靠 `ctx.tools.register`，那只有插件能做。三个入口
**必须**分开，不能合成一个——前一个必须挂在 superagent profile，后两个必须挂在 dsh-tui，一个插件进不了
两个 profile。

| 入口（`package.json` exports 键） | 注册什么 | 挂在哪个 profile |
|---|---|---|
| `wheelchair-agent/spv-watch` | `spv` Source kind（Trigger/Channel/Policy） | `superagent` |
| `wheelchair-agent/spv-tools` | `spv_dispatch` / `spv_status`（插件内的注入器把 reply/notice 推进会话） | `dsh-tui` 的 SPV preset |
| `wheelchair-agent/spv-cron-plugin` | `/spv-cron` 斜杠命令 | `dsh-tui` 的 SPV preset |

**exports 的键是公开 API**：`~/.dsh/profiles/wca/cordis.patch.yml`（`#74` 前叫 `superagent`）用 bare specifier
`wheelchair-agent/spv-watch` 引用它，那是仓库外的操作者状态。只改键指向的文件，不改键名。

---

「一个核心 + 两个适配器」为什么不让插件去 `spawn` CLI：图与理由在 `ARCHITECTURE/cli.md` 的同名一节。
