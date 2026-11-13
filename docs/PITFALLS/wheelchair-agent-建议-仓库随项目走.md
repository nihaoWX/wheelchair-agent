# wheelchair-agent 建议 — 让派发的任务按项目自带 GitHub 仓库，而不是一律落到面板配置的那一个

场景与环境：Ubuntu 24.04.3 LTS（WSL2，内核 6.18.33.2-microsoft-standard-WSL2）；git 2.43.0；dsh 0.2.1-rc.3；
wheelchair-agent 0.1.0；superagent 面板的 GitHub Source 仓库为 `nihaoWX/bioagentforge`（首次保存于
2026-11-11，`settings-version:6` 仍为该值）。命令均逐字执行。

## 现象

`spv` 派发的任务已经自带项目路径（`project` 字段，如 `tools/pitfalls-manager`），但 worker 环境里的 GitHub
仓库仍是面板那一个单值，两者可以指向完全不同的项目，且环境里没有任何东西说明后者是兜底值。

实测（本工单自身就是一次实例，2026-11-13）：

- worker 执行环境同时给出 `DSH_SUPERAGENT_SPV_PROJECT = "tools/wheelchair-agent"` 与
  `DSH_SUPERAGENT_GITHUB_REPOSITORY = "nihaoWX/bioagentforge"`；而 `tools/wheelchair-agent` 根本没有
  GitHub remote（`git remote -v` 为空）。任务要改的是 wheelchair-agent，环境却只点名 bioagentforge。
- 面板仓库是单值且必填：GitHub Source 只有一个 repository 字段；为空时运行时不启动（setup 错误
  `repositoryUnset`）。所以任务正文里写仓库名也改不了环境里的那一条——worker 提示词明说执行环境
  “优先于这些指令里别处提到的任何仓库或账号”。
- 编排器自己的 GitHub API 调用也被限制在配置的那一个仓库：路径以 `/` 开头、带 scheme 或含 `..` 时直接报
  `GitHub calls are restricted to the configured repository`。也就是说，即使 worker 想改投别的仓库，
  编排器这一侧也没有出口。
- 20 个 `tools/` 目录里只有 3 个有 GitHub remote（`manuscripts_skills`、`pitfalls-manager`、`svg_grid`）；
  16 个完全没有 remote，1 个（`dsh-superagent`）的 remote 是本机路径而非 GitHub。即 17/20 的项目路径
  推不出 GitHub 仓库。
- 已发生的后果：2026-11-12 一个 `project: tools/pitfalls-manager` 的任务要求开 PR，worker 把分支
  `agent/pitfalls-dsh-install-5638cec0eeee` 推到 `nihaoWX/bioagentforge` 并在那里开了 PR #1
  （`createdAt` 2026-11-12T17:36:46Z，`closedAt` 2026-11-13T04:55:48Z，`mergedAt` 为 null），PR 的 4 个
  文件全部在 `tools/pitfalls-manager/` 下。该改动后来在正确的仓库 `nihaoWX/pitfalls-manager` 落地
  （commit `79908d7`，本地仓库于 2026-11-13 13:14:05 +0800 fast-forward 到它）。
- 全程没有任何警告或失败：worker 没有别的出口，系统行为与文档一致——所以这是建议，不是阻塞点。

## 复现步骤

### A. 本工单自身的环境（只读，随时可重放）

```bash
# 1. 任务自带的项目路径与 worker 环境里的仓库，两者不一致
#    （本工单 worker 会话的 Execution environment 段，逐字）
zstd -dc ~/.dsh/sessions/--home-nihao-.dsh-state-superagent-work-wheelchair-pitfall-report-11821f08b06f--/worker-*/session.v4.jsonl.zstd \
  | grep -m2 -o 'DSH_SUPERAGENT_\(SPV_PROJECT\|GITHUB_REPOSITORY\) = [^:]*'
# 实测：DSH_SUPERAGENT_GITHUB_REPOSITORY = \"nihaoWX/bioagentforge\"
#       DSH_SUPERAGENT_SPV_PROJECT = \"tools/wheelchair-agent\"
#       （会话记录里是 JSON 转义后的引号）

# 2. 该项目根本没有 GitHub remote
git -C /home/nihao/bioagentforge/tools/wheelchair-agent remote -v
# 实测：无输出（exit 0）

# 3. 面板里的仓库是单值
python3 - <<'PY'
import json, os, sqlite3
db = sqlite3.connect(f"{os.environ['HOME']}/.dsh/state/superagent/orchestrator.sqlite")
keys = [r[0] for r in db.execute("select key from kv where key like 'settings-version:%'")]
latest = max(keys, key=lambda k: int(k.split(':')[1]))
print(latest, json.loads(db.execute("select value from kv where key=?", (latest,)).fetchone()[0])
      ["settings"]["sources"]["github"]["config"]["repository"])
PY
# 实测：settings-version:6 nihaoWX/bioagentforge
```

### B. 项目路径推不出仓库的比例

```bash
cd /home/nihao/bioagentforge
for d in tools/*/; do printf '%-26s %s\n' "$(basename $d)" "$(git -C $d remote get-url origin 2>/dev/null || echo '(no remote)')"; done
# 实测：20 行里只有 manuscripts_skills / pitfalls-manager / svg_grid 是 https://github.com/...；
#       16 个 (no remote)；dsh-superagent 是本机路径。
```

### C. 已发生的错仓 PR

```bash
gh pr view 1 --repo nihaoWX/bioagentforge --json number,state,headRefName,files,createdAt,closedAt,mergedAt
# 实测：state CLOSED，headRefName agent/pitfalls-dsh-install-5638cec0eeee，
#       files 全部在 tools/pitfalls-manager/ 下，mergedAt null

git -C /home/nihao/bioagentforge/tools/pitfalls-manager log --oneline -1
# 实测：79908d7 feat(pitfalls-manager): install.sh 支持把 skill 装进 dsh（--harness dsh|commandcode|both）
```

## 建议

- 派发的任务应当能自己指明它属于哪个 GitHub 仓库，并且这个信息来自任务已经携带的项目路径，不需要操作者
  把仓库名手写进每个任务正文。
- 当项目路径推不出仓库时（本机 20 个项目里有 17 个如此），系统应当明确地报出来，而不是静默退回面板那一个
  仓库——静默退回正是这次推错仓库的原因。
- 面板里的仓库仍有实际职责（它决定监听哪个仓库的 Issues/PR），两者不应当互相静默覆盖；worker 应当能从
  环境里分辨“这个仓库是任务自己的”还是“这是兜底值”。
- 兜底发生时，这次派发的结果里应当留下可追溯的痕迹（哪个仓库是兜底来的），而不是让 worker 以为它就是
  任务的仓库。
