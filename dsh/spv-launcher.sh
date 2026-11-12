#!/bin/sh
# SPV 启动器：用 SPV preset 起动 dsh-tui。
#
# 三件事，缺一不可：
#   1. --patch 传入 preset 声明：dsh-tui 0.19 的 preset 由 agent-preset registry 声明，
#      `~/.dsh/.agent-presets/spv/` 只是元数据目录，不会被自动发现。
#   2. DSH_TUI_PRESET=spv：新会话的 preset 优先级是「本次启动指令 > 持久化的 /preset 选择 > 部署默认 >
#      roster 默认」，而 registry 的 default 只能被 deployment 层设置。导出这个变量才能压过用户之前
#      在 /preset 里选过的别的 preset。
#   3. "$@" 透传：`spv --resume`、`spv /some/path` 等参数照常用。
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

DSH_TUI_PRESET=spv
export DSH_TUI_PRESET
exec dsh-tui --patch "$SPV_PATCH" "$@"
