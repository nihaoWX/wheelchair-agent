# 本文件如何读

- 我没提到的不一定现状不对，可以保持
- 我提到的并且与现状不符合的，直接修改

# wheelchair-agent概念/形态

## 概念
一个正在开发的准备面向大众的agent，它预设一整套工作流程，工作流程由dsh-superagent提供骨架，再额外增添内容补全，最终的得到一个简单易用的开箱级agent。

- 因为面向大众，所以不要根据本机的路径或特点去硬编码，而是面向通用场景。
- agent无需自己判断做得开不开箱，我自有打算。

## 形态
cli + 插件，插件是为了与dsh/dsh-superagent接入，通常是薄入口，真正的业务逻辑在cli，并且wheelchair-agent的现有设计部分功能需要脱离dsh运行（jobctl，各类轮询），所以说cli很符合这个要求。

- 通过`install.sh`一键安装
- 数据根在：Linux是`~/.wheelchair-agent/`，主要存放一些wheelchair-agent自身的独有设计内容

# 目录/仓库/git管理

- spv位于一个管理所有仓库的顶层路径，这里是`bioagentforge/`（面向大众的产品不要硬编码，应该是可供其他用户配置的）。worker管理各个小仓库，例如`rsearch/<a task>/`, `tools/<a tool>/`，为什么说worker管理这些仓库，因为真实工单开始时是将仓库clone到`<stateDir>/work/<ticket>/`，然后worker在clone里工作。
- worker只能提交PR不能通过PR，spv可以审核/通过PR。但是本wheelchair-agent我建议可以直接自动合并，自动合并是通过在wheelchair-agent的这个插口上挂一个脚本`ticket.delivered`，这个事件的意思相当于一次worker的成功工作完成结束（它有可能被再次拉起，所以名字不叫工单结束）。
- `<stateDir>/work/<ticket>/`的clone和worker的会话管理：clone在`ticket.delivered`后经过检查（无进程占用+树干净+已提交到远程）就删除，因为它可以由源头`tools/<a tool>` + commit id恢复，所以删了省磁盘空间；worker的会话在`ticket.delivered`后归档，理由是webui如果不归档这些积压的会话会很乱，归档也是可以取消的，如果这个worker未来再次被拉起，可以取消归档。

# wheelchair-agent与dsh-superagent

- dsh-superagent能不改就不改，尽量顺着源码

# worker和orchestrator的管理

- 压缩上下文策略1：目前worker在上一单正常结束，下一单来之前（`ticket.started`）会压缩上下文，因为我在实际观察中发现那些worker再次拉起后执行的任务有时候不是旧任务，也就是说旧任务大部分时候是完成并且没太大问题，同时如果不压缩，上下文窗口将会持续增长到很大，成本极高，因此我上面说的这个时间点压缩是最优的。orchestrator则是在上下文窗口20%左右的时候压缩，orchestrator的上下文也是会缓慢持续增长，如果不管只会在窗口极大时自动压缩，成本很高。
- 压缩上下文策略2：依靠billion-context，这个项目会自动压缩，目前我感觉可以尝试它，暂时放弃压缩策略1（注意这个项目会禁原生压缩，所以记得把压缩策略1给关闭了免得冲突）。这个东西给worker，orchestrator，spv全部都挂上。
- orchestrator的功能：在wheelchair-agent的协作模式里，spv的`spv_dispatch`实际是先经过它然后由它真派worker，看起来有点冗余，但是我思考之下还是决定保留这个机制，orchestrator拥有一些和spv不一样的工具，同时职责和spv存在非重合的地方，有时候可以充当一个检查功能，所以我决定留下。

# 插口

## 概念

插口是我对wheelchair-agent的一个设计点，它提供dsh/dsh-superagent/wheelchair-agent的各类事件hook，用户可以基于这些事件根据自身的工作内容配置自己的东西。允许接入sh脚本，当这些事件发生时将会直接运行配置的sh脚本。不只是限制sh脚本，还有其他接入方式，看情况而定即可。
- wheelchair-agent部分特殊功能基于hook但不可配置：意思就是某些功能需要在代码里体现这个功能就插在这个hook上，为什么这么搞，只是因为这样看起来很合理，很干净。不可配置的原因是因为这个是核心功能，改了就坏了。

## 插口事件
- `spv.dispatch`spv派遣worker：在orchestrator接到`spv_dispatch`信息之前，spv调用了工具`spv_dispatch`后触发。
- `ticket.started`worker启动: prepare成功后，worker这个会话准备启动之前触发
- `ticket.delivered`worker报告: worker成功完成一次工单，准备将完成信息注入给spv的前触发
- `inbox.approved`收件箱通过：用户评论了通过后触发
- `inbox.issue`收件箱有问题：用户评论了有问题后触发
- `inbox.merged`收件箱观察器观察到某个PR已经合并：收件箱观察起观察到某个PR合并后触发
- `cron.spv_corn`斜杠命令/spv-cron的轮询：当/spv-cron轮询时间到达的时候触发

## 固定不可改hook

- worker工作结束后的消息注入：消息注入内容可改但消息注入这个行为不可取消。
- worker的`ticket.delivered`上下文压缩：相关成本，不建议改
- `ticket.started`的prepare，这个prepare是dsh-superagent的原生功能，`ticket.started`只是我们自定义了一个事件而已。prepare的基本行为不可改但细节可改，prepare会：1. 从仓库源clone，2. 检查clone内的AGENTS.md是不是最新的，不是则替换，3. 检查git状态，如果有变动没commit将会自动commit，这样是为了干净。
- 收件箱用户审查结果是有问题，将会把信息注入给spv：注入行为不可改，注入内容可改。
- /spv-cron到时间后消息注入：消息注入行为不可改，注入信息可改。

## 本机用户的hook配置
这个意思就是它是我的个人配置，是不上最终wheelchair-agent的仓库的，因为wheelchair-agent是大众的

- wheelchair-agent这个仓库在`ticket.delivered`后冷安装，即自动更新，但是因为限制原因它不可以热安装，但是这里的hook配置还是会自动运行`install.sh`，只不过如果wheelchair-agent正在运行的话会失败。

# webui

视觉效果我很难描述，仅说我满意的commit id；但是webui的功能我将在下面描述

## 收件箱

### 机制
用户的收件箱，包含所有正在管理仓库的PR（如有），与SPV临时决策的信息，这些信件都由用户评审，可以选择通过或者有问题。收件箱的价值在于让用户确认每个修改是显而易见的，同时让用户知晓项目进度

- 通过允许用户写通过理由，有问题可以直接说问题，有问题的信件评论后会将信息注入spv。

### 收件箱webui
有点难以描述，参考`Commit 35be1f5`，我感觉现在就挺好

## 设置
设置的配置文件在`.wheelchair-agent/settings.json`，默认的配置也要写在里面不要不写。

设置允许调整：
- 外观：目前有流体和简洁，感觉都不错，参考`Commit 35be1f5`（仅参考外观部分，不要参考设置的排版，文字等）。
- 插口：允许调整插口的配置。可以看到现在此插口是什么意思，目前配置了什么（含不可改的），并且每个配置有命名，方便用户查看。

# spv配置
在普通dsh会话的工具列表之上增加spv工具，skill和其他新增工具均与普通dsh一样正常加载

- 系统提示词与普通dsh一致，不要额外写任何的关于wheelchair-agent或spv的提示词注入给spv，因为关于spv的概念用户已经在`AGENTS.md`交代了，无需多余内容

## spv工具
- `spv_dispatch`: 派遣worker，派遣信息发送给orchestrator，orchestrator真正派遣worker。可以选择preset，preset指的是dsh的preset，内置有普通模式，创造模式等。
- `spv_status`: 获取状态
- `spv_notify`: 给收件箱发送信息，信息类型是`spv_message`

## spv会话允许的斜杠命令
以下斜杠命令仅在spv会话内（通过`wheelchair-agent spv`启动）出现，非spv会话不出现
- `/spv-cron`: 定时轮询，轮询会检查仓库状态然后返回信息给spv
- `restart-wheelchair-agent`: 将wheelchair-agent和superagent，dsh-tui全部停止，然后运行wheelchair-agent的install.sh，然后全部重启，运行后自动resume回原来的spv会话

