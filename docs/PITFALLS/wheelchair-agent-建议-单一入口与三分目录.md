# wheelchair-agent 建议 — 四个互不相识的命令，与一个没画出边界的 `src/`

场景：wheelchair-agent `0.1.0`，`main` @ `49f0df3`，dsh `0.2.1-rc.3` + dsh-tui `0.19.0`，WSL2。

## 现象

**入口有四个，用户得记住四个名字和它们各自在哪。**

`install.sh` 装完就消失，装出 `spv`、`superagent-service`、`jobctl` 三个命令，外加面板里那个绝对路径的
`sh /home/nihao/.dsh/.agent-presets/spv/prepare.sh`。没有任何一个命令能回答「这个工具是什么、我还能做什么」：
`spv --help` 是 dsh-tui 的帮助，`jobctl --help` 只讲长任务，`superagent-service --help` 只讲服务。

面板里那个绝对路径是**机器相关的状态写进了 superagent 的 sqlite**，而 `install.sh` 管不到它——它只
`printf` 一行让操作者手粘。换 `DSH_HOME`、换用户名、换 preset 目录，面板值就静默失效，每个工单都在
prepare 阶段失败；重装也不会修好它，因为重装只是又打印一遍。

**`src/` 平铺 8 个文件，名字里没有一个字说它属于哪一侧。**

代码里的边界是真的：`spv` Source 侧（`src/spv.js`、`spv-watch.js`）与 SPV preset 侧
（`spv-tools.js`、`src/{paths,dispatch,outbox,health}.js`）零交叉 import。但布局没把它画出来，每次读都得
重新推一遍；`install.sh` 的白名单只装 SPV 侧、superagent 侧靠 profile 的 `node_modules` 软链加载这件事，
在目录结构上也完全看不出来。

**队列格式有两份实现。**

`src/queue.js`（JS，插件与工具用）与 `scripts/spv_send.py` / `spv_read.py`（Python，手动调试用）各写一份
`pending/`、`outbox/` 的读写。两份必须永远保持字节兼容，而没有任何机械检查保证这件事。

## 复现步骤

```bash
cd ~/bioagentforge/tools/wheelchair-agent
bash install.sh
# 装出四个互不相识的入口：
ls ~/.local/bin/{spv,superagent-service,jobctl}
# 面板值是一个绝对路径（install.sh 只打印，不写）：
grep -o '"prepare": "[^"]*"' ~/.dsh/state/superagent/orchestrator.sqlite 2>/dev/null || \
  python3 -c "import sqlite3,json;c=sqlite3.connect('$HOME/.dsh/state/superagent/orchestrator.sqlite');\
print(json.loads(c.execute(\"select value from kv where key='settings-version:9'\").fetchone()[0])['settings']['executor']['prepare'])"
# 平铺的 src/，看不出哪一侧：
ls src/
# 两份队列实现：
ls src/queue.js scripts/spv_send.py scripts/spv_read.py
```

## 建议

希望有一个命令入口，`--help` 能列出这个工具能做的全部事情；希望目录结构本身把「两侧严格分开」画出来，
并且这件事能被机械检查（而不是靠读注释）；希望队列格式只有一份实现。

面板里那个值希望是**命令名**而不是绝对路径——路径失效是「文件不存在」，含糊；命令名失效是
`command not found`，一眼看出是 PATH 问题。
