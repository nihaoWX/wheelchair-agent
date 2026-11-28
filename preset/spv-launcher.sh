#!/bin/sh
# SPV 启动器：薄壳。
#   `wheelchair-agent spv` 是整台机器唯一的 SPV 会话。它启动每份已注册部署的后端，自己不带任何部署身份。
#   - 由 `wheelchair-agent spv` 作为受监督子进程拉起时（WHEELCHAIR_AGENT_SUPERVISED=1），这里只 exec dsh-tui。
#   - 直接敲 `spv` 时，这里只 exec `wheelchair-agent spv`，由 CLI 做注册表解析、后端启动和会话监督。
#   本脚本不解析部署、不管理服务、不导出队列/状态目录；装饰参数（preset patch、DSH_TUI_PRESET、
#   DSH_TUI_PROFILE）在这里设置。SPV 会话使用自建的 wca-spv-tui profile；该 profile 尚未安装时回退到
#   dsh 自带的 dsh-tui，并打印一行提示，绝不因此启动失败。
#
# SPV_PRESET_HOME 的值由安装器烧进来（占位符替换），所以这个脚本可以放在 PATH 上任意位置，
# 也可以在没有 bioagentforge 源码树的机器上运行。
set -eu

SPV_PRESET_HOME='@SPV_HOME@'
SPV_PATCH="$SPV_PRESET_HOME/preset-default.patch.yml"

if [ ! -f "$SPV_PATCH" ]; then
  echo "FAIL: the SPV preset declaration is missing at $SPV_PATCH" >&2
  echo "fix: reinstall the preset with: bash <bioagentforge>/tools/wheelchair-agent/install.sh" >&2
  exit 1
fi

# A browser SPV surface hands over to the CLI once, from the environment, without parsing settings here.
# `wheelchair-agent spv` then runs the wca-spv-web host (and, in the terminal case, the branch below).
if [ "${WHEELCHAIR_AGENT_SPV_SURFACE:-}" = "web" ]; then
  if ! command -v wheelchair-agent >/dev/null 2>&1; then
    echo 'FAIL: WHEELCHAIR_AGENT_SPV_SURFACE=web needs the wheelchair-agent CLI on PATH.' >&2
    echo 'fix: install it with: bash <checkout>/install.sh --project <project>' >&2
    exit 1
  fi
  exec wheelchair-agent spv "$@"
fi

# Two entry points, one implementation:
#   - `wheelchair-agent spv` runs this script as its supervised child (WHEELCHAIR_AGENT_SUPERVISED=1). The CLI
#     already started every registered backend, so the launcher only execs dsh-tui; anything else would recurse
#     back into `wheelchair-agent spv`.
#   - typing `spv` directly must work: the script becomes a thin shell around `wheelchair-agent spv`, which owns
#     registry resolution and backend start; the session itself has no deployment identity.
if [ "${WHEELCHAIR_AGENT_SUPERVISED:-}" = "1" ]; then
  DSH_TUI_PRESET=spv
  export DSH_TUI_PRESET
  DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
  if [ -d "$DSH_HOME_DIR/profiles/wca-spv-tui" ]; then
    DSH_TUI_PROFILE=wca-spv-tui
    export DSH_TUI_PROFILE
  else
    echo "note: profile wca-spv-tui is missing; falling back to the dsh-tui profile (run install.sh to create it)" >&2
  fi
  exec dsh-tui --patch "$SPV_PATCH" "$@"
fi

if command -v wheelchair-agent >/dev/null 2>&1; then
  exec wheelchair-agent spv "$@"
fi

echo 'FAIL: neither wheelchair-agent nor a supervised dsh-tui launch is available.' >&2
echo 'fix: run "wheelchair-agent spv" (install the CLI with: bash <checkout>/install.sh --project <project>)' >&2
exit 1
