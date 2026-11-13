#!/usr/bin/env python3
"""R1 的可跑证据 —— 「SPV 遇上游 API error 不重试」这一轮**实际查证过**的重试链路。

R1 的结论是「链路是通的，根因未证」，所以这里只冻结**已证**的三段，不冻结根因：

族1 SPV 组合里 `dsh-llm-retry` 已挂载且未被 disabled（R1-F1）。
    做法：用本仓库的 `scripts/render-preset.mjs` 把 `dsh/` 渲染进临时目录，再
    `dsh --profile dsh-tui --patch <渲染出的 patch> --dump-config`，在组合树里找 `- id: llm-retry`。
    同时断言同一份 dump 里有 `spv-tools`——否则 patch 没生效，这条断言就是空的（拿普通 profile 的
    dump 也能绿）。
族2 commandcode provider 声明了重试策略：`mode: normal`、`maxRetries: 1000`、白名单恰好是
    `EMPTY_RESPONSE / RATE_LIMIT / THROTTLED / SERVER / TIMEOUT / TRANSPORT`（R1-F1）。
    做法：调 provider 的**公开方法** `providerRetryPolicy()`（`index.d.ts` 里声明的那一个），
    不读它的 bundle 文本。白名单「恰好」是这六个码，是因为 R1 的结论依赖「`RATE_LIMITED` 不在里面」
    ——多一个码就说明这条结论要重判。
族3 worker 侧另有自己的重试：`TRANSIENT_TRIES = 3`、15s 退避、认 408/429/5xx 与 ECONNRESET 等
    （R1-F1 里「worker 不受影响」的依据）。
    做法：调兄弟项目 `tools/dsh-superagent/src/executor/dsh.ts` 导出的 `transient()`，逐个喂
    408/429/500/503/ECONNRESET/ETIMEDOUT（应 True）与 400/404/无效凭据（应 False）——这是**行为**
    断言，不是读文本。次数与退避是常量、没有可调用的出口，那两条只能读源码文本（族名已说明）。
    文件不存在 ⇒ SKIP（兄弟项目可能被移走，那不等于本约束破了）。

契约：tools/pitfalls-manager/references/02_consume.md §4.3 —— 无参、退出码即结论、每族一行、
      只有 FAIL 给细节、跳过必须打出来并给原因、幂等、离线、不写仓库（只在 tempfile 里写）。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]                       # round-data/R1 → PITFALLS → docs → wheelchair-agent
PROFILE = Path.home() / ".dsh" / "profiles" / "dsh-tui"
PROVIDER = PROFILE / "node_modules" / "@mars-sea" / "dsh-commandcode-provider"

# worker 侧重试的出处：兄弟项目 `tools/dsh-superagent`。工单目录是它的 clone，兄弟项目不在旁边，
# 所以再退到 superagent profile 里那条 link（它指向同一个开发树）。
SUPERAGENT_CANDIDATES = [
    REPO.parent / "dsh-superagent",
    Path.home() / ".dsh" / "profiles" / "superagent" / "node_modules" / "dsh-superagent",
]

FAILS = []
SKIPS = []

# R1 查证时白名单就是这六个码；`RATE_LIMITED` 不在其中，这正是「根因可能是 code 不在白名单」的依据。
EXPECTED_CODES = ["EMPTY_RESPONSE", "RATE_LIMIT", "THROTTLED", "SERVER", "TIMEOUT", "TRANSPORT"]


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def run(cmd, cwd=None, timeout=180):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def entry_block(text, entry_id):
    """从 `--dump-config` 的文本里取出 `- id: <entry_id>` 那一条（含其缩进更深的子键）。

    不解析 YAML：dump 里带 `!!js` 标签，safe_load 读不了；这里只按缩进切块。
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)- id:\s*" + re.escape(entry_id) + r"\s*$", line)
        if not m:
            continue
        indent = len(m.group(1))
        block = [line]
        for nxt in lines[i + 1:]:
            m2 = re.match(r"^(\s*)- id:", nxt)
            if m2 and len(m2.group(1)) <= indent:
                break
            if nxt.strip() and (len(nxt) - len(nxt.lstrip())) < indent:
                break
            block.append(nxt)
        return "\n".join(block)
    return None


# --------------------------------------------------------------------------- #
# 族 1：SPV 组合里 llm-retry 已挂载、未 disabled（R1-F1）
# --------------------------------------------------------------------------- #
def family1():
    dsh, node = shutil.which("dsh"), shutil.which("node")
    if not dsh or not node:
        return "SKIP", "dsh 或 node 不在 PATH 上（这条断言要跑 `dsh --dump-config`）"
    if not (REPO / "scripts" / "render-preset.mjs").is_file():
        return "SKIP", f"渲染脚本不存在：{REPO / 'scripts' / 'render-preset.mjs'}"
    root = tempfile.mkdtemp(prefix="r1-f1-")
    try:
        out = Path(root) / "preset"
        render = run([node, str(REPO / "scripts" / "render-preset.mjs"), str(REPO / "dsh"),
                      "file:///dev/null/spv-tools.js", "file:///dev/null/spv-cron-plugin.js", str(out)])
        need(render.returncode == 0,
             f"`render-preset.mjs` expected rc=0, got rc={render.returncode}: {render.stderr.strip()[:400]}")
        patch = out / "preset-default.patch.yml"
        need(patch.is_file(), f"render-preset.mjs 没有写出 {patch}")

        dump = run([dsh, "--profile", "dsh-tui", "--patch", str(patch), "--dump-config"])
        need(dump.returncode == 0,
             f"`dsh --dump-config` expected rc=0, got rc={dump.returncode}: {dump.stderr.strip()[:400]}")
        text = dump.stdout

        # 先证明这份 dump 真的是 SPV 组合：patch 没生效的话，下面那条断言拿普通 profile 也能绿。
        need(entry_block(text, "spv-tools") is not None,
             "the dump does not contain the SPV preset's `spv-tools` entry, so the patch did not apply and "
             "the llm-retry assertion below would be vacuous (it would pass on the plain profile too)")

        block = entry_block(text, "llm-retry")
        need(block is not None,
             "the composed config has no `- id: llm-retry` entry: dsh-llm-retry is not mounted, so the retry "
             "chain R1 recorded as intact is gone (check the dsh-base bundle in the dsh-tui profile)")
        need("'@deepseek-ai/dsh-llm-retry'" in block or '"@deepseek-ai/dsh-llm-retry"' in block,
             f"the llm-retry entry does not name @deepseek-ai/dsh-llm-retry: {block!r}")
        disabled = [line.strip() for line in block.splitlines() if re.match(r"^\s*disabled:", line)]
        need(not disabled,
             f"the llm-retry entry is disabled ({disabled!r}): R1 recorded it as mounted **and not disabled**, "
             f"so a retry chain that is switched off is a different finding — re-check R1-F1 before trusting it")
        return "PASS", None
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------- #
# 族 2：provider 的重试策略（R1-F1）
# --------------------------------------------------------------------------- #
def family2():
    node = shutil.which("node")
    if not node:
        return "SKIP", "node 不在 PATH 上（这条断言要调 provider 的公开方法）"
    if not PROVIDER.is_dir():
        return "SKIP", f"provider 未安装：{PROVIDER}"
    dsh = shutil.which("dsh")
    if not dsh:
        return "SKIP", "dsh 不在 PATH 上（要从它的安装树里找 @deepseek-ai/dsh-llm 给 provider 解析依赖）"
    # `dsh` 是 bin 软链，真身是 <包根>/lib/bin.js；包根下的 node_modules 才是 provider 依赖的所在。
    real = Path(os.path.realpath(dsh))
    pkg_root = real.parent.parent if real.parent.name == "lib" else real.parent
    scope = pkg_root / "node_modules" / "@deepseek-ai"
    if not scope.is_dir():
        return "SKIP", f"找不到 dsh 安装树里的 @deepseek-ai 作用域：{scope}"

    root = tempfile.mkdtemp(prefix="r1-f2-")
    try:
        # provider 的依赖（@deepseek-ai/dsh-llm 等）在 dsh 的安装树里，不在 profile 的 node_modules 下；
        # 用 --preserve-symlinks 让 provider 从临时目录解析，从而同时看见两边。
        nm = Path(root) / "node_modules"
        (nm / "@mars-sea").mkdir(parents=True)
        (nm / "@mars-sea" / "dsh-commandcode-provider").symlink_to(PROVIDER)
        (nm / "@deepseek-ai").symlink_to(scope)
        script = (
            "const m = await import('@mars-sea/dsh-commandcode-provider');\n"
            "const A = m.CommandCodeAdapter;\n"
            "if (typeof A?.prototype?.providerRetryPolicy !== 'function') { console.log('NO_METHOD'); process.exit(0) }\n"
            "const p = A.prototype.providerRetryPolicy.call({}, 'commandcode');\n"
            "console.log(JSON.stringify(p));\n"
        )
        r = run([node, "--preserve-symlinks", "--preserve-symlinks-main", "--input-type=module", "-e", script],
                cwd=root)
        need(r.returncode == 0,
             f"importing the provider and calling providerRetryPolicy() expected rc=0, got rc={r.returncode}: "
             f"{(r.stderr or r.stdout).strip()[:500]}")
        out = r.stdout.strip()
        need(out != "NO_METHOD",
             "CommandCodeAdapter has no providerRetryPolicy(): the provider no longer declares a retry policy, "
             "so R1's 'the chain is intact' no longer holds")
        policy = json.loads(out)
        need(policy.get("mode") == "normal",
             f"providerRetryPolicy().mode expected 'normal', got {policy.get('mode')!r} — R1 recorded normal mode "
             f"(an `always` policy would mean someone already took the profile-level escape route)")
        need(policy.get("maxRetries") == 1000,
             f"providerRetryPolicy().maxRetries expected 1000, got {policy.get('maxRetries')!r}")
        codes = policy.get("retryableCodes")
        need(isinstance(codes, list),
             f"providerRetryPolicy().retryableCodes expected a list, got {codes!r}")
        need(sorted(codes) == sorted(EXPECTED_CODES),
             f"providerRetryPolicy().retryableCodes expected exactly {EXPECTED_CODES}, got {codes!r}. "
             f"R1's conclusion depends on this exact set: `RATE_LIMITED` is a code the provider itself emits and "
             f"it is absent here, which is why the root cause was left unconfirmed — a changed set means that "
             f"judgement must be redone")
        return "PASS", None
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------- #
# 族 3：worker 侧自己的重试（R1-F1 的对照事实）
# --------------------------------------------------------------------------- #
def family3():
    node = shutil.which("node")
    if not node:
        return "SKIP", "node 不在 PATH 上（这条断言要调 transient()）"
    src = next((p / "src" / "executor" / "dsh.ts" for p in SUPERAGENT_CANDIDATES
                if (p / "src" / "executor" / "dsh.ts").is_file()), None)
    if src is None:
        return "SKIP", ("兄弟项目 tools/dsh-superagent 的源码不在（找过 "
                        + "、".join(str(p) for p in SUPERAGENT_CANDIDATES)
                        + "）；worker 侧重试无从断言，不等于本约束破了")

    # 行为断言：`transient()` 是导出的，直接调它，看哪些错误被判为可重试。
    script = (
        "const m = await import(process.argv[1]);\n"
        "if (typeof m.transient !== 'function') { console.log('NO_FN'); process.exit(0) }\n"
        "const cases = [\n"
        "  ['status408', { status: 408 }], ['status429', { status: 429 }],\n"
        "  ['status500', { status: 500 }], ['status503', { status: 503 }],\n"
        "  ['status400', { status: 400 }], ['status404', { status: 404 }],\n"
        "  ['econnreset', new Error('read ECONNRESET')],\n"
        "  ['etimedout', new Error('connect ETIMEDOUT')],\n"
        "  ['plain', new Error('invalid credential')],\n"
        "];\n"
        "console.log(JSON.stringify(Object.fromEntries(cases.map(([k, v]) => [k, m.transient(v)]))));\n"
    )
    r = run([node, "--experimental-transform-types", "--input-type=module", "-e", script, src.as_uri()],
            cwd=str(src.parent))
    need(r.returncode == 0,
         f"importing src/executor/dsh.ts and calling transient() expected rc=0, got rc={r.returncode}: "
         f"{(r.stderr or r.stdout).strip()[:500]}")
    out = r.stdout.strip()
    need(out != "NO_FN",
         "src/executor/dsh.ts no longer exports transient(): the worker-side retry matcher R1 recorded has no "
         "callable form, so 'the worker was unaffected' can no longer be checked")
    verdicts = json.loads(out)
    for key in ("status408", "status429", "status500", "status503", "econnreset", "etimedout"):
        need(verdicts.get(key) is True,
             f"transient({key}) expected True: R1 recorded the worker side as retrying 408/429/5xx and "
             f"ECONNRESET/ETIMEDOUT, which is why the worker was unaffected by the SPV path's behaviour. "
             f"Got {verdicts.get(key)!r}")
    for key in ("status400", "status404", "plain"):
        need(verdicts.get(key) is False,
             f"transient({key}) expected False: a permanent failure must surface immediately instead of being "
             f"retried, otherwise the worker would loop on an invalid credential. Got {verdicts.get(key)!r}")

    # 次数与退避是常量，没有可调用的出口；只断言它们还在（族名已说明这一半是文本断言）。
    text = src.read_text(encoding="utf-8", errors="replace")
    need(re.search(r"TRANSIENT_TRIES\s*=\s*3\b", text),
         "src/executor/dsh.ts no longer declares TRANSIENT_TRIES = 3: R1 recorded the worker side as retrying "
         "3 times")
    need(re.search(r"TRANSIENT_BACKOFF_MS\s*=\s*15_000\b", text),
         "src/executor/dsh.ts no longer declares TRANSIENT_BACKOFF_MS = 15_000: R1 recorded a 15s initial backoff")
    return "PASS", None


FAMILIES = [
    ("族1 SPV composition mounts dsh-llm-retry and does not disable it (R1-F1)", family1),
    ("族2 commandcode provider declares normal/1000 and exactly the six retryable codes (R1-F1)", family2),
    ("族3 worker side keeps its own retry: 3 tries, 15s backoff, 408/429/5xx + ECONNRESET (R1-F1)", family3),
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
