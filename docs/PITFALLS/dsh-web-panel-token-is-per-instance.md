# dsh web 面板打不开：token 属于「那一次启动」，重启后必须重新取

来源：`tools/wheelchair-agent`（2026-11-16 夜间，服务因宿主 systemd 崩溃反复重启期间）。操作者看到
`dsh web authentication required; reopen the URL printed by dsh web`，手里那条带 `?token=` 的完整
URL 也进不去；最后靠「先 `superagent-service start`，再 `superagent-service open`」当场解决。

## 现象

- 浏览器打开 `http://127.0.0.1:3082/`，页面只有一行
  `dsh web authentication required; reopen the URL printed by dsh web`。
- 拿一条**看起来正确**的 `http://127.0.0.1:3082/?token=…` 去开，结果一样：仍然要认证。
- 服务每重启一次，日志里的 token 就换一次（那一夜换了 5 次），而人手里记的是最早那条。

## 根因

两层，第二层是真正让人迷惑的那层：

1. `dsh web` **每次启动新 mint 一个 token**，只打印一次（本部署落在
   `~/.dsh/.artifacts/superagent.log` 的 `dsh web: http://…?token=…` 一行），没有 pin 住 token 的开关。
2. 所以 token 与**那一个服务实例**绑定：实例一死，旧 token 立即作废。操作者试的 token 来自上一具
   尸体——不是「带 token 也不行」，是「带的是死实例的 token」。同理，URL 也不能跨实例复用。

`commands/superagent-service.py` 的 `panel_url()` 正是照这个事实写的：用
`re.findall(r'https?://[^\s]*[?&]token=[A-Za-z0-9._-]+', text)` 抓全部，再取 **`matches[-1]`（最新一条）**；
`service open` 拿到它就直接交给浏览器。这就是为什么 `start` + `open` 成对执行永远有效。

## 规则

1. **拿面板 URL 只有两条合法路径**：`wheelchair-agent service status` 的 `panel:` 行（它走上面那个
   `panel_url()`），或 `wheelchair-agent service open`（同一个 token，顺带开浏览器）。
2. **服务重启过就必须重新取**。任何形式的「我记着上次的 URL」都是错的，包括写在文档、便签、
   聊天记录里的。
3. **判活不要看页面**，看这三条：

   ```bash
   wheelchair-agent service status            # pids 是否为空、runtime 是否 ready
   curl -s -o /dev/null -w '%{http_code}\n' '<带 token 的 URL>'   # 303 = token 有效
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3082/ # 401 = 无 token（正常）
   curl -s -L -c /tmp/cj -b /tmp/cj '<带 token 的 URL>' | head -c 120  # 真 HTML
   ```
4. **面板进不去时先问「服务还活着吗、token 是哪一次的」**，别先去翻浏览器缓存、cookie、代理。

## 检测签名

- 页面只剩一行 `authentication required` → token 缺失或属于旧实例。
- `pids: (none)` 但日志里有 token 行 → 服务已经死了，token 是遗物。
- 日志里堆了多条 `dsh web: …?token=…` → 取最后一条；取第一条必然 401。
- `curl` 带 token 得 303、不带得 401，而浏览器仍然要认证 → 浏览器在复用旧标签页/旧重定向，
  重新粘贴一次带 token 的地址即可。

## 相关

- 服务起来后仍可能被宿主环境杀掉（本机是 WSL 的 `systemd-logind` SIGABRT），
  所以「面板突然要认证」经常是**服务刚死过一次**的间接信号——先查服务，再查 token。
- 把服务放在用户级瞬时 unit（`systemd-run --user --unit=… --property=RemainAfterExit=yes
  --property=KillMode=none`）可以躲开 logind 会话 scope 被销毁时连坐，但它**不改变 token 语义**：
  unit 重启一次，URL 照样换。

## 改法：把面板这一环并进重启链（2026-11-16 定）

`/restart-wheelchair-agent`（= `wheelchair-agent restart-all`）本来就负责
「停服务 → 清会话租约 → 冷安装 → 起服务 → 同终端 `--resume` 拉回会话」。**缺的是最后一步：服务起来之后
再执行一次 `wheelchair-agent service open`**，相当于连 webui 一起重启，操作者不需要记得去开新标签页。

- **为什么必须由重启链自己做**：`service open` 读的是 `panel_url()` 从日志抓的 `matches[-1]`——也就是
  **这一次启动**刚写进去的 token。重启链内部是唯一同时知道"新实例已经 ready"和"日志在哪"的地方；
  让操作者事后手工 `open`，结果就是忘、或者拿着旧 URL 反复 401（本次踩的就是这个）。
- **失败不得连累重启**：`open` 只是便利动作。找不到 `powershell.exe` / `xdg-open` / `open`、headless、
  或在没有 `DISPLAY` 的 tmux 里，都应该只记一行 warn 继续，重启链照旧成功。
  `--detach`（以及非交互调用）默认不打开浏览器，需要时用显式开关强制。
- **验收**（机械可查）：重启链的步骤输出里出现 `opened: http://127.0.0.1:3082/?token=…`；同一次重启前后
  的 token 必须不同（这证明拿到的是新实例的）；对那个 URL `curl -s -o /dev/null -w '%{http_code}'` 得 303。
- **反面**：把 `open` 放在 `install.sh` 里（那是纯安装步骤，没有服务可开）、或放在服务自己启动时
  （那时浏览器/终端归属还没确定，且会把"没人看的机器"也扯进来）。
