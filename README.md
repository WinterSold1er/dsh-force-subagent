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
| teammate 调用白名单外工具（bash / edit / write / 所有 `mcp__*` / `run_code` 等） | **软门禁（放行 + 一次提醒）**：nested 模式白名单只有 21 个且精确匹配——`subagent`、`subagent_fork`、`subagent_role`、`close_subagent`、`workflow`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update`、`send_message`、`wait_agent`、`list_agents`、`interrupt_agent`、`job_list`、`job_output`、`job_kill`、`skill`、`todo_write`、`read`、`grep`、`glob`；精确命中即 `return next()` 静默放行，且这个短路**只对 teammate 生效**（Lead 的 `read` / `grep` / `glob` 不会从这里短路，会落到下面的 Lead 门禁）。命中之外、且该 teammate 的 Lead 会话已开启开关 → 工具仍 `return next()` 放行，同时经 `agent.inject` 投递一次前缀 `[team-gate]` 的成员版提醒（`remindOnce(agent, 'member-gate', …)`）；开关关闭直接放行。flat 模式成员的白名单不再限制其余工具，只有派子代理入口 `subagent` / `subagent_fork` / `subagent_role` / `close_subagent` / `workflow` 触发一次 `[team-gate]` 提醒后放行。`agentTeams` 缺失或评估异常时首次 `ctx.logger.warn` 点名 `agentTeams` 与「门禁未生效，本次放行」，随后放行。 |
| Lead（非 teammate）调用取证工具 `bash` / `pwsh` / `read` / `read_image` / `grep` / `glob` / `web_fetch` / `web_search`，实现工具 `write` / `edit` / `apply_patch` / `str_replace_editor`，或执行工具 `run_code` / `terminal_open` / `terminal_read` / `terminal_send` / `terminal_signal` | **硬门禁（结构化 deny）**：取证类 `EVIDENCE_TOOLS = { bash, read, grep, glob, web_fetch, web_search, read_image, pwsh }`（8 个），实现类 `IMPLEMENTATION_TOOLS = { write, edit, apply_patch, str_replace_editor }`（4 个），执行类 `EXECUTION_TOOLS = { run_code, terminal_open, terminal_read, terminal_send, terminal_signal }`（5 个），Lead 侧被拦总集合 `LEAD_BLOCKED_TOOLS = EVIDENCE_TOOLS ∪ IMPLEMENTATION_TOOLS ∪ EXECUTION_TOOLS`（8 + 4 + 5 = 17 个）。命中且 `membership?.role !== 'teammate'` 时 `tools/pre-execute` 返回 `{ kind: 'deny', reason }`，`reason` 前缀固定 `[team-gate] LEAD_EVIDENCE_DENIED:`，点名被拦工具（实现类标「实现工具」，执行类标「执行工具」，取证类标「取证工具」）与被拒原因；执行类被拦时 `reason` 内额外追加「执行工具本身就是取证与实现的等价通道」。封实现类与执行类的理由写在代码注释里：只封取证不封动手等于门禁没有生效——Lead 被拒 `bash` 后转而 `write` / `edit` 就把活做掉了；同理被拒 `bash` / `write` 后转而 `run_code`（程序里读文件、写文件、跑命令，并可经 SDK 再派发其它 agent-visible 工具）或 `terminal_open`（跨 turn 存活的持久 shell）同样把活做掉了。判据里的「本轮」= 会话事件里最后一个 `turn/start` 之后的事件；「本轮已经把活派出去了」的判据是 `DISPATCH_TOOLS = { spawn_teammate, subagent, subagent_fork, subagent_role, workflow }`。 |
| Lead 门禁的两条 deny 条件（取证类、实现类与执行类共用同一判据） | ① 本轮出现过 `interrupt_agent`，且它在事件序列里的位置晚于本轮最后一次 `DISPATCH_TOOLS` 调用（成员已不可用，新活必须 spawn 新成员）→ `deny`。② 本轮没有任何 `DISPATCH_TOOLS` 调用，且 `hasRunningMember(events)` 为 false（既没派发也没有在办成员）→ `deny`。两条都不命中才 `return next()` 放行；**单靠 `team_task_create` 不再放行**。`hasRunningMember(events)` 只认 `team/member` 事件，同一 `member.id` 只取最后一条快照的 `phase`（宿主事件是整值快照），`phase === 'failed'` 是硬终态，再剔掉 `finishedMembers`（名下任务全部 completed / deleted 且无在办）；Lead 自身不出现在 `team/member` 事件里，因此永远不会被算成 running 成员。 |
| Lead 门禁的永远放行清单 | 门禁只在 `membership?.role !== 'teammate' && LEAD_BLOCKED_TOOLS.has(tool)` 时评估，被评估的只有取证类 8 个 + 实现类 4 个 + 执行类 5 个共 17 个工具；编排与委派类工具不在 `LEAD_BLOCKED_TOOLS` 内、根本不被评估，永远放行：`team_task_create` / `team_task_get` / `team_task_list` / `team_task_update`、`spawn_teammate`、`subagent` / `subagent_fork` / `subagent_role`、`workflow`、`send_message`、`wait_agent`、`list_agents`、`interrupt_agent`。`write` / `edit` / `apply_patch` / `str_replace_editor` 已从这份放行清单移出，归入实现类被拦工具；`run_code` / `terminal_open` / `terminal_read` / `terminal_send` / `terminal_signal` 归入执行类被拦工具。名字逐个核对宿主 0.2.2-rc.1 真实注册名（`write` 见 `packages/fs/tool-fs/src/write.ts:74`、`edit` 见 `edit.ts:86`、`apply_patch` 见 `apply-patch.ts:27`、`str_replace_editor` 见 `packages/fs/tool-str-replace-editor/src/index.ts:430`；`run_code` 见 `packages/core/tool-executor-ptc/src/ptc.ts:298` 的 `defineTool({ name: RUN_CODE_NAME })`，常量值 `'run_code'` 见 `packages/core/tools/src/contracts.ts:12`；`terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` 见 `packages/experimental/tool-terminal/src/index.ts:166` / `:203` / `:307` / `:340`，宿主只有这一个终端注册点，持久与非持久后端共用同一个模型可见名，一条名字覆盖两条路），模型可见名全表见 `packages/core/tools/tests/gen-tool-catalog.spec.ts:36`（`run_code`）与 `:41-42`（`terminal_*`）；宿主不存在的 `multi_edit` 一类名字一律不列。已知未覆盖的 Lead 侧工具面：MCP 工具（模型可见名 `mcp__<server>__<tool>`，名字由各服务器决定，逐名硬拦不可行）不进集合，只靠 Lead 提示词的「换别的工具做同一件事同样会被拒」承担告知；`stagehand_navigate` / `stagehand_act` / `stagehand_observe` / `stagehand_extract` / `stagehand_screenshot` / `stagehand_tabs`（浏览器取证与操作面，模型可见名见 `packages/core/tools/tests/gen-tool-catalog.spec.ts:39`）不进集合——这一组是否注册取决于宿主是否装载该工具包，逐名硬拦会随宿主装配漂移，而 Lead 侧网页取证已由被拦的 `web_fetch` / `web_search` 承担；`lsp`（`packages/lsp/tool-lsp/src/index.ts:109`）不进集合——它是符号 / 定义查询与静态导航，可用性取决于宿主是否注册并启动 language server，未纳入集合是残余缺口：Lead 可用它读代码而不必委派；`cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self` 不进集合——它们读的是宿主 Cordis 容器的自省（插件与服务可见性），不是工作区取证也不是实现通道；`session_event_read` / `session_event_search` / `session_event_trace` 与 `session_search` / `session_trace`（`packages/experimental/tool-session-query/src/index.ts`）不进集合——它们读的是会话历史而非工作区文件，而本插件自身的门禁判定同样要读会话事件，硬拦与判定同向冲突；`create_worktree`（`packages/experimental/tool-worktree/src/index.ts`）不进集合——它只创建工作区副本目录，既不读既有文件也不执行命令，真正的取证与实现仍需经被拦的工具；`terminal_close`（`:365`）/ `terminal_list`（`:396`）不入集合——它们只是终端会话的生命周期簿记、自身不执行任何东西，而可操作的终端只能由已被拦的 `terminal_open` 建立。另有两类直接 `return next()`：会话头 `delegationDepth >= 1` 的本地子代理（`subagent` / `subagent_fork` 同样没有 membership，fork 还继承父会话事件前缀，不排除会把 Lead 派出的取证 subagent 拦死），以及 `role === 'teammate'` 的成员（走上面那一行）。 |
| Lead 门禁被 deny 后的唯一出路 | 先 `team_task_create` 把工作拆成互不依赖的小任务（`write_scopes` 互斥、`blocked_by` 只写真实依赖），再在**单轮内并行 `spawn_teammate`** 派成员承接；Lead 只做拆分、派发、合并与校验，取证、实现与执行（改代码、跑命令、跑测试、开持久终端、跑程序）都由承接任务的成员去做；换一个工具做同一件事同样会被拒。 |
| Lead 提示词已预先告知硬拒（先说清再被拒） | `LEAD_NUDGE` 末尾有「【Lead 硬门禁，先说清再被拒】」段，`FLAT_LEAD_APPENDIX` 末尾有「【flat 模式 Lead 硬拦同样生效】」段：两处都在提示词里点名取证类 8 个、实现类 4 个与执行类 5 个工具（`run_code` / `terminal_open` / `terminal_read` / `terminal_send` / `terminal_signal`）、说明「本轮既没有 `spawn_teammate` / `subagent` 派发、会话里也没有 running 成员时工具不执行、返回 deny、正文前缀 `[team-gate] LEAD_EVIDENCE_DENIED:`」与被拒后的唯一出路（`team_task_create` + 单轮并行 `spawn_teammate`），Lead 是在被拦之前就知道规则，不是撞墙才知道。flat 追加段同时写明该门禁不因 flat 模式放宽。 |
| Lead 门禁的 fail-open | 拿不到判定依据一律 `return next()` 放行 + `warnFailOpen` 只 warn 一次：读 `exec.agent.session.header.delegationDepth` 抛错、`exec.agent.session` 缺失、`commandState` / 事件读取抛错、`readEvents` 无返回、事件里找不到 `turn/start`；`tools/pre-execute` 外层评估抛错同样 warn 一次后放行。门禁自身不可靠时不卡死宿主、不刷日志。 |
| 门禁分级（硬 deny 只有一处） | 全插件只有 Lead 门禁这一处会 `deny`——同一处门禁的两个返回点，覆盖取证类 8 个（`bash` / `read` / `grep` / `glob` / `web_fetch` / `web_search` / `read_image` / `pwsh`）+ 实现类 4 个（`write` / `edit` / `apply_patch` / `str_replace_editor`）+ 执行类 5 个（`run_code` / `terminal_open` / `terminal_read` / `terminal_send` / `terminal_signal`）共 17 个被拦工具；MCP 命名的工具（`mcp__*`）、终端生命周期工具（`terminal_close` / `terminal_list`）与上文点名的其余未覆盖工具面（`stagehand_*`、`lsp`、`cordis_inspect_*`、`session_event_read` / `session_event_search` / `session_event_trace` / `session_search` / `session_trace`、`create_worktree`）是已知未覆盖的边界，理由见上文《Lead 门禁的永远放行清单》；其余全是「工具照常放行 + 经 `agent.inject` 投递一次前缀 `[team-gate]` 提醒」的软提醒：nested 成员白名单外工具、flat 成员派子代理、向已完成成员 `send_message` 或把 `team_task_update` 的 claim / reassign 落到已完成成员头上（前缀 `[team-gate] TEAM_MEMBER_FINISHED:`）、同一 turn 内连续两次 `wait_agent` 的空转、以及子代理模型被覆盖时的留痕（前缀 `[team-gate] MODEL_OVERRIDE:`，判据见下文《子代理模型路由》的「模型覆盖留痕」行）。每 agent 每种提醒只投递一次（`remindOnce`）。 |
| 读取会话事件失败 | `ctx.logger.warn` 记录原因，本次不注入。 |

门控不落盘：`commandState(session)` 取会话事件里**最后一条** `command/run`（`data.name === 'using-agent-team'`），用 `parseCommandInput` 解析：去空白后为空或 `on`（不区分大小写）→ `{enabled:true}`，`off`（不区分大小写）→ `{enabled:false}`，其它文本 → `{enabled:true, task:原文}`；无记录 → `{enabled:false}`，事件不可读 → `TypeError`。`enabledIn(session)` 是 `commandState(session).enabled` 的薄封装，`tools/pre-execute` 门禁语义不变。section 文本：开启无任务 = 原 nudge；开启有任务 = nudge + `\n\n本会话任务（/using-agent-team 下达，持续有效）：` + 任务原文；关闭 = 空串。member 会话没有自己的 `command/run` 记录，插件经可选的 `agentTeams.tryMembership(agent)` 拿到 `root`（Lead）会话再判定；没有 `agentTeams` 服务时退回本会话门控。提醒是提示词级约束；`tools/pre-execute` 侧只有 Lead 门禁（取证类 8 + 实现类 4 + 执行类 5，共 17 个工具）返回硬 `deny`，成员侧（nested 白名单外、flat 派子代理、已完成成员、`wait_agent` 空转）一律放行 + 一次 `[team-gate]` 软提醒；判定依据读不到或评估异常时 fail-open 放行并只留下一次 warn 日志。

依赖 `commands`、`systemPrompt` 与 `subagents`：`inject = ['commands', 'systemPrompt', 'subagents']`，Cordis 在三个服务就绪后才调用 `apply`（`subagents` 是子代理模型路由注入——包裹 `startActivation`——的前提）；`ctx.get` 是一次性快照，若返回空（isolate 场景），`apply` 经 `ctx.logger.warn` 点名缺失服务并返回——提示与命令停用，门禁仍独立生效。

## 两种模式（`mode`）

`mode` 取值 `'nested'`（默认）| `'flat'`，在插件设置里切换；非法值按 `'nested'` 处理。

- `nested`：现状——Lead 派成员，成员必须再派 subagent 干活。
- `flat`：成员不派子代理、成员自己执行；Lead 每收到一条成员消息先判定该成员本次任务是否完成，完成即软踢出：`interrupt_agent` 中断该成员 + `team_task_update` 关闭任务，之后不再 `send_message`、不再复用该成员。
- 宿主（DSH 0.2.1-rc.5）没有删除成员的 API，flat 的「踢出」是软踢出（中断当前 turn + 不再唤醒），成员记录仍在 roster 里。
- flat 不放宽 Lead 门禁：Lead 自己的取证类、实现类与执行类工具同样硬拒（判据与被拦工具见上文《行为》表）；成员自己执行这些工具不受该门禁限制。

## 子代理模型路由（默认 deepseek-v4.1-flash，可配置）

`/using-agent-team` 开启的会话里，插件在 `apply` 中包裹 `ctx.subagents.startActivation`：开启态下所有**本地 in-process 子代理**（teammate、普通 `subagent`、`subagent_fork`、`workflow`）的 `request.agentOptions` 都强制为默认路由 `provider = 'dsh-opencode-go'`、`model = 'deepseek-v4.1-flash'`；该默认值可由插件 Config 的 `member` / `subagent` 字段分别覆盖，`enabled: false` 时完全透传（不注入、不删 `reasoningEffort`）。子代理不再继承 Lead 的 LLM 路由。**本插件是默认路由的唯一来源，不依赖 `dsh-plugin-subagent-director` 提供任何模型默认值。**

插件 Config（`index.js` 的 `export const Config`，根节点 `.volatile()`）：

| Config 字段 | 默认值 | 行为 |
| :--- | :--- | :--- |
| `enabled` | `true`（bool） | `false` = 完全透传：不注入 `agentOptions`，也不删 `reasoningEffort`。 |
| `mode` | `'nested'` | `'flat'` = 只用成员、成员不派子代理，Lead 收到成员消息判定完成后 interrupt_agent 软踢出（软踢出 ≠ 删除）；非法值按 nested 处理并 warn 一次。 |
| `member.provider` / `member.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | 命中成员判别的子代理用这条路由；flat 模式下成员不派子代理，该路由不生效。 |
| `subagent.provider` / `subagent.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | 未命中成员判别的子代理用这条路由。 |

字段缺省或非法时逐项回退默认值；未配置时的行为与引入 Config 之前一致（固定默认路由、不透传）。根节点 `.volatile()` 使 settings 服务把本插件暴露为可写命名空间，namespace 即插件 entry id `dsh-force-subagent`；覆盖写在 profile 的 `cordis.patch.yml`——在 `- id: dsh-force-subagent` 条目下加 `config:` 块；web profile 默认挂载 HMR，改完该文件会触发 dispose + 重新 apply，**无需重启**。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-force-subagent
  config:
    enabled: true            # false = 完全透传：不注入 agentOptions、不删 reasoningEffort
    member:                  # childId 命中 root 会话 team/member 事件 member.id 集合的子代理
      provider: dsh-opencode-go
      model: deepseek-v4.1-flash
    subagent:                # 其余子代理（含带 childId 但不在集合里的）
      provider: dsh-opencode-go
      model: deepseek-v4.1-flash
```

只写部分字段即可，其余逐项回退默认，例如只换非成员子代理的模型：`config: { subagent: { model: some-model } }`。注入侧读取的是 `apply(ctx, config)` 时的配置；配置文件或设置页改动由 HMR 重新 apply；宿主侧源码 `index.js` 改动需要重启 dsh web host，而浏览器侧 `client.js` 改动由 client-hmr 自动重建并重跑 `apply`，无需重启（见 §部署）。新 `model` 必须同时出现在 `subagent-model-selection-settings.config.allowedModels`，否则核心在 `assertAllowedModelSelection` 抛「not allowed」。

| 事项 | 行为 |
| :--- | :--- |
| 判别依据 | 三件事：① root 会话 `commandState(gateSession).enabled === true`，其中 `gateSession = membership.root.session ?? parent.session`（teammate 父会话自身没有 `command/run` 记录，必须回溯团队 root）；② `subagents.getProvider(spec.provider)?.capabilities?.agentOptions === true`（公开访问器，`subagent/src/index.ts:573-575`）；③ 成员判定 = `childId` ∈ root 会话 `team/member` 事件登记的 `member.id` 集合；`childId` 存在本身不是判据。 |
| 成员 / 子代理路由选择 | ③ 命中 → 用 Config 的 `member` 路由，否则 → 用 `subagent` 路由（两条可配成不同模型）。`member.id` 集合只来自父会话的 `team/member` 事件（agent-team 在 `startActivation` 之前写入，`member.id` 即预分配的 `childId`）；`childId` 存在本身不算命中——子代理续跑也可能带。读事件失败按「非成员」处理并 `ctx.logger.warn` 一次。 |
| 严格覆盖 | 命中即写 Config 的 `provider` / `model`：配置优先于调用方显式给的 `agentOptions`（force 语义），不拼混合路由；`reasoningEffort` 一律删除——调用方显式给了也删，核心只在「路由已变更**且**调用方未显式给」时才清继承档位（见 `child-agent.ts:117`），不能指望核心兜底。其余 `agentOptions` 字段（`maxTokens` 等）保留，入参 `spec` 不被就地改写（组装新 `spec`）。 |
| 模型覆盖留痕（注入模型 ≠ 会话当前模型） | 注入已经发生之后才补留痕，`resolveRoute` 的判定口径一行未动，**覆盖优先不变**（工作区 `workspaces[key][kind]` > 全局 `Config[kind]`）。触发条件：注入的 `provider` / `model` ≠ `gateSession` 的当前模型选择；会话模型取自 `sessionModelSelection`，口径与宿主一致——宿主投影 `modelSelection` 的 `next ?? lastUsed`（`next = pending ?? lastUsed`，见 `packages/core/agent/src/model-selection.ts:86-89`），只比 `provider` + `model`，`reasoningEffort` 不参与比较。留痕两条：① `ctx.logger.warn` 一条，含 session id、会话模型、注入模型与覆盖来源（来源三态逐字取自代码：`工作区 <key> 的 <kind> 条目覆盖` / `未命中任何 workspace key，取全局路由` / `workspace key <key> 无 <kind> 条目，取全局路由`；`kind` 的称呼按 `KIND_LABEL`：`member` → 「成员」、`subagent` → 「子代理」）；② 一条前缀 `[team-gate] MODEL_OVERRIDE:` 的模型可见提醒，复用软门禁既有通道 `remindOnce`（`agent.inject` + notice）。去重口径：同一会话 + 同一注入路由 `kind\|provider/model` 只留痕一次（`WeakMap<会话对象, Set<routeKey>>`，随会话回收）。fail-open：读不到投影 / `modelSelection` 单元未注册 / `provider` 与 `model` 不成对 → 判定不了就不比较、不告警；投影 `snapshot` 抛错 → 只 warn 一次并说明「本次模型覆盖留痕跳过（注入照常执行）」，注入照常、不抛异常；`logger.warn` 自身抛错时 `console.error` 兜底一次并计数，不让告警通道故障被空 catch 吞掉。 |
| 外部 provider | `acp` / `codex` / `claude-code` / `dsh-sdk` 等 `capabilities.agentOptions === false`，原样放行、不注入（它们不收子代理 `agentOptions`，注入会被核心以 UNSUPPORTED_CAPABILITY 拒）。不按 provider 名字特判。 |
| 能力判定 | 用公开访问器 `subagents.getProvider(name)`；拿不到 provider（无 `getProvider` / 返回 `undefined` / 非对象）→ fail-open 不注入、不 warn。 |
| 生效条件 | 仅当本会话 `/using-agent-team` 已开启；未执行命令的会话不注入。 |
| 会话状态不可读 / `getProvider` 抛错 | fail-open：不注入、不抛，`ctx.logger.warn` 只打一次，命令与 `tools/pre-execute` 门禁照旧。 |
| 卸载 / 热重载 | 真实宿主下服务方法经 traceable Proxy 读取（每次读取返回新的函数 Proxy），故 disposer 不做身份比较，改为 `delete` 本插件写入的自有影子属性，让宿主 prototype 方法随之恢复（回写原引用会留下影子属性永久遮蔽原型新方法）；卸载后再次 `apply` 会重新安装包裹。重复 `apply` 由 Symbol 守卫去重，并按次 warn 一次。 |

宿主侧解析在 `resolveChildAgentOptions`：显式 `request.agentOptions` 覆盖 parent 路由，故注入即生效。锚点与失效模式见 [docs/agent-team-api.md](docs/agent-team-api.md) §10。

## 启用

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --dry-run   # 预演：只打印将做的改动，不落盘
./scripts/install.sh             # 安装并接线
```

脚本向 `~/.dsh/profiles/web/package.json` 写入 `"dsh-force-subagent": "file:<仓库绝对路径>"` 依赖、
把 `dsh-force-subagent` 追加进 `dsh.profile.bundles`、并创建
`~/.dsh/profiles/web/node_modules/dsh-force-subagent` → 本仓库的符号链接（改动前自动备份 `package.json`）。
脚本还会把 `@deepseek-ai/schemastery` 镜像进本仓库：`index.js` 顶层 `import Schema from '@deepseek-ai/schemastery'` 用它声明 Config，脚本创建
`<仓库>/node_modules/@deepseek-ai/schemastery` → `~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery` 的符号链接（profile 里没装该包时脚本直接失败）。
**软链缺失时插件加载即失败**（`ERR_MODULE_NOT_FOUND`），宿主不会启动本插件；手工建链也可，但要指向 profile 里那份。

**必须手动重启 dsh web host 才生效**——脚本故意不重启（重启会终止当前 agent 会话）。
完整步骤、验证命令与排错见 [docs/install.md](docs/install.md)。

插件自带 [cordis.patch.yml](cordis.patch.yml)，由 `package.json` 的 `dsh.bundle.patch` 自动应用，注册与开关**无需手改 profile 的 patch 文件**（路由 Config 覆盖仍写在 profile 的 patch 里，见上文示例）。
`dsh plugin --profile web add link:<repo>` 属未验证的替代路径，实测未采用，不要依赖。

## 界面（Web 客户端）

插件在 Web 端提供一块独立面板（main key / 侧栏 id 均为 `dsh-force-subagent`），入口有四处：

| 入口 | 位置 | 说明 |
| :--- | :--- | :--- |
| `sidebar.panellist` | 左侧栏图标 | **常驻入口**；冷启动、无会话时也能打开。 |
| `conversation.hero.options` | 新会话 hero 区 | blank 会话不渲染 header chrome，但渲染这个槽；补上“新会话也要有按钮”。 |
| `conversation.session.header.actions` | 会话头分叉图标 | 非 blank 会话打开面板并自动绑定当前会话所属工作区。 |
| `sidebar.workspaces.session.menu.item` | 会话行「…」菜单 | 与会话头入口等价，适合窄屏。 |

面板行为：

- 顶部状态 chip：就绪 / 加载中 / 不可用 / 未选择工作区 / 允许模型为空。
- 工作区下拉：优先选中入口绑定的工作区；从左侧栏进入时手动选择。保存键仍是 `workspace.path || String(workspaceId)`，与宿主契约一致。
- 成员模型 / 子代理模型均为 **provider + model 下拉**，不再手输。选项来源：
  - 子代理允许模型策略（`subagent-model-selection-settings`）：策略启用时只列 `allowedModels`，避免写入被宿主 `assertAllowedModelSelection` 拒绝的路由；
  - 否则用宿主模型目录 `ctx.get('remote').session.modelCatalog()`（返回 `{ok, value:{groups, failures}}`，`llm/adapters-updated` 时刷新），provider 分组，loading / error / 空态可见；服务不可用时标 `unavailable` 并只保留当前配置；
  - 当前已配置路由始终并入选项；留空表示继承全局默认（`Config.member` / `Config.subagent`）。
- 保存仍走 `form.mutate([{op:'set', path:['enabled']}, {op:'set', path:['workspaces']}, {op:'set', path:['mode']}], fresh.revision)`（顺序见 client.js）：整条 workspaces 覆写 + revision 围栏；provider 与 model 不成对时保存按钮禁用，不会发出 mutate。
- 启用开关是**全局** `Config.enabled`（影响所有工作区）；模型路由按工作区保存。面板文案明确标注“全局”，保存按钮为“保存设置”，避免误以为开关只作用于当前工作区。
- 工作区服务读取失败、允许模型策略不可读时显示 `role="alert"` 的具体原因，不会退化成“没有工作区”，也不会静默放宽 `allowedModels` 围栏。
- 视觉使用宿主 `--dsw-*` / `--ds-*` CSS 变量，支持深浅色、`:focus-visible` 焦点环、`prefers-reduced-motion` 降级；`role="status"` / `role="alert"` 反馈，无外部字体与新增依赖。

## 部署

- 改 `client.js`：client-hmr 约 500ms stat-poll 自动重建并重跑 `apply`，通常无需重启宿主、无需刷新页面；若浏览器仍显示旧版再刷新一次。
- 改 `index.js`、`package.json`、`cordis.patch.yml`：需要重启 dsh web host（脚本故意不重启）。
- 若 host 日志出现 `ERR_MODULE_NOT_FOUND: '@deepseek-ai/schemastery'`，说明本仓库 `node_modules/@deepseek-ai/schemastery` 软链缺失、插件加载失败：重跑 `./scripts/install.sh`（或手工把该软链指向 profile 里那份）后重启。
- 重启前先把 `dsh-plugin-subagent-director` 升级到已删除 `/using-agent-team` 命令的版本。
- 否则两个插件争同名命令：本插件经 `ctx.logger.warn` 告警（点名 `dsh-plugin-subagent-director`，提示升级或卸载），并**跳过自己的命令注册**——section 提示仍照常工作，只是 `/using-agent-team` 由旧插件处理。其他注册错误原样抛出。

## 禁用 / 卸载

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --uninstall
```

移除依赖、bundles 条目与符号链接（保留备份），随后重启 host 生效。插件作用域销毁时 section 与命令随之注销，无需手工清理。

## 契约

开关判定走宿主写入的 `command/run` 会话事件（`text(context)` 内读 `session.snapshotEvents()`），注入走全局 `systemPrompt.section`（`force-subagent:agent-team`，order 57）。成员身份经 `ctx.get('agentTeams')?.tryMembership(agent)` 解析（`role === 'teammate'` 时取 `root.session` 判开关；`text` 侧 `agentTeams` 缺失则退回本会话门控）。`tools/pre-execute` 门禁在 `apply()` 最先独立注册，不依赖 `systemPrompt` / `commands`：这两个服务缺失时仅提示与命令停用（`ctx.logger.warn` + `return`），门禁仍然生效；注册后只有 Lead 侧门禁返回 `{kind:'deny', reason}`（前缀 `[team-gate] LEAD_EVIDENCE_DENIED:`，拦 `LEAD_BLOCKED_TOOLS` = 取证类 `EVIDENCE_TOOLS`（`bash` / `read` / `grep` / `glob` / `web_fetch` / `web_search` / `read_image` / `pwsh`，8 个）∪ 实现类 `IMPLEMENTATION_TOOLS`（`write` / `edit` / `apply_patch` / `str_replace_editor`，4 个）∪ 执行类 `EXECUTION_TOOLS`（`run_code` / `terminal_open` / `terminal_read` / `terminal_send` / `terminal_signal`，5 个），共 17 个），deny 判据见上文《行为》表），成员侧与 flat 成员侧、已完成成员与 `wait_agent` 空转一律放行 + 一次 `[team-gate]` 软提醒；判定依据读不到（无 session / 事件不可读 / 找不到 `turn/start`）、`agentTeams` 缺失、`tryMembership` 抛错或其他异常经闭包变量只 warn 一次（文案点名 `agentTeams` 与「门禁未生效，本次放行」）后 `return next()` 放行。MEMBER_NUDGE 表述为「除编排类与只读工具外会被门禁放行但立即提醒」。不再走 `agent/pre-step` 消息追加；命令 handler 注册在 `apply` 闭包内，用 `agent.steer`（带 task）或 `agent.inject`（其余）向模型投递 notice，`source.kind` 固定为 `force-subagent`、`form` 为 `notice`，投递失败只 `warn` 一次且命令仍返回 success。子代理路由注入同样在 `apply` 内注册：包裹 `ctx.subagents.startActivation`，按 `commandState(parent.session).enabled` 与 `getProvider(spec.provider)?.capabilities?.agentOptions` 判定、命中即按成员判别选用 Config 的 `member` / `subagent` 路由严格覆盖（配置优先于调用方显式 `agentOptions`）并一律删除 `reasoningEffort`，包裹经 `ctx.effect` 注销。注入后 `observeRouteOverride` 只在「注入模型 ≠ 会话当前模型」时留痕：一次 `ctx.logger.warn`（session id / 会话模型 / 注入模型 / 覆盖来源）加一条前缀 `[team-gate] MODEL_OVERRIDE:` 的提醒，去重口径是同一会话 + 同一注入路由 `kind|provider/model` 一次；会话模型读自 `sessionModelSelection`（投影 `modelSelection` 的 `next ?? lastUsed`），读不到投影、单元未注册或 provider/model 不成对就不比较不告警，投影读取抛错只 warn 一次且注入照常执行、不抛；覆盖优先不变。接口契约见
[docs/agent-team-api.md](docs/agent-team-api.md) 与 [docs/prompt-plugin-api.md](docs/prompt-plugin-api.md)。
