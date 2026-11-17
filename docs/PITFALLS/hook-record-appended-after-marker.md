# 等 hook 的 marker 文件，不等于 hooks.jsonl 已落盘

来源：`tools/wheelchair-agent`，hooks stage 3（PR #30）的 CI。2026-11-17，`test-hooks.mjs` 在本地连续
通过，CI 却在 `the next hook ran` 上失败；同一份代码第二次跑又可能通过。

## 现象

- `appendReview()` 触发 `inbox.approved` 的三个 hook：一个 `exit 1`、一个超时、一个最后写 marker。
- 测试先 `waitForText(marker)`，再立刻 `readHookRecords()` 断言三条记录都在。
- 本地大多通过；CI 偶发只看到前两条，第三条记录还没追加。

## 根因

hook 脚本自己先写 marker，`runOneHook()` 要等子进程退出后才追加 `records/hooks.jsonl` 的那一行。
所以「marker 出现」只证明脚本开始/执行到写文件，**不证明记录已经 append**。两者之间的窗口在慢
机器上被放大，测试就在窗口里读了文件。

## 规则

等一次 hook 的**记录**时，不要只等脚本自己写出的 marker；轮询 `readHookRecords()`，直到所有期望的
`hookId` / `exit` / `timedOut` 都在，再做断言。等 marker 仍适合证明脚本执行过，但不能替代记录等待。

## 检测签名

- 测试在 `waitForText` / `waitForJson(marker)` 后立刻 `readHookRecords()` 并断言某一行的 `exit`。
- 失败信息是「最后一条 hook 没记录」，而脚本的 marker 明明存在。
- 重跑常绿，CI 偶发红。

修复示例：`tests/test-hooks.mjs` 的 `waitForRecords()` 轮询 JSONL，直到 failing / timing-out /
following 三条记录同时存在。
