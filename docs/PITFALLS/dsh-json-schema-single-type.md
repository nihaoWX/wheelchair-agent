# dsh 只接受单个 type 字符串：`type: ['string','null']` 会让整份 preset 起不来

来源：`tools/wheelchair-agent`（2026-11-25）。操作者执行
`wheelchair-agent spv --project tools/wheelchair-agent`，最后一步直接退出。

## 现象

```
dsh-tui startup failed: dsh-tui: failed to create agent (provider=commandcode,
model=deepseek/deepseek-v4.1-flash): spv-tools (file://~/.dsh/.agent-presets/spv/src/spv/tools.js):
unsupported JSON schema: schema.properties.deployments.items.properties.project.type
must be a single type string (type arrays are not supported)
[dsh-tui] dsh profile 已退出（退出码 1）
```

误导点有两个：

1. 报错只点名**一个字段**（`spv_status` 输出里 `deployments[].project`），但实际后果是**整份 preset
   注册失败**——dsh 在建 agent 时校验所有工具的 `parameters` 与 `output.schema`，一个坏 schema 就让整个
   会话起不来，看起来像是"会话/模型/provider 坏了"。
2. 前面还有一句 `warning: superagent did not start, so no task dispatched here would run.`，很容易被当成
   根因；其实它来自启动器（见下面规则 4），与这次失败无关。

## 根因

dsh 的 JSON Schema 子集只接受**一个**标量 `type` 字符串。`project` 当时写成
`{ type: ['string', 'null'] }`（`#48` 的 `1ba0587` 加 `deployments` 数组时引入），数组直接违规。

子集白名单（`@deepseek-ai/dsh-tools/lib/types/json-schema.js`，`assertSupportedJsonSchema`）：

- 约束键：`type`、`oneOf`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`
- 注释键：`description`、`title`、`default`、`examples`
- `oneOf` 至少要两个分支，且不能与 `type` 或 `properties`/`required`/`additionalProperties`/`items`/
  `enum`/`const` 同时出现

可空字段的正确写法：

```js
project: { oneOf: [{ type: 'string' }, { type: 'null' }] }
```

## 规则

1. **工具 schema 里永远不写 type 数组**，可空一律 `oneOf: [{type:'X'},{type:'null'}]`。
   `grep -rn "type: \[" src/ build/ preset/ webui/` 是这条规则的廉价全量检查（修好后应为空）。
2. **改动 schema 必须过一遍真实校验器**，而不是只看 `node --check`：项目内
   `tests/test-preset.mjs` 已带一个 schema 子集 walker（不 import dsh，只按白名单递归
   `properties`/`items`/`oneOf`），它会在 `npm test` 第一步跑；故意把 fix 回退成 type 数组时它会红。
3. 想用 dsh 自己的校验器手工复核（已装 dsh 的机器上）：

   ```bash
   node -e "import('/home/<user>/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js').then(m=>m.assertSupportedJsonSchema(<schema>))"
   ```

4. **`superagent did not start` 不代表后端坏了**：先用
   `wheelchair-agent service status`（在项目 checkout 里）看 `runtime:`；那次后端其实是 ready 的，警告来自
   启动器在 `#48` 之后仍裸跑 `service status`/`service start`（已修：`commandService` 改用
   `ownDeployment()` 读 `SPV_QUEUE_DIR` 反查本部署）。
5. **`dsh-tui run`（headless）不能用来验证 preset 挂载**：它不认 `--patch`/`DSH_TUI_PRESET` 的 preset
   选择，会话一律记成 `agentPreset: standard`，还常常以 `TIMEOUT` 结束。可靠的验证是
   `dsh-tui --patch <preset>/preset-default.patch.yml --dump-config`（看 `spv-tools` 在不在）+
   真起一个 TUI（tmux 里 `capture-pane` 看状态行是否 `SPV`、有没有 `failed to create agent`）。
