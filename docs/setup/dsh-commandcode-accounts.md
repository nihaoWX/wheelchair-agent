# dsh Command Code 账号绑定：凭据、profile 与排查

面板里已经加了新账号、某个 profile 却还在用旧账号时，按本文定位。
安装与两端接入（模型 / web_search / web_fetch）见 `dsh-commandcode.md`；本文只讲**账号存在哪、哪个 profile 用哪把**。

- 复核日期：2026-11-26
- 环境：dsh `0.2.1-rc.3`，provider `0.17.7`（dsh-tui）/ `0.17.6`（superagent）

## 1. 结论

1. **凭据库全局共享，账号列表不是。** key 存在 `~/.dsh/.credentials.yaml`；`apiKeyEnv` / `accounts` /
   `activeAccount` 存在**每个 profile 自己的** `cordis.patch.yml`。
2. **web 面板只写它所在 profile 的 patch。** 在 superagent 的 web 面板加账号，只会改
   `~/.dsh/profiles/superagent/cordis.patch.yml`，dsh-tui 完全看不到。
3. 某个 profile 不生效，先看它的 `llm-commandcode.config` 里有没有 `accounts` / `activeAccount`，
   再确认它解析到的 ref 指向哪个账号（第 5 节）。
4. 改完 profile patch 必须 `/restart`（启动期配置）；只改凭据库里某个 ref 的**值**不用重启。

## 2. 三个层次

| 层 | 位置 | 作用域 | 内容 |
|---|---|---|---|
| 凭据库 | `~/.dsh/.credentials.yaml`（必须 600） | 全局，所有 profile 共享 | ref 名 → key 值 |
| provider 行 | `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `llm-commandcode.config` | 单个 profile | `apiKeyEnv` / `accounts` / `activeAccount` / `modelAccountRules` |
| 启动环境 | 进程里的 `COMMANDCODE_API_KEY` | 单个进程 | key 值（可能过期） |
| 官方 CLI | `~/.commandcode/auth.json` | 全局，最后兜底 | `cmd login` 写入的 key |

本机没有 `~/.dsh/settings.yaml`；provider 配置来自上面的 profile patch（组合配置），
所以**不存在一个“全局账号列表”可以一次改完所有 profile**。

## 3. 解析顺序与槽位语义

单把 key 的解析顺序（provider README，dsh ≥ `0.2.1-alpha.3`）：

1. `config.apiKey` 字面量（永远优先，不推荐）
2. 凭据库里的 ref：`config.apiKeyEnv`，默认 `COMMANDCODE_API_KEY`
3. 启动环境变量
4. `~/.commandcode/auth.json`

> 第 2 步在挂了凭据服务的 profile（web / desktop / SDK / ACP / **dsh-base 的 TUI**）里优先于第 3 步。
> **headless 例外**：它故意不挂凭据库，只认环境变量 / `.env` / `auth.json`，面板保存的 key 到不了那里。

槽位（slot）：

| 槽 | `id` | 来源 | 允许回落 auth.json |
|---|---|---|---|
| 默认槽 | 固定为 `"default"` | `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`） | 是 |
| 账号槽 | **等于它的 ref 名**，如 `COMMANDCODE_API_KEY_3` | `accounts[]` | 否 |

- 同一个 key 只保留一次，先出现的槽胜出（所以 `_2`、`_3` 是同一把 key 时后者会被去重）。
- `activeAccount: <槽 id>` 钉住某个槽优先；`auto` / 留空 = 按槽顺序轮换。
- `modelAccountRules` 可把某些模型固定路由到某个槽（`account` 填槽 id）。
- 钉住的账号耗尽时会回落到常规顺序；如果默认槽也耗尽，就整体报错，直到某个窗口重置。

## 4. 本次症状与根因（2026-11-26）

症状：superagent 的 web 端已经用上新账号，dsh-tui 仍在用旧账号。

根因：

- 16:28 面板保存新账号，**同一秒**写了 `~/.dsh/.credentials.yaml`（新增 `COMMANDCODE_API_KEY_3`）
  和 `~/.dsh/profiles/superagent/cordis.patch.yml`（`accounts` + `apiKeyEnv`）。
- `~/.dsh/profiles/dsh-tui/cordis.patch.yml` 还是 11-15 的版本，只有默认 `apiKeyEnv`，
  没有 `accounts`，所以只解析默认槽 —— 旧账号。

账号实况（`/alpha/whoami` + `/alpha/billing/{subscriptions,credits}`）：

| ref | 账号 | 套餐 | 状态 |
|---|---|---|---|
| `COMMANDCODE_API_KEY` | `zqliangjintaoje4w`（outlook） | `individual-goat` | active，但 `cancelAtPeriodEnd: true`；周 35/35 **已耗尽** |
| `COMMANDCODE_API_KEY_3` | `zqliangjintaofc31`（gmail） | `individual-goat` | active，周 0.37/35，月额度 69.6 |
| `COMMANDCODE_API_KEY_2` | 同上 `...fc31` | — | 与 `_3` 是同一账号的另一把 key |
| 进程环境 `COMMANDCODE_API_KEY` | — | — | 实测 401（过期）；被凭据库覆盖，不影响 |

旧 Goat 订阅（8-28 开通）正在取消，新 Goat 订阅（10-26 开通）在 `_3` 上。

## 5. 排查：某个 ref 到底是哪个账号

只读，不改任何东西；输出不要带 key。用 **Node fetch**（Python `urllib` 会被 Cloudflare 1010 拦掉）：

```bash
node - <<'JS'
const {readFileSync}=require('fs');
const refs={};
for(const line of readFileSync(process.env.HOME+'/.dsh/.credentials.yaml','utf8').split('\n')){
  const m=line.match(/^\s*(COMMANDCODE_API_KEY[^:]*):\s*(.*)$/);
  if(m) refs[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');
}
const h=k=>({Authorization:'Bearer '+k,'accept-encoding':'identity',
  'x-command-code-version':'1.88.5','x-cli-environment':'production','accept':'application/json'});
(async()=>{
  for(const [name,k] of Object.entries(refs)){
    const who=await (await fetch('https://api.commandcode.ai/alpha/whoami',{headers:h(k)})).json();
    const sub=await (await fetch('https://api.commandcode.ai/alpha/billing/subscriptions',{headers:h(k)})).json();
    const cr =await (await fetch('https://api.commandcode.ai/alpha/billing/credits',{headers:h(k)})).json();
    console.log(name,'tail',k.slice(-4),'|',
      who.user?.userName,'|',sub.data?.planId,sub.data?.status,
      '| weekly',cr.windowLimits?.weekly?.used+'/'+cr.windowLimits?.weekly?.cap);
  }
})();
JS
```

要点：

- `user.id` 相同 = 同一账号；同一个账号可以有多把 key，对应多个 ref。
- 周/5 小时窗口看 `credits.windowLimits`；`exceeded` 非空就是该窗口已满。
- `cancelAtPeriodEnd: true` 表示这个订阅到期不续，通常意味着它已被新账号替代。

## 6. 修复：让目标 profile 用指定账号

在**那个 profile** 的 `cordis.patch.yml` 里补 `llm-commandcode` 行（key 已在凭据库，只写 ref 名，**不要写明文**）：

```yaml
- id: llm-commandcode
  config:
    apiKeyEnv: COMMANDCODE_API_KEY          # 默认槽（旧号，留作后备）
    activeAccount: COMMANDCODE_API_KEY_3    # 钉住新号；槽 id 就是 ref 名
    accounts:
      - label: zqliangjintaofc31
        apiKeyEnv: COMMANDCODE_API_KEY_3
```

说明：

- 同 id 的 patch 会**整体替换**该行的 `config`，所以要把想保留的键一起写上（这里 provider 其余键走默认值）。
- 只想“新号优先、旧号兜底”就加 `activeAccount`；只加 `accounts` 则是轮换，
  默认槽还能用时仍会先用默认槽。
- 不想钉死也可以把 `apiKeyEnv` 直接改成 `COMMANDCODE_API_KEY_3`，但默认槽的 ref 名会被换掉，
  其他 profile 不受影响 —— 两种写法按需选。

验证组合结果：

```bash
dsh --profile dsh-tui --dump-config | grep -A8 'id: llm-commandcode'
```

应看到 `activeAccount` 和 `accounts`，且 `id` 对应的 `name` 仍是 `@mars-sea/dsh-commandcode-provider`。

生效：

- dsh-tui：在 TUI 里执行 `/restart`（原地重启并恢复当前会话），再用 `/commandcode` 确认
  活跃账号是 `zqliangjintaofc31`。
- 其他 profile：重启对应服务。

## 7. 坑

- **面板加号只对当前 profile 生效。** superagent 的 web 面板（3082/3083…）写 superagent 的 patch；
  dsh-tui 有自己的一份，必须单独配置。不要把“web 端好了”当成“全局好了”。
- **TUI 没有“添加账户”。** `/settings` → Command Code 只有单个 API key、API base、过滤、
  当前账号、命令语言；“添加账户”只在 web 面板。
- **TUI 的 API key 字段写的是当前 `apiKeyEnv` 的 ref**（默认 `COMMANDCODE_API_KEY`），
  不是新建 `_N`。用它粘贴新号会覆盖所有 profile 共用的默认槽 —— 想保留默认槽就不要在这里贴。
- **环境里的 `COMMANDCODE_API_KEY` 可能是过期 key**（本次 `...qxpZ` 实测 401）。
  凭据库优先，所以不必 `unset`，但也不能用环境变量判断 TUI 实际在用哪个账号。
- **`_2` / `_3` 可能指向同一账号的多把 key**；按 `user.id` 去重，不要按 ref 名猜。
- **Python `urllib` 访问 `/alpha/*` 会吃 Cloudflare 1010**；用 Node fetch（或带正常 UA 的 curl）。
- **改 patch 必须重启**；只改凭据库里 ref 的值是热生效的。
- **headless 不挂凭据库**，面板保存的 key 不会进 headless 运行。

## 8. 验证记录（2026-11-26）

| 检查 | 结果 |
|---|---|
| `dsh --profile dsh-tui --dump-config` | 合成出 `llm-commandcode` 的 `activeAccount: COMMANDCODE_API_KEY_3` + `accounts` |
| 三个 ref 的 `/alpha/whoami` | 默认 `je4w`；`_2`/`_3` 均为 `fc31` |
| `/alpha/billing/credits` | 默认周额度 `35/35` 已满；`_3` 周 `0.37/35`，月额度 `69.6` |
| 生效方式 | TUI 内 `/restart` 后 `/commandcode` 应显示 `zqliangjintaofc31` |
