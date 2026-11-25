#!/bin/sh
# SPV 启动器：确保 superagent 服务在跑，然后用 SPV preset 起动 dsh-tui。
#
# 四件事：
#   1. 拉起 superagent 服务（幂等）：它不会自己启动，也不会跟随 dsh-tui 启动，而 SPV 派出的每个任务都靠它执行。
#      已在运行时 `start` 立刻返回，所以每次启动都调它是安全的。
#   2. --patch 传入 preset 声明：dsh-tui 0.19 的 preset 由 agent-preset registry 声明，
#      `~/.dsh/.agent-presets/spv/` 只是元数据目录，不会被自动发现。
#   3. DSH_TUI_PRESET=spv：新会话的 preset 优先级是「本次启动指令 > 持久化的 /preset 选择 > 部署默认 >
#      roster 默认」，而 registry 的 default 只能被 deployment 层设置。导出这个变量才能压过用户之前
#      在 /preset 里选过的别的 preset。
#   4. "$@" 透传：`spv --resume`、`spv /some/path` 等参数照常用。
#
# 服务起不来时**不**阻止会话打开：SPV 仍然可以查队列、看状态，而且报错信息在会话里更容易看清。
# 但一定会往 stderr 喊一声，绝不静默——一个没有后端的 SPV 看起来正常，派出去的任务却永远不执行。
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

# 确保后端在跑。status 的退出码语义：0 正常、1 未运行或不健康、2 组件报错、3 等 setup。
# 只有 0 才跳过 start；其余都试一次 start，让脚本自己决定能不能救回来。
#
# 这里故意不写 --project：`wheelchair-agent spv` 会把本部署的 SPV_QUEUE_DIR 导出给本脚本，CLI 用它
# 认出"我属于哪份部署"，裸 status/start 就落在自己那份实例上（`#48` 起没有无 project 的基服务）。
# 因此直接 `spv` 调用（没有 SPV_QUEUE_DIR）时只能报告"不知道属于哪份部署"，不会去猜。
#
# 优先用 `wheelchair-agent service`（规范形式），退回 `superagent-service`（兼容名）：两者是同一个
# 实现，但只有前者在 CLI 装好时一定存在，而本脚本也可能被单独调用。
ensure_service() {
  if command -v wheelchair-agent >/dev/null 2>&1; then
    SERVICE_CMD='wheelchair-agent service'
  elif command -v superagent-service >/dev/null 2>&1; then
    SERVICE_CMD='superagent-service'
  else
    echo 'warning: neither wheelchair-agent nor superagent-service is on PATH, so the backend was not started.' >&2
    echo 'warning: tasks dispatched from this session will fail until it is running.' >&2
    echo 'warning: install it with: bash <bioagentforge>/tools/wheelchair-agent/install.sh' >&2
    return 0
  fi

  if $SERVICE_CMD status >/dev/null 2>&1; then
    return 0
  fi

  echo 'superagent: starting the backend...' >&2
  if $SERVICE_CMD start >/dev/null 2>&1; then
    echo 'superagent: ready' >&2
    return 0
  fi

  echo 'warning: superagent did not start, so no task dispatched here would run.' >&2
  if [ -n "${SPV_QUEUE_DIR:-}" ]; then
    echo "warning: diagnose with \"$SERVICE_CMD status\", then restart this session." >&2
  else
    echo 'warning: this launcher does not know which deployment it belongs to, so it could not name one.' >&2
    echo 'warning: start the session with "wheelchair-agent spv --project <p>" instead of running this script directly.' >&2
  fi
  return 0
}

ensure_service

DSH_TUI_PRESET=spv
export DSH_TUI_PRESET
exec dsh-tui --patch "$SPV_PATCH" "$@"
