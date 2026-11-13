# wheelchair-agent 建议 — 让派发的任务按项目自带 GitHub 仓库，而不是一律落到面板配置的那一个

场景与环境：Ubuntu 24.04.3 LTS（WSL2，内核 6.18.33.2-microsoft-standard-WSL2）；git 2.43.0；dsh 0.2.1-rc.3；
wheelchair-agent 0.1.0；superagent 面板的 GitHub Source 仓库为 `nihaoWX/bioagentforge`（首次保存于
2026-11-11，`settings-version:6` 仍为该值）。命令均逐字执行。（2026-11-13 更新：补入后续调查结论。）

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
- **信息流其实已经是一跳，修复点就在本仓库。** `spv` 把任务文件变成 Trigger 时就把 `project` 放进了
  `trigger.meta`（`src/spv.js` 的 `triggerOf`，`meta: { ...rest, queueId, thread, file, actor }`），同一个
  文件也已经按工单声明了 `DSH_SUPERAGENT_SPV_PROJECT`（`environment` 块）。也就是说，知道“这张工单做哪个
  项目”的组件，正是能顺手告诉 worker“该往哪个仓库交付”的组件；这件事不需要改上游 dsh-superagent 一行源码。
- **这个单值不能靠配置绕开**（2026-11-13 补查，三条路都堵，证据见复现步骤 D）：关掉 github Source 会让注入
  停下，但 setup 仍无条件要求仓库非空，服务停在 `setupPending`，连 `spv` 一起不工作；让 `spv` 声明同名变量
  不会覆盖，只会并排渲染成两行，worker 无从判断哪行算数；编排器自己的 GitHub API 通道也锁死在那一个仓库，
  即使 worker 侧拿到正确仓库，编排器也无法去盯第二个。结论：冲突不能靠配置消除，只能靠“另给一个可分辨的
  值 + 明确说明谁覆盖谁”来解决。
- **“没有 `.git`”与“有 `.git` 但没有 remote”是两种不同情况，不能合并处理。** 实测本机（2026-11-13 复核，
  `BioDatabaseDownloader` 已从 `tools/` 移除，故总数由 20 变 19）：`tools/` 下 19 个目录**全部**已有 `.git`，
  其中只有 3 个有 GitHub remote（`manuscripts_skills`、`pitfalls-manager`、`svg_grid`）、15 个完全没有
  remote、1 个（`dsh-superagent`）的 remote 是本机路径而非 GitHub——即 16/19 的项目路径推不出 GitHub 仓库。
  而 `research/` 下 11 个目录里有 6 个连 `.git` 都没有。也就是说，真正缺 remote 的是 `tools/` 里那 15 个
  “有版本库、没有远端”的项目，而不是“没有 `.git`”的项目。
- **`research/` 被明文规定为 local-only。** 根 `AGENTS.md` 写着 `research/` 的任务仓库
  “is local-only — never push/upload it”。所以对 `research/` 下的项目自动建远端并配 remote，是**违反现有
  规定**的，不能作为默认行为。
- **worker 的交付契约默认是 PR，但可以被任务显式改写。** `prompts/work.md` 写着
  “A code change without a PR is not ready unless the assignment explicitly requests a different
  deliverable”。所以对没有远端、也不该有远端的项目（如 `research/`），只要任务写明交付物是本地 commit，
  worker 就不会去开 PR——本仓库这两轮报告任务就是这么完成的（两个 commit 落在本地 `main`，没有 PR）。
  但**默认值仍是 PR**：任务没写清时，worker 要么报 blocked，要么拿环境里那个仓库去推，后者正是 PR #1 的成因。
- **`research/` 下 11 个目录一个 `AGENTS.md` 都没有**，而 local-only 这条约束只写在根 `AGENTS.md`。
  worker 的 cwd 是 `research/<task>/`，读的是该目录下的 `AGENTS.md`，因此**读不到**根目录那条约束。
  同理，`tools/` 下 19 个目录里 18 个有 `AGENTS.md`（内容完全相同），只有 `dsh-superagent` 没有。
  也就是说，“这个项目该不该有远端”这条信息，目前既不在 worker 能读到的地方，也没有统一来源。
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
# 实测：19 行里只有 manuscripts_skills / pitfalls-manager / svg_grid 是 https://github.com/...；
#       15 个 (no remote)；dsh-superagent 是本机路径。
```

### C. 已发生的错仓 PR

```bash
gh pr view 1 --repo nihaoWX/bioagentforge --json number,state,headRefName,files,createdAt,closedAt,mergedAt
# 实测：state CLOSED，headRefName agent/pitfalls-dsh-install-5638cec0eeee，
#       files 全部在 tools/pitfalls-manager/ 下，mergedAt null

git -C /home/nihao/bioagentforge/tools/pitfalls-manager log --oneline -1
# 实测：79908d7 feat(pitfalls-manager): install.sh 支持把 skill 装进 dsh（--harness dsh|commandcode|both）
```

### D. 三条绕行路都不通

```bash
cd /home/nihao/bioagentforge/tools/dsh-superagent

# D1. 关掉 github Source：注入会停，但 setup 仍要求仓库非空
grep -n "instance.enabled" src/sources/registry.ts
# 实测：3 行（79 / 88 / 130），其中与注入有关的是
#   88:      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
grep -n "resolveDeployment(machine" src/app/setup.ts
# 实测：64 行（checkAccounts）与 79 行（resolve）都无条件调用，不看 github Source 是否 enabled
grep -n "repositoryUnset" src/deployment.ts src/setup.ts
# 实测：src/deployment.ts:91:  if (!remote) throw new SetupError('repositoryUnset')
#       src/setup.ts:9:  repositoryUnset: ['github', 'The GitHub Source names no repository.']
# 运行时确认（编译产物调用 resolveDeployment，仓库传空串）：抛 SetupError，code 为 repositoryUnset。
# 即服务停在 setupPending，连 spv 也一起不工作。

# D2. 让 spv 声明同名变量：不覆盖，只并排出现两行
node --input-type=module -e "
import { environmentOf, environmentLines } from './src/app/execution-environment.ts'
const kind = (k, values) => ({ kind: k, environment: { variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: 'x', en: k } }], values: () => values }, config: {}, enabled: true })
const sources = { environments: () => [
  kind('github', { DSH_SUPERAGENT_GITHUB_REPOSITORY: 'nihaoWX/bioagentforge' }),
  kind('spv', { DSH_SUPERAGENT_GITHUB_REPOSITORY: 'nihaoWX/wheelchair-agent' })] }
const vars = environmentOf({ deployment: { repository: 'nihaoWX/bioagentforge' }, sources, settings: { executor: { blockedCommands: [] } }, ticket: { id: 't', name: 'n', directory: '/d' } })
console.log(environmentLines(vars))
"
# 实测：最后两行是
#   - DSH_SUPERAGENT_GITHUB_REPOSITORY = "nihaoWX/bioagentforge": github.
#   - DSH_SUPERAGENT_GITHUB_REPOSITORY = "nihaoWX/wheelchair-agent": spv.
#   同名两行并存，没有覆盖，也没有提示哪一行算数。

# D3. 编排器的 GitHub API 通道
grep -n "restricted to the configured repository" src/infra/commands.ts
# 实测：96:    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
```

### E. 工单工作副本的默认推送目标

```bash
cd /home/nihao/.dsh/state/superagent/work/wheelchair-pitfall-report-11821f08b06f
git remote -v
# 实测：origin /home/nihao/bioagentforge/tools/wheelchair-agent (fetch)
#       origin /home/nihao/bioagentforge/tools/wheelchair-agent (push)
#       即默认推送目标是本机路径，不是任何 GitHub 仓库。
```

### F. “没有 `.git`”与“有 `.git` 但没 remote”的分布

```bash
cd /home/nihao/bioagentforge

# F1. tools/：全部有 .git，但只有 3 个有 GitHub remote
for d in tools/*/; do
  n=$(basename "$d"); r=$(git -C "$d" remote get-url origin 2>/dev/null)
  [ -z "$r" ] && echo "no-remote: $n"
done | wc -l
# 实测：15（另有 1 个 remote 是本机路径、3 个是 GitHub；目录总数 19）

# F2. research/：6 个连 .git 都没有
for d in research/*/; do [ -d "$d/.git" ] || echo "no-git: $(basename "$d")"; done
# 实测：2026_08_16组图 / GSE279876 / gromacs-tests / tests / 姜黄素TNBC / 瘤内菌群组图

# F3. 而 research/ 是 local-only，不该被配上远端
grep -n "local-only" AGENTS.md
# 实测：71:- `research/` ... This repo is local-only — never push/upload it.
```

### G. worker 的交付契约与 AGENTS.md 的覆盖情况

```bash
cd /home/nihao/bioagentforge/tools/dsh-superagent

# G1. 默认要 PR，但任务可以显式要求别的交付物
grep -n "unless the assignment explicitly requests a different deliverable" prompts/work.md
# 实测：35:A code change without a PR is not ready unless the assignment explicitly requests a different deliverable.

# G2. research/ 一个 AGENTS.md 都没有
cd /home/nihao/bioagentforge
for d in research/*/; do [ -f "$d/AGENTS.md" ] && echo "has: $(basename "$d")"; done | wc -l
# 实测：0（research/ 共 11 个目录）

# G3. tools/ 里 18 个有、1 个没有，且 18 个内容完全相同
for d in tools/*/; do [ -f "$d/AGENTS.md" ] || echo "missing: $(basename "$d")"; done
# 实测：missing: dsh-superagent
md5sum tools/*/AGENTS.md | awk '{print $1}' | sort -u | wc -l
# 实测：1（18 份内容一致）

# G4. local-only 只写在根 AGENTS.md，worker 读不到
grep -n "local-only" AGENTS.md
# 实测：71（根 AGENTS.md；research/<task>/ 下没有任何副本）
```

## 建议

- 派发的任务应当能自己指明它属于哪个 GitHub 仓库，并且这个信息来自任务已经携带的项目路径，不需要操作者
  把仓库名手写进每个任务正文。
- 当项目路径推不出仓库时（本机 19 个项目里有 16 个如此），系统应当明确地报出来，而不是静默退回面板那一个
  仓库——静默退回正是这次推错仓库的原因。
- 面板里的仓库仍有实际职责（它决定监听哪个仓库的 Issues/PR），两者不应当互相静默覆盖；worker 应当能从
  环境里分辨“这个仓库是任务自己的”还是“这是兜底值”。
- 兜底发生时，这次派发的结果里应当留下可追溯的痕迹（哪个仓库是兜底来的），而不是让 worker 以为它就是
  任务的仓库。
- 任务自带的仓库必须对 worker 有明确的权威性：它非空时就是这张工单的仓库，并且这一点要在 worker 看得到的
  地方讲清楚。兜底值与真实答案不能以同一种形式出现——否则 worker 只能猜该信哪一个。
- 工单的工作副本应当已经指向正确的仓库，这样 worker 什么都不做、直接推送时，默认目标就是对的；而不是要它
  先自己判断、再自己改。
- 当项目确实需要远端、而当前没有时，系统应当能把它补齐——包括项目连版本库都还没有的情况——而不是让 worker
  在“没有出口”和“推到错误的仓库”之间二选一。补齐由派发侧自动完成即可，不必要求人先手工建好；但**只能建
  私有仓库**，不得创建任何公开可见的远端。
- 补齐远端会创建**外部状态**（一个真实存在的远端仓库），因此必须可追溯：仓库名、可见性、归属都要有确定的
  来源，失败时要说清是哪一步没成。
- 补齐必须尊重项目自身的性质：本机 `research/` 下的任务仓库被规定为只存在于本地、永不推送，这类项目
  **不应该**被自动配上远端。系统需要能区分“这个项目该有远端”和“这个项目不该有远端”，而不是对所有缺
  remote 的项目一视同仁。
- **每个工单的工作副本都应当自带一份与项目类型匹配的 `AGENTS.md`**，因为 worker 只读自己目录下的那一份，
  读不到工作区根目录的约定。项目类型不同，规则就不同（例如研究类项目只提交本地 commit、永不推送），所以
  不能只放一份通用文本。
- 这份 `AGENTS.md` 应当是**受管**的：缺失时自动补上，内容过期时自动更新为当前版本，而不是“有就不管”。
  否则旧副本会长期压过新规则，而 worker 无从知道自己读到的是过期的。
- 这份 `AGENTS.md` 的权威来源必须随工具一起安装到用户级位置，让派发侧能稳定找到它，而不是把某个开发树里
  的路径写死在派发逻辑里——否则换机器、换目录就会失效。
