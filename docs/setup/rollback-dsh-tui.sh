#!/usr/bin/env bash
# rollback-dsh-tui.sh — 把 dsh-tui / 全局 dsh 引擎回退到指定的一组版本
#
# 用途：/update（或 dsh-tui update）会把「profile 里的 tui、全局 dsh 引擎、全局启动器」
# 三层一起对齐到最新。如果 dsh 引擎的版本是特意选定的，被顺手升级后就用这个脚本回退。
#
# 用法（必须在“普通终端”里跑，不能在正在运行的 dsh-tui 会话里跑）：
#     bash docs/setup/rollback-dsh-tui.sh --check     # 只打印当前版本，不改动
#     bash docs/setup/rollback-dsh-tui.sh             # 默认回退到 tui 0.19.0 + dsh 0.2.1-rc.3
#     TUI_VERSION=0.20.1 DSH_VERSION=0.2.1-rc.3 bash docs/setup/rollback-dsh-tui.sh
#
# 为什么不能在正在运行的会话里跑：改掉磁盘上的 dsh 引擎后，正在运行的会话（旧 host）
# 每次起子进程都会到新版本目录里找 runner，host/runner 版本错位会立刻报
#     subprocess runner received an invalid Linux launch request
# 此时 bash / glob 等一切走 subprocess 的工具全部失效，只能退出会话再收尾。
#
# 为什么第一步要 chmod：新版 npm 默认门禁 install scripts，dsh 的 postinstall
# （@deepseek-ai/dsh-subprocess-local 的 ensure-spawn-helper.mjs）职责就是把
# node-pty prebuilds 里的 spawn-helper 补上可执行位。被跳过 → PTY / 终端起不来。

set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-dsh-tui}"
TUI_VERSION="${TUI_VERSION:-0.19.0}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.3}"
TUI_PKG="@deepseek-harness-tui/dsh-tui"
DSH_PKG="@deepseek-ai/dsh"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

current() {
  printf '  dsh 引擎      : %s\n' "$(dsh --version 2>&1 | tail -1)"
  printf '  profile 内 tui: %s\n' "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['dependencies'].get(sys.argv[2]))" \
      "$DSH_HOME/profiles/$PROFILE/package.json" "$TUI_PKG" 2>/dev/null || echo '(读不到)')"
  printf '  全局启动器    : %s\n' "$(dsh-tui --version 2>&1 | head -1)"
}

say "当前版本（目标：$TUI_PKG $TUI_VERSION / $DSH_PKG $DSH_VERSION）"
current

if [ "${1:-}" = "--check" ]; then
  echo
  echo "（--check：只查看，未做任何改动）"
  exit 0
fi

say "1/4 修复 node-pty 的 spawn-helper 执行位"
GLOBAL_ROOT="$(npm root -g)"
found=0
while IFS= read -r helper; do
  [ -n "$helper" ] || continue
  if chmod +x "$helper" 2>/dev/null; then
    echo "  chmod +x $helper"
    found=1
  fi
done < <(find "$GLOBAL_ROOT" \( -path '*node-pty/prebuilds/*/spawn-helper' \
                               -o -path '*node-pty/build/Release/spawn-helper' \) -type f 2>/dev/null)
[ "$found" = 1 ] || echo "  未找到 spawn-helper（布局不同或已可执行），继续"

say "2/4 把 profile 里的 tui 降到 $TUI_VERSION"
if ! dsh plugin --profile "$PROFILE" add "$TUI_PKG@$TUI_VERSION"; then
  cat <<EOF

!! 这一步失败了。如果报 invalid Linux launch request，说明 subprocess 层仍不可用，先执行：
     npm install -g --force \\
       --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \\
       $DSH_PKG@$DSH_VERSION
   然后重跑本脚本。
EOF
  exit 1
fi

say "3/4 对齐全局启动器到 $TUI_VERSION"
npm install -g --legacy-peer-deps "$TUI_PKG@$TUI_VERSION" || exit 1

say "4/4 校验"
current

cat <<EOF

完成。接下来：
  1) 重新启动 dsh-tui（不要用 /update，它会把 tui 顶回最新）。
  2) 若只想钉住引擎、不想每次回退：在 shell 里 export DSH_TUI_UPDATE_ENGINE=0。
EOF
