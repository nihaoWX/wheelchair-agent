#!/usr/bin/env python3
"""R4 的可跑证据 —— 「单一 CLI 入口 + src/ 三分」这一轮**实际跑过**的边界与入口契约。

R4 的结论是「布局要画出代码里已经存在的边界，并且这件事必须机械可查」，所以这里冻结的是**规则**，
不是文件清单（新增文件不该让证据变红，边界被破坏才该）：

族1 三条边界规则（R4-F2）：`src/superagent/` 与 `src/spv/` 互不 import；`bin/` 不 import
    `src/superagent/`；`src/` 与 `bin/` 不 import 任何 dsh 包。做法：直接跑 `tests/test-layout.sh`
    （它自己就是这三条规则的实现），断言 rc=0 且输出里有三条 PASS。
    这一族同时是 R4-F5 的复发证据：R1 的 test.py 曾因 `scripts/render-preset.mjs` 被移走而静默 SKIP，
    所以这里断言「测试脚本存在且真的跑了」，而不是「找不到就跳过」。
族2 exports 键名不变（R4-F4）：`package.json` 的 exports 键必须恰好是那六个，且每个指向的文件在
    HEAD 上存在。键名是公开 API（`~/.dsh/profiles/superagent/cordis.patch.yml` 用 bare specifier
    `wheelchair-agent/spv-watch` 引用它），改了会让 superagent 起不来。
族3 队列格式只有一份实现（R4-F3）：`scripts/spv_send.py` 与 `scripts/spv_read.py` 必须不存在，
    且 `bin/wheelchair-agent.mjs` 的 dispatch/result/status 走 import 而不是 spawn 一个队列脚本。
族4 面板值是命令名（R4-F1）：`install.sh` 打印的是 `wheelchair-agent prepare`，不是绝对路径；
    且 `--check` 读 `/proc/<pid>/environ` 而不是 `$PATH`。

契约：tools/pitfalls-manager/references/02_consume.md §4.3 —— 无参、退出码即结论、每族一行、
      只有 FAIL 给细节、跳过必须打出来并给原因、幂等、离线、不写仓库（只在 tempfile 里写）。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]                       # round-data/R4 → PITFALLS → docs → wheelchair-agent

FAILS = []
SKIPS = []

# exports 的键是公开 API；值可以随布局变，键不行。
EXPECTED_EXPORTS = ["./spv-watch", "./spv-tools", "./spv-cron-plugin", "./queue", "./spv", "./package.json"]


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def run(cmd, cwd=None, timeout=300):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


# --------------------------------------------------------------------------- #
# 族 1：三条边界规则（R4-F2，兼 R4-F5 的复发证据）
# --------------------------------------------------------------------------- #
def family1():
    script = REPO / "tests" / "test-layout.sh"
    need(script.is_file(),
         f"tests/test-layout.sh 不存在（{script}）：R4 把三条边界规则交给它机械断言，脚本没了这条约束就没人查。"
         f"这正是 R4-F5 记的那类失效——证据因路径漂移而静默消失，所以这里 FAIL 而不是 SKIP")
    done = run(["bash", str(script)], cwd=str(REPO))
    need(done.returncode == 0,
         f"tests/test-layout.sh expected rc=0, got rc={done.returncode}:\n"
         f"{(done.stdout + done.stderr).strip()[:800]}")
    for rule in ("rule 1", "rule 2", "rule 3"):
        need(rule in done.stdout,
             f"tests/test-layout.sh 的输出里没有 {rule} 的结论行，说明那条规则没有被真正检查：\n{done.stdout[:600]}")
    return "PASS", None


# --------------------------------------------------------------------------- #
# 族 2：exports 键名不变（R4-F4）
# --------------------------------------------------------------------------- #
def family2():
    manifest = REPO / "package.json"
    need(manifest.is_file(), f"package.json 不存在：{manifest}")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    exports = data.get("exports")
    need(isinstance(exports, dict), f"package.json 的 exports 不是对象：{exports!r}")
    need(sorted(exports) == sorted(EXPECTED_EXPORTS),
         f"exports 的键必须恰好是 {sorted(EXPECTED_EXPORTS)}，实际是 {sorted(exports)}。"
         f"键名是公开 API：~/.dsh/profiles/superagent/cordis.patch.yml 用 bare specifier "
         f"`wheelchair-agent/spv-watch` 引用它，改键名会让 superagent 起不来")
    for key, target in exports.items():
        need(isinstance(target, str) and target.startswith("./"),
             f"exports[{key!r}] 不是相对路径：{target!r}")
        need((REPO / target).is_file(),
             f"exports[{key!r}] 指向 {target}，但该文件在 HEAD 上不存在——键名对、文件搬走了")
    need("main" not in data,
         "package.json 还有 main 字段：删掉 index.js 之后它指向不存在的文件，"
         "`import 'wheelchair-agent'` 会注册一个 Source，那是个坑")
    return "PASS", None


# --------------------------------------------------------------------------- #
# 族 3：队列格式只有一份实现（R4-F3）
# --------------------------------------------------------------------------- #
def family3():
    for gone in ("scripts/spv_send.py", "scripts/spv_read.py"):
        need(not (REPO / gone).exists(),
             f"{gone} 又出现了：队列格式的两份实现必须永远保持字节兼容，这是个真隐患，"
             f"R4 已把它删掉、改由 CLI import src/spv/*.js")
    cli = REPO / "bin" / "wheelchair-agent.mjs"
    need(cli.is_file(), f"CLI 入口不存在：{cli}")
    text = cli.read_text(encoding="utf-8")
    for command in ("dispatch", "result", "status"):
        need(f"command{command.capitalize()}" in text or f"'{command}'" in text,
             f"bin/wheelchair-agent.mjs 里找不到 {command} 子命令")
    # 这三个子命令必须 import 队列实现，而不是 spawn 一个脚本去写队列。
    need(re.search(r"load\('src',\s*'spv',\s*'dispatch\.js'\)", text),
         "bin/wheelchair-agent.mjs 没有 import src/spv/dispatch.js：dispatch 子命令若 spawn 子进程，"
         "队列格式就又有两份实现了")
    need(re.search(r"load\('src',\s*'spv',\s*'outbox\.js'\)", text),
         "bin/wheelchair-agent.mjs 没有 import src/spv/outbox.js：result/status 子命令必须读同一份实现")
    return "PASS", None


# --------------------------------------------------------------------------- #
# 族 4：面板值是命令名，且校验的是服务进程的 PATH（R4-F1）
# --------------------------------------------------------------------------- #
def family4():
    install = REPO / "install.sh"
    need(install.is_file(), f"install.sh 不存在：{install}")
    text = install.read_text(encoding="utf-8")
    need("wheelchair-agent prepare" in text,
         "install.sh 没有打印 `wheelchair-agent prepare`：面板值必须是命令名，"
         "绝对路径是机器相关状态，换 DSH_HOME 或用户名后会静默失效")
    need("/proc/$pid/environ" in text or "/proc/${pid}/environ" in text,
         "install.sh 没有读 /proc/<pid>/environ：$PATH 不是服务进程的 PATH，"
         "面板命令由 superagent 服务执行，只有服务进程的环境能回答它能不能解析到 wheelchair-agent")
    need("wheelchair-agent" in text and "render_cli" in text,
         "install.sh 没有安装 wheelchair-agent CLI 薄壳（render_cli）")
    for wrapper in ("service", "jobctl"):
        need(f"render_wrapper \"$1\" {wrapper}" in text or f"render_{wrapper}_wrapper" in text,
             f"install.sh 没有把 {wrapper} 装成 `exec wheelchair-agent {wrapper}` 的兼容名")
    return "PASS", None


FAMILIES = [
    ("族1 the three layout rules hold, asserted by tests/test-layout.sh (R4-F2, recurrence of R4-F5)", family1),
    ("族2 package.json exports keys are unchanged and their targets exist (R4-F4)", family2),
    ("族3 the queue format has one implementation: no Python scripts, CLI imports src/spv (R4-F3)", family3),
    ("族4 the panel value is the command name and the service PATH is what gets checked (R4-F1)", family4),
]


def main():
    for label, fn in FAMILIES:
        try:
            verdict, reason = fn()
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
            print(f"      原因：{reason}")
            SKIPS.append(label)
        else:
            print(f"PASS  {label}")
    if FAILS:
        print(f"\n== {len(FAILS)} families do not hold ==")
        for f in FAILS:
            print("  · " + f)
        return 1
    print("\n== 全部成立 ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
