# wheelchair-agent 审计 — 2026-11-14（R4 大改后的证据复核）

依据：`tools/pitfalls-manager/references/03_check.md`。对象是 `docs/PITFALLS/round-data/` 下每一轮的
`test.py`，判据是**本项目当前的 HARNESS**（`ARCHITECTURE.md`、`ARCHITECTURE/*.md`、`PROGRESS.md`）与
R4 之后的目录布局。

审计时的快照：分支 `agent/cli-restructure` @ `bb53b84`（R4 的 `code_after` 是 `44bc6bb`，之后只删了
已消费的报告，没有动证据）。

> 说明：本轮原计划派检查者子 agent 写这份清单，那个子 agent 没有产出；清单由 Arranger 依据**自己实际跑过**
> 的三轮 `test.py` 结果写成。每一档的判据都是可重放的命令，不是转述。

## 逐轮结论

| 轮次 | 档 | 依据 |
|---|---|---|
| R1 | **需修改**（已改） | 族1 从 PASS 变 SKIP：它渲染 preset 用的是 `scripts/render-preset.mjs` 与 `dsh/`，两者在 R4 里分别移到 `build/render-preset.mjs` 与 `preset/`。断言的目标（`dsh-llm-retry` 已挂载且未 disabled）**仍然存在**，只是路径漂了 ⇒ 改期望值/路径，不是作废。 |
| R2 | **仍有效** | 四族全绿，未改动。它读的是 `docs/agentsmd-examples/`、`docs/delivery-target.md` 与兄弟项目 `tools/dsh-superagent`，这些路径 R4 没动。族1 在工单 clone 里会 SKIP（找不到 bioagentforge 根），在真实项目目录里 PASS——这是它设计好的降级，不是失效。 |
| R4 | 新轮（本轮） | 本轮新增，四族全绿。 |

## R1 的具体处置

- 改了什么：`docs/PITFALLS/round-data/R1/test.py` 的 `REPO / "scripts" / "render-preset.mjs"` →
  `REPO / "build" / "render-preset.mjs"`，`REPO / "dsh"` → `REPO / "preset"`；`meta.toml` 的
  `note` 里 `dsh/agent.cordis.yml` → `preset/agent.cordis.yml`。
- 期望值有没有变：**没有**。族1 仍然断言「组合里有 `- id: llm-retry`、它指向
  `@deepseek-ai/dsh-llm-retry`、且没有 `disabled:`」；族2 仍然断言白名单恰好那六个码；族3 仍然断言
  worker 侧 `transient()` 的行为与两个常量。
- 为什么不是 `retire`：目标功能（重试链路）没有被删，断言仍然针对存在的功能，只是取源码的路径变了。
  按 `02_consume.md` §4.4 的判据，这属于「需修改」，落 `[[modify]]`。
- 改后实跑：`cd docs/PITFALLS/round-data/R1 && python3 test.py` → 三族 PASS，rc=0。

## R2 的具体处置

不动。实跑：`cd docs/PITFALLS/round-data/R2 && python3 test.py` → 四族 PASS，rc=0（在真实项目目录
`/home/nihao/bioagentforge/tools/wheelchair-agent` 下）。

## 复核过的旧处置

- `R3-F1`（`wontfix`）：R1 的 round-data 仍绿，它冻结的三条事实未变，裁决不需要重开。
- `R3-F2`（`deferred`）：`docs/delivery-target.md` 在 R4 里只改了路径与面板值描述，方向与六条约束未变；
  PR #1 的实现仍在分支里，`deferred` 的关闭条件（实现落地）已由 PR #1/#2 满足，但那是操作者合并时的事，
  本轮不改它的状态。
