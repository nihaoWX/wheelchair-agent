#!/usr/bin/env python3
"""R2 的可跑证据 —— 「交付目标随项目走」这一轮**实测过**的项目分布与三条堵死的绕行路。

R2 的结论是「配置层消不掉这个单值，方向定为给 worker 一份受管的 AGENTS.md」，所以这里冻结的是
**当时实测的事实**，不是那个还没实现的修法：

族1 项目分布（R2-F1 的核心实测）：`tools/` 下每个目录都有自己的 `.git`（「一个工具一个仓库」是
    「交付目标能随项目走」的前提）；`research/` 下**没有任何目录**带 GitHub remote（根 AGENTS.md
    规定 research 是 local-only）。族名里带上实测计数，所以数字变了也看得见——但断言的是**规则**，
    不是那天的数字（建仓会让计数变，不该因此变红）。
族2 三条绕行路里的两条（R2-F1）：`deployment.ts` 在仓库为空时抛 `repositoryUnset`（关掉 github
    Source 也停不下来）；`commands.ts` 把编排器的 GitHub 调用锁在配置仓库上。第三条（同名变量
    不覆盖）在族3。
族3 同名变量不覆盖、只并排渲染两行（R2-F1）：调 `environmentLines()` 传两个同键变量，断言输出
    两行、两行都带该键。这是「让 spv 声明同名变量」那条路走不通的机械依据。
族4 已定方向的材料还在（R2-F1）：`docs/delivery-target.md` 记着方向，两份模板都在，研究任务模板的
    `GIT` 一节明写 local-only。

族1 / 族2 / 族3 要读本机上的兄弟目录（`bioagentforge` 根、`tools/dsh-superagent`），工单目录是
wheelchair-agent 的 clone、旁边没有它们 ⇒ 那时打 SKIP 并给原因，不当成功也不当失败。

契约：tools/pitfalls-manager/references/02_consume.md §4.3 —— 无参、退出码即结论、每族一行、
      只有 FAIL 给细节、跳过必须打出来并给原因、幂等、离线、不写仓库（本目录只读，不落盘）。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]                       # round-data/R2 → PITFALLS → docs → wheelchair-agent
TEMPLATES = REPO / "docs" / "agentsmd-examples"
DELIVERY = REPO / "docs" / "delivery-target.md"

FAILS = []


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def run(cmd, cwd=None, timeout=180):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def bioagentforge_root():
    """本机 bioagentforge 根：`tools/<name>` 的上一级。

    工单目录是 `git clone <本地路径>` 出来的，所以 origin 指向真实项目；从它反推根，clone 里也能测。
    """
    if REPO.parent.name == "tools":
        return REPO.parents[1]
    r = run(["git", "-C", str(REPO), "remote", "get-url", "origin"])
    if r.returncode == 0:
        url = r.stdout.strip()
        if url and "://" not in url and not url.startswith("git@"):
            p = Path(url)
            if p.parent.name == "tools":
                return p.parents[1]
    return None


def superagent_source():
    """兄弟项目 `tools/dsh-superagent` 的源码树；工单 clone 里退到 superagent profile 的 link。"""
    for cand in (REPO.parent / "dsh-superagent",
                 Path.home() / ".dsh" / "profiles" / "superagent" / "node_modules" / "dsh-superagent"):
        if (cand / "src" / "deployment.ts").is_file():
            return cand
    return None


def own_git(d):
    return (d / ".git").exists()


def origin_url(d):
    r = run(["git", "-C", str(d), "remote", "get-url", "origin"])
    return r.stdout.strip() if r.returncode == 0 else ""


def is_github(url):
    return "github.com" in url


# --------------------------------------------------------------------------- #
# 族 1：项目分布（R2-F1）
# --------------------------------------------------------------------------- #
def family1():
    root = bioagentforge_root()
    if root is None or not (root / "tools").is_dir() or not (root / "research").is_dir():
        return "SKIP", ("找不到本机 bioagentforge 根（tools/ 与 research/ 的上一级）；工单 clone 里没有它，"
                        "项目分布无从测量——这不是分布变了")
    tools = sorted(d for d in (root / "tools").iterdir() if d.is_dir())
    research = sorted(d for d in (root / "research").iterdir() if d.is_dir())

    no_git = [d.name for d in tools if not own_git(d)]
    need(not no_git,
         f"tools/ 下这些目录没有自己的 .git：{no_git}。R2 的实测是 19/19 都有——「一个工具一个仓库」"
         f"是「交付目标能随项目走」的前提，缺了它这个项目连本地版本库都没有")

    tools_github = [d.name for d in tools if own_git(d) and is_github(origin_url(d))]
    tools_local = [d.name for d in tools if own_git(d) and origin_url(d) and not is_github(origin_url(d))]
    tools_none = [d.name for d in tools if own_git(d) and not origin_url(d)]

    research_github = [d.name for d in research if own_git(d) and is_github(origin_url(d))]
    need(not research_github,
         f"research/ 下这些目录带了 GitHub remote：{research_github}。根 AGENTS.md 规定 research/ 是 "
         f"local-only、永不推送——R2 实测 0/11 有 GitHub remote，出现一个就是违反那条规则")

    research_no_git = [d.name for d in research if not own_git(d)]
    research_no_agents = [d.name for d in research if not (d / "AGENTS.md").is_file()]
    # 族名自带实测计数：数字变了看得见，但断言的是规则（见 docstring）。
    label = (f"族1 project distribution: tools {len(tools)} dirs, {len(tools) - len(no_git)} with .git, "
             f"{len(tools_github)} GitHub / {len(tools_local)} local-path / {len(tools_none)} no remote; "
             f"research {len(research)} dirs, {len(research) - len(research_no_git)} with .git, "
             f"{len(research_github)} GitHub remote, {len(research_no_agents)} without AGENTS.md (R2-F1)")
    return "PASS", label


# --------------------------------------------------------------------------- #
# 族 2：三条绕行路里的两条（R2-F1）
# --------------------------------------------------------------------------- #
def family2():
    src = superagent_source()
    if src is None:
        return "SKIP", ("找不到兄弟项目 tools/dsh-superagent 的源码（工单 clone 里没有它）；"
                        "两条绕行路无从断言，不等于它们通了")
    deployment = (src / "src" / "deployment.ts").read_text(encoding="utf-8", errors="replace")
    commands = (src / "src" / "infra" / "commands.ts").read_text(encoding="utf-8", errors="replace")

    need(re.search(r"if\s*\(\s*!remote\s*\)\s*throw new SetupError\(\s*['\"]repositoryUnset['\"]", deployment),
         "src/deployment.ts no longer throws SetupError('repositoryUnset') when the repository is empty: "
         "R2 measured that turning the github Source off still leaves setup at setupPending, so the "
         "single-value repository cannot be avoided by disabling the Source")
    need("GitHub calls are restricted to the configured repository" in commands,
         "src/infra/commands.ts no longer restricts GitHub calls to the configured repository: R2 measured "
         "that the orchestrator cannot watch a second repository, which is the second blocked escape route")
    return "PASS", None


# --------------------------------------------------------------------------- #
# 族 3：同名变量不覆盖，只并排渲染两行（R2-F1）
# --------------------------------------------------------------------------- #
def family3():
    node = shutil.which("node")
    if not node:
        return "SKIP", "node 不在 PATH 上（这条断言要调 environmentLines()）"
    src = superagent_source()
    if src is None:
        return "SKIP", ("找不到兄弟项目 tools/dsh-superagent 的源码（工单 clone 里没有它）；"
                        "同名变量的渲染规则无从断言")
    module = src / "src" / "app" / "execution-environment.ts"
    need(module.is_file(), f"src/app/execution-environment.ts 不存在：{module}")
    # 行为断言：传两个同键变量，看渲染出几行。不读实现文本——实现怎么改都行，只要行为还是「两行」。
    script = (
        "const m = await import(process.argv[1]);\n"
        "const lines = m.environmentLines([\n"
        "  { key: 'DSH_X', value: 'from-spv', description: { en: 'first', zh: '一' }, owner: 'spv' },\n"
        "  { key: 'DSH_X', value: 'from-github', description: { en: 'second', zh: '二' }, owner: 'github' },\n"
        "]);\n"
        "console.log(JSON.stringify(lines));\n"
    )
    r = run([node, "--experimental-strip-types", "--input-type=module", "-e", script, module.as_uri()],
            cwd=str(src))
    need(r.returncode == 0,
         f"importing execution-environment.ts and calling environmentLines() expected rc=0, got rc={r.returncode}: "
         f"{(r.stderr or r.stdout).strip()[:500]}")
    lines = json.loads(r.stdout.strip())
    need(isinstance(lines, str), f"environmentLines() expected a string, got {lines!r}")
    rendered = [line for line in lines.splitlines() if line.strip()]
    need(len(rendered) == 2,
         f"two variables with the same key expected **two** rendered lines (no override), got {len(rendered)}: "
         f"{rendered!r}. R2 measured that a Source declaring a same-named variable does not override the "
         f"deployment's value — it only renders a second line, so the worker cannot tell which one counts")
    need(all("DSH_X" in line for line in rendered),
         f"both rendered lines expected to carry the key DSH_X, got {rendered!r}")
    need("from-spv" in rendered[0] and "from-github" in rendered[1],
         f"the two lines expected to keep both values in order, got {rendered!r}")
    return "PASS", None


# --------------------------------------------------------------------------- #
# 族 4：已定方向的材料还在（R2-F1）
# --------------------------------------------------------------------------- #
def family4():
    need(DELIVERY.is_file(), f"docs/delivery-target.md 不存在：{DELIVERY}")
    text = DELIVERY.read_text(encoding="utf-8", errors="replace")
    need("AGENTS.md" in text and "受管" in text,
         "docs/delivery-target.md no longer records the settled direction (a managed AGENTS.md telling the "
         "worker whether this project should be pushed): R2's finding is a suggestion whose value is that "
         "decision record — if the direction changed, the ledger entry must change with it")
    for name in ("proj-dev-agentsmd.md", "research-task-agentsmd.md"):
        need((TEMPLATES / name).is_file(),
             f"docs/agentsmd-examples/{name} is missing: it is the prepared material of the settled direction")
    research = (TEMPLATES / "research-task-agentsmd.md").read_text(encoding="utf-8", errors="replace")
    need(re.search(r"local-only", research) and re.search(r"never push", research),
         "docs/agentsmd-examples/research-task-agentsmd.md no longer says research/ is local-only / never "
         "pushed: that clause is the whole point of the research template (the root AGENTS.md rule the "
         "worker cannot read from its cwd)")
    return "PASS", None


FAMILIES = [
    ("族1 project distribution (R2-F1)", family1),
    ("族2 the two blocked escape routes: repositoryUnset + one-repository API (R2-F1)", family2),
    ("族3 same-named variables render as two lines, never override (R2-F1)", family3),
    ("族4 the settled direction's material is present (R2-F1)", family4),
]


def main():
    for label, fn in FAMILIES:
        try:
            verdict, detail = fn()
        except AssertionError as e:
            print(f"FAIL  {label}")
            print("      " + str(e).replace("\n", "\n      ")[:900])
            FAILS.append(label)
            continue
        except Exception as e:                  # 断言里抛异常也算 FAIL，不静默
            print(f"FAIL  {label}")
            print(f"      exception: {e!r}"[:900])
            FAILS.append(label)
            continue
        if verdict == "SKIP":
            print(f"SKIP  {label}")
            print(f"      原因：{detail}")
        else:
            # 族1 的族名自带实测计数；其余族用固定标签。
            print(f"PASS  {detail or label}")
    if FAILS:
        print(f"\n== {len(FAILS)} families do not hold ==")
        for f in FAILS:
            print("  · " + f)
        return 1
    print("\n== 全部成立 ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
