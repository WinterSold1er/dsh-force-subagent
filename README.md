# dsh-force-subagent

用 `/using-agent-team` 命令按会话开启"强制委派"提示的 DSH 宿主插件，零依赖、无构建（纯 ESM）。

## 行为

插件在 `apply` 里向 `systemPrompt` 注册**一个** section（`force-subagent:agent-team`，order 57），并注册 `/using-agent-team` 命令。不挂 `agent/pre-step`、不写自定义会话事件类型；命令每次执行都向模型投递一条 `source.kind = 'force-subagent'` 的 notice（`form: 'notice'`）：带 `<task>` 走 `agent.steer`（空闲起一轮、运行中下一步送达），`on` / 裸命令 / `off` 走 `agent.inject`（不唤醒）。会话中途输入立即生效。

| 输入 | 行为 |
| :--- | :--- |
| `/using-agent-team`、`on` | 立即开启本会话提醒：之后每轮都注入强制委派提示，持续到 `off`；命令自身 `inject` 一条开启提醒。 |
| `/using-agent-team <task>` | 立即开启并下达任务：命令 `steer` 一条含任务原文的提醒（只调一次 `steer`），任务原文此后持续出现在 section 文本（`\n\n本会话任务（/using-agent-team 下达，持续有效）：` + 原文），直到 `off`；原文大小写与内部空白保留（仅去首尾空白）。 |
| `/using-agent-team off` | 关闭本会话提醒（`text` 返回 `''`），并 `inject` 一条关闭提醒。 |
| 未执行过命令的会话 | 不注入（`text` 返回 `''`）。 |
| 命令投递的 notice | `{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'force-subagent', form: 'notice', summary } }`；`summary` 为 `已开启强制委派` / `已开启强制委派：<task 前 40 字>` / `已关闭强制委派`。`invocation.agent` 缺 `steer` / `inject` 时跳过投递、不抛错；投递抛错只 `ctx.logger.warn` 一次，命令仍返回 success。 |
| 已开启会话的 teammate | 注入成员版提醒（第一个业务工具调用必须委派），开关从 Lead 会话回溯；Lead 下达的 task 同样追加进成员 section 文本。 |
| teammate 调用白名单外工具（bash / edit / write / 所有 `mcp__*` / `run_code` 等） | `tools/pre-execute` 返回 `deny`（仅当该 teammate 的 Lead 会话已开启开关）：白名单只有 21 个且精确匹配——`subagent`、`subagent_fork`、`subagent_role`、`close_subagent`、`workflow`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update`、`send_message`、`wait_agent`、`list_agents`、`interrupt_agent`、`job_list`、`job_output`、`job_kill`、`skill`、`todo_write`、`read`、`grep`、`glob`，其余一律拒绝并要求改用委派；非 teammate（Lead / subagent）或开关关闭直接放行；`agentTeams` 缺失或评估异常时首次 `ctx.logger.warn` 点名 `agentTeams` 与「门禁未生效，本次放行」，随后放行。 |
| 读取会话事件失败 | `ctx.logger.warn` 记录原因，本次不注入。 |

门控不落盘：`commandState(session)` 取会话事件里**最后一条** `command/run`（`data.name === 'using-agent-team'`），用 `parseCommandInput` 解析：去空白后为空或 `on`（不区分大小写）→ `{enabled:true}`，`off`（不区分大小写）→ `{enabled:false}`，其它文本 → `{enabled:true, task:原文}`；无记录 → `{enabled:false}`，事件不可读 → `TypeError`。`enabledIn(session)` 是 `commandState(session).enabled` 的薄封装，`tools/pre-execute` 门禁语义不变。section 文本：开启无任务 = 原 nudge；开启有任务 = nudge + `\n\n本会话任务（/using-agent-team 下达，持续有效）：` + 任务原文；关闭 = 空串。member 会话没有自己的 `command/run` 记录，插件经可选的 `agentTeams.tryMembership(agent)` 拿到 `root`（Lead）会话再判定；没有 `agentTeams` 服务时退回本会话门控。提醒是提示词级约束；上方 `tools/pre-execute` 门禁按白名单默认拒绝，评估异常时 fail-open 放行并留下 warn 日志。

依赖 `commands` 与 `systemPrompt`：`inject = ['commands', 'systemPrompt']`，Cordis 在两个服务就绪后才调用 `apply`；`ctx.get` 是一次性快照，若返回空（isolate 场景），`apply` 经 `ctx.logger.warn` 点名缺失服务并返回——提示与命令停用，门禁仍独立生效。

## 启用

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --dry-run   # 预演：只打印将做的改动，不落盘
./scripts/install.sh             # 安装并接线
```

脚本向 `~/.dsh/profiles/web/package.json` 写入 `"dsh-force-subagent": "file:<仓库绝对路径>"` 依赖、
把 `dsh-force-subagent` 追加进 `dsh.profile.bundles`、并创建
`~/.dsh/profiles/web/node_modules/dsh-force-subagent` → 本仓库的符号链接（改动前自动备份 `package.json`）。

**必须手动重启 dsh web host 才生效**——脚本故意不重启（重启会终止当前 agent 会话）。
完整步骤、验证命令与排错见 [docs/install.md](docs/install.md)。

插件自带 [cordis.patch.yml](cordis.patch.yml)，由 `package.json` 的 `dsh.bundle.patch` 自动应用，**无需手改 profile 的 patch 文件**。
`dsh plugin --profile web add link:<repo>` 属未验证的替代路径，实测未采用，不要依赖。

## 部署

- 改动本插件后必须重启 dsh web host 才生效。
- 重启前先把 `dsh-plugin-subagent-director` 升级到已删除 `/using-agent-team` 命令的版本。
- 否则两个插件争同名命令：本插件经 `ctx.logger.warn` 告警（点名 `dsh-plugin-subagent-director`，提示升级或卸载），并**跳过自己的命令注册**——section 提示仍照常工作，只是 `/using-agent-team` 由旧插件处理。其他注册错误原样抛出。

## 禁用 / 卸载

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --uninstall
```

移除依赖、bundles 条目与符号链接（保留备份），随后重启 host 生效。插件作用域销毁时 section 与命令随之注销，无需手工清理。

## 契约

开关判定走宿主写入的 `command/run` 会话事件（`text(context)` 内读 `session.snapshotEvents()`），注入走全局 `systemPrompt.section`（`force-subagent:agent-team`，order 57）。成员身份经 `ctx.get('agentTeams')?.tryMembership(agent)` 解析（`role === 'teammate'` 时取 `root.session` 判开关；`text` 侧 `agentTeams` 缺失则退回本会话门控）。`tools/pre-execute` 门禁在 `apply()` 最先独立注册，不依赖 `systemPrompt` / `commands`：这两个服务缺失时仅提示与命令停用（`ctx.logger.warn` + `return`），门禁仍然生效；注册后白名单外一律返回 `{kind:'deny', reason}`，`agentTeams` 缺失、`tryMembership` 抛错或其他异常经闭包变量只 warn 一次（文案点名 `agentTeams` 与「门禁未生效，本次放行」）后 `return next()` 放行。MEMBER_NUDGE 表述为「除编排与只读工具外会被门禁拒绝」。不再走 `agent/pre-step` 消息追加；命令 handler 注册在 `apply` 闭包内，用 `agent.steer`（带 task）或 `agent.inject`（其余）向模型投递 notice，`source.kind` 固定为 `force-subagent`、`form` 为 `notice`，投递失败只 `warn` 一次且命令仍返回 success。接口契约见
[docs/agent-team-api.md](docs/agent-team-api.md) 与 [docs/prompt-plugin-api.md](docs/prompt-plugin-api.md)。
