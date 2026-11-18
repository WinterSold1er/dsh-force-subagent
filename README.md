# dsh-force-subagent

用 `/using-agent-team` 命令按会话开启"强制委派"提示的 DSH 宿主插件，零依赖、无构建（纯 ESM）。

## 行为

插件在 `apply` 里向 `systemPrompt` 注册一个 section（`force-subagent:agent-team`，order 57），并注册 `/using-agent-team` 命令。命令每次执行都向模型投递一条 `source.kind = 'force-subagent'` 的 notice：带 `<task>` 走 `agent.steer`（空闲起一轮、运行中下一步送达），`on` / 裸命令 / `off` 走 `agent.inject`（不唤醒）；会话中途输入立即生效。

| 输入 | 行为 |
| :--- | :--- |
| `/using-agent-team`、`on` | 立即开启本会话提醒：之后每轮都注入强制委派提示，持续到 `off`；命令自身投递一条开启提醒。 |
| `/using-agent-team <task>` | 立即开启并下达任务：投递一条含任务原文的提醒，此后每轮注入的提示尾部持续带上该任务（原文只去首尾空白），直到 `off`。 |
| `/using-agent-team off` | 关闭本会话提醒（`text` 返回 `''`），并投递一条关闭提醒。 |
| 未执行过命令的会话 | 不注入（`text` 返回 `''`）。 |

### 委派提示与门禁

- **按会话自适应，不静态假设工具存在**：提示词按当前会话实际可见的委派工具分三档——team 档（探测到看板 `team_task_create`，用 `team_task_create` 拆解登记）、standard 档（没有看板但有 `subagent` / `subagent_fork`，用 `todo_write` 登记后单轮并行 `subagent` 派成员）、无委派能力档（连 `subagent` / `subagent_fork` 都探测不到：直说没有委派能力、直接执行，不教不存在的工具）。rc.2 默认 standard；在会话里打开 Team 开关后 `team_task_*` 可见，才进入 team 档。
- **只点名当前存在的工具**：注入文案与提醒只说该档位真实可用的名字；`spawn_teammate`、`interrupt_agent`、`subagent_role`、`close_subagent` 这类已删除或未注册的名字不会成为当前档位的行动指令。
- **只提醒、不阻断**：`tools/pre-execute` 从不返回 `deny`；命中判据只投递一条前缀 `[team-gate]` 的提醒，随后 `return next()` 照常执行。每个 turn 至多一条，新 turn 重新计算。
- **「已完成成员」门禁只在 team 档运行**：判定先看向板能力（`caps.board`，即本会话探测到 `team_task_create`）。standard 档（rc.2 默认、Team 开关 OFF）没有看板、也没有「成员名下任务全部 completed」这个判据，整条停用，纪律由注入文案承担；team 档下向已完成成员 `send_message`、或把它 claim / reassign 成任务 owner，会投递一条 `[team-gate] TEAM_MEMBER_FINISHED:` 提醒（仍放行）。
- **命令 notice 也按档位给结论**：`/using-agent-team` 的 notice 不是统一文案，按能力探测分三态——**未确认档（中性）**：命令是本会话第一个动作（还没有任何一轮提示注入或门禁先于它运行），或探测失败只拿到安全默认 → 只说「本会话的真实工具面尚未确认……以本轮系统提示的 Agent-Team 段为准」，既不承诺能委派、也不断言没有委派工具；**非 `none` 档（正面，team / standard）**：`capabilitiesFromNames` 探测到非空的真实工具名集合、确认有看板或 `subagent` / `subagent_fork` → 要求 Lead 只做架构与调度、实现与测试必须委派；**`none` 档（否定）**：探测成功但连 `subagent` 都探测不到 → 明说「本会话未检测到委派工具，强制委派提示不生效」。三档流程细节由每轮注入的提示承担。
- **监控面是「除编排动作外的全部工具」**：`subagent` / `subagent_fork` / `workflow` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `todo_write` / `ask_user_question` / `skill` / `job_*` / 探测到的 `team_task_*` 放行不提醒；其余工具（含 `mcp__*`、未枚举的插件工具）一律按 Lead 亲自下场提醒，不再维护易漂移的白名单。
- **派发过一次不等于整轮免检**：只有 `read` / `grep` / `glob` 在本轮已派发时静默（作为校验产物的豁免）；`write` / `edit` / `bash` / `run_code` 等即使本轮派发过，仍会在本 turn 首次命中时提醒一次。
- **命令语义不变**：`/using-agent-team on|off|<task>` 的解析与开关判定沿用会话事件（`parseCommandInput` 取最后一条 `command/run`），不落盘；成员会话的开关从 Lead 会话回溯。
- **fail-open**：判定依据读不到（无 session、事件不可读、找不到 `turn/start`）时放行并只 warn 一次，不卡死宿主、不刷日志。
- **teammate**：已开启会话的成员注入成员版提醒——nested 成员的第一个业务工具调用必须委派，flat 成员自己执行并在完成后交回 Lead；flat 不因模式放宽 Lead 侧提醒。

详细兼容矩阵（rc.2 破坏性变更、门禁逐项、排查与验证命令）见 [docs/rc2-compat.md](docs/rc2-compat.md)；设计目标见 [docs/rc2-flat-mode-design.md](docs/rc2-flat-mode-design.md)。

## 两种模式（`mode`）

`mode` 取值 `'nested'`（默认）| `'flat'`，在插件设置里切换；非法值按 `'nested'` 处理。

- `nested`：现状——Lead 派成员，成员必须再派 subagent 干活。
- `flat`：成员不派子代理、成员自己执行；Lead 每收到一条成员消息先判定该成员本次任务是否完成，完成即软踢出：当前会话有 `interrupt_agent` 时用它中断该成员（Team 开关同时打开时再用 `team_task_update` 关闭任务），没有该工具时以 `send_message` 交回结果、此后不再唤醒该成员；之后不再 `send_message`、不再复用该成员。
- 宿主（rc.1 / rc.2）没有删除成员的 API，flat 的「踢出」是软踢出（中断当前 turn 或交回后不再唤醒），委派记录仍然存在。
- flat 不放宽 Lead 提醒：Lead 自己的取证类、实现类与执行类工具同样按上文《行为》的判据投递提醒后放行；成员自己执行这些工具不受该提醒约束。

## 子代理模型路由（默认 deepseek-v4.1-flash，可配置）

`/using-agent-team` 开启的会话里，插件在 `apply` 中包裹 `ctx.subagents.startActivation`：开启态下所有**本地 in-process 子代理**（teammate、普通 `subagent`、`subagent_fork`、`workflow`）的 `request.agentOptions` 都强制为默认路由 `provider = 'dsh-opencode-go'`、`model = 'deepseek-v4.1-flash'`；该默认值可由插件 Config 的 `member` / `subagent` 字段分别覆盖，`enabled: false` 时完全透传（不注入、不删 `reasoningEffort`）。子代理不再继承 Lead 的 LLM 路由。**本插件是默认路由的唯一来源，不依赖 `dsh-plugin-subagent-director` 提供任何模型默认值。**

插件 Config（`index.js` 的 `export const Config`，根节点 `.volatile()`）：

| Config 字段 | 默认值 | 行为 |
| :--- | :--- | :--- |
| `enabled` | `true`（bool） | `false` = 完全透传：不注入 `agentOptions`，也不删 `reasoningEffort`。 |
| `mode` | `'nested'` | `'flat'` = 只用成员、成员不派子代理，Lead 收到成员消息判定完成后软踢出（有 `interrupt_agent` 才中断，否则交回后不再唤醒；软踢出 ≠ 删除）；非法值按 nested 处理并 warn 一次。 |
| `member.provider` / `member.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | 命中成员判别的子代理用这条路由；flat 模式下成员不派子代理，该路由不生效。 |
| `subagent.provider` / `subagent.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | 未命中成员判别的子代理用这条路由。 |
| `reviewer.provider` / `reviewer.model`（可选第三类路由，也可写在 `workspaces[key].reviewer`） | 无默认值（schema 两段默认空串，`DEFAULT_CONFIG` 里不含 `reviewer` 键） | 仅当该次激活被识别为「审查代码」时参与判定（判据见下表《审查代码路由》）。provider 与 model 必须同时非空：只配一半（只有 provider 或只有 model）整条忽略并 warn 一次（warn-once = 同一配置位置每进程只提醒一次：全局 `reviewer` 与某个 `workspaces.<key>.reviewer` 各算一次，配置改好后同一位置再次半残不会在本进程内重复提醒；重启或热重载重新 apply 后才重新计数），绝不注入残缺路由。优先级：工作区 `reviewer` → 全局 `reviewer` → 该激活原本的 `member` / `subagent` 路由。未配置时注入行为与引入该字段前完全一致（向后兼容）。 |

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
    # reviewer:              # 可选：审查代码的激活（如 name: "reviewer"）单独用的路由；整段省略 = 不启用
    #   provider: dsh-opencode-go
    #   model: deepseek-v4.1-flash
    # workspaces:            # 可选：按工作区覆盖同类路由，键是 `workspace.path || String(workspaceId)`
    #   /home/csy/Code/Github/dsh-force-subagent:
    #     reviewer:          # 只给这个工作区的审查代码激活换模型；该条目没写的 member / subagent 回退 `DEFAULT_CONFIG` 默认路由（不是全局 `Config.member` 的覆盖值）
    #       provider: dsh-opencode-go
    #       model: deepseek-v4.1-flash
```

只写部分字段即可，其余逐项回退默认，例如只换非成员子代理的模型：`config: { subagent: { model: some-model } }`。`reviewer` 是唯一不适用逐项回退的路由：它要么 provider 与 model 都配齐、要么整段省略，只配一半会被整条忽略（并 warn 一次，同一配置位置每进程只提醒一次），不会被补成默认路由。注入侧读取的是 `apply(ctx, config)` 时的配置；配置文件或设置页改动由 HMR 重新 apply；宿主侧源码 `index.js` 改动需要重启 dsh web host，而浏览器侧 `client.js` 改动由 client-hmr 自动重建并重跑 `apply`，无需重启（见 §部署）。新 `model` 必须同时出现在 `subagent-model-selection-settings.config.allowedModels`，否则核心在 `assertAllowedModelSelection` 抛「not allowed」。

| 事项 | 行为 |
| :--- | :--- |
| 判别依据 | 三件事：① root 会话 `commandState(gateSession).enabled === true`，其中 `gateSession = membership.root.session ?? parent.session`（teammate 父会话自身没有 `command/run` 记录，必须回溯团队 root）；② `subagents.getProvider(...)?.capabilities?.agentOptions === true`（公开访问器，`packages/subagent/subagent/src/index.ts` 的 `getProvider`）；③ 成员判定 = `childId` ∈ root 会话 `team/member` 事件登记的 `member.id` 集合；`childId` 存在本身不是判据。 |
| 成员 / 子代理路由选择 | ③ 命中 → 用 Config 的 `member` 路由，否则 → 用 `subagent` 路由（两条可配成不同模型）。`member.id` 集合只来自父会话的 `team/member` 事件（agent-team 在 `startActivation` 之前写入，`member.id` 即预分配的 `childId`）；`childId` 存在本身不算命中——子代理续跑也可能带。读事件失败按「非成员」处理并 `ctx.logger.warn` 一次。 |
| 审查代码路由（`reviewer`，可选第三类） | 只有当该次激活被 `index.js` 的 `isReviewerActivation(spec, request)` 识别为「审查代码」时，才去查 `reviewer` 路由。判定从严到宽三段，`description` / 提示文案里的「审查」二字从不参与判定：① 激活给了 `name`（`subagent` / `subagent_fork` 的显式成员名）时**只认名字本身**——`reviewer`、`reviewer-1`、`code-reviewer`、`adversarial-reviewer`、`review`、`code-review` 这一类（`REVIEWER_NAME_RE`）；名字是明确的命名意图，给了非 reviewer 的名字即使 label 写着「实现审查代码模型」也不改判，绝不回落到 label。② 没有 `name` 时看 `request.agentPreset`（宿主 preset id 与成员名同一套语法）。③ 两者都没有（未命名的激活：未给 `name` 的 `subagent` / `subagent_fork`、`workflow` 等）才看 `label`，且只认「这条任务本身就是审查代码」的写法，label 判据只有两条（`REVIEWER_LABEL_RE`，以及「整条 label 小写后本身就是一个 reviewer 名字」的 `REVIEWER_NAME_RE`）：`REVIEWER_LABEL_RE` 一律锚定在 label 开头（`^\s*(?:please\s+)?` 只容忍前置空白与 `please` 礼貌前缀），审查词组之后必须紧跟结尾或分隔符 `$ \s : ： - — ( （`；词组族为 ① `code[\s_-]*review(?:er)?`（`code review`、`code-review`、`codereview`、`code reviewer`），② `review` / `reviewing` 后必须接明确的代码审查宾语（可带冠词 `the` / `this` / `that` / `a` / `an`，宾语 `code` / `diff` / `pr` / `changes` / `impl\w*` / `patch` / `commit` / `pull request`，如 `review the diff`、`review impl`、`reviewing changes`），或整条 label 就是 `review` / `reviewing`，或 `review` / `reviewing` 紧跟冒号或左括号且其后只有**数字**轮次编号并到此结束（词族 `round` / `pass` / `iter` / `iteration` / `轮` / `第` / `批` / `次` + 可选空白 + 可选 `#` + **必需的数字**，或裸 `#数字` / 纯数字；命中例 `review: round 2`、`review: round2`、`review: 第 3`、`review (第 3)`、`review (#3)`、`review (2)`；`review: round two`、`review: 3rd`、`review: 第 2 轮`、`review: 批次 7`、`review: round 2 附加说明` 都不命中——编号必须是数字且位于 label 结尾，缺冒号或左括号的 `review #3`、`review round 2` 也不命中）——带非代码宾语的写法（`review 需求文档`、`review 面板文案`、`review the docs`、`review 配置迁移`）一律不算，③ 中文族 `代码审查`、`审查代码`、`对抗审查`、`代码评审`、`评审代码`；判据一律锚定在 label 开头，**不做任意位置的子串匹配**（旧版曾有一条 `REVIEWER_LABEL_PHRASE_RE = /\bcode[\s_-]+review(?:er)?\b/`，已删除）。中文实现类任务的 label（`实现审查代码模型`、`修复代码审查bug`）、以及英文审查词组只出现在 label 中间或末尾的实现类 label（`修复 code review 面板的崩溃`、`实现 code review 能力`、`给 code-review 加个按钮`、`修复 code review 的 bug`、`implement code review feature`、`add code review button`）都不算——这类文案里的 `code review` 是待处理的对象，不是这条任务自身的意图。误判代价不对称：假阳性会把实现类任务送进审查代码模型（有害），假阴性只是回退到原本的 `member` / `subagent` 路由（安全），故该判据严格优先、宁可漏判。命中后的优先级链：`workspaces[key].reviewer` → 全局 `Config.reviewer` → 该激活原本的 `member` / `subagent` 路由（`reviewer` 未配置时 `resolveRoute` 返回 `undefined`，`kind` 与注入路由都与引入该字段前完全一致）。注入语义与既有两条路由完全一致：写顶层 `agentOptions` 的 provider/model、无条件删 `reasoningEffort`、rc.1 嵌套形状同步写回、入参 `spec` 不被就地修改（见下一行《严格覆盖》），模型覆盖留痕同样适用（`kind` 显示为「审查代码」）。Lead 每轮注入的提示里也带一句「审查代码的成员 / 子代理建议命名为 reviewer（如 name: "reviewer"）」，让命名与这套识别规则对齐。 |
| 严格覆盖 | 命中即写 Config 的 `provider` / `model`：配置优先于调用方显式给的 `agentOptions`（force 语义），不拼混合路由；`reasoningEffort` 一律删除——调用方显式给了也删，核心只在「路由已变更**且**调用方未显式给」时才清继承档位（见 `packages/subagent/subagent/src/child-agent.ts` 里该条件分支），不能指望核心兜底。其余 `agentOptions` 字段（`maxTokens` 等）保留，入参 `spec` 不被就地改写（组装新 `spec`）。 |
| 模型覆盖留痕（注入模型 ≠ 会话当前模型） | 注入已经发生之后才补留痕，`resolveRoute` 的判定口径一行未动，**覆盖优先不变**（工作区 `workspaces[key][kind]` > 全局 `Config[kind]`）。触发条件：注入的 `provider` / `model` ≠ `gateSession` 的当前模型选择；会话模型取自 `sessionModelSelection`，口径与宿主一致——宿主投影 `modelSelection` 的 `next ?? lastUsed`（`next = pending ?? lastUsed`，见 `packages/core/agent/src/model-selection.ts` 的 `modelSelection` 单元：状态字段 `lastUsed` / `pending`，view 暴露 `next`），只比 `provider` + `model`，`reasoningEffort` 不参与比较。留痕两条：① `ctx.logger.warn` 一条，含 session id、会话模型、注入模型与覆盖来源（来源三态逐字取自代码：`工作区 <key> 的 <kind> 条目覆盖` / `未命中任何 workspace key，取全局路由` / `workspace key <key> 无 <kind> 条目，取全局路由`；`kind` 的称呼按 `KIND_LABEL`：`member` → 「成员」、`subagent` → 「子代理」、`reviewer` → 「审查代码」）；② 一条前缀 `[team-gate] MODEL_OVERRIDE:` 的模型可见提醒，复用软门禁既有通道 `remindOnce`（`agent.inject` + notice）。去重口径：同一会话 + 同一注入路由 `kind\|provider/model` 只留痕一次（`WeakMap<会话对象, Set<routeKey>>`，随会话回收）。fail-open：读不到投影 / `modelSelection` 单元未注册 / `provider` 与 `model` 不成对 → 判定不了就不比较、不告警；投影 `snapshot` 抛错 → 只 warn 一次并说明「本次模型覆盖留痕跳过（注入照常执行）」，注入照常、不抛异常；`logger.warn` 自身抛错时 `console.error` 兜底一次并计数，不让告警通道故障被空 catch 吞掉。 |
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
- 三张模型路由卡（成员模型 / 子代理模型 / **审查代码模型**）均为 **provider + model 下拉**，不再手输。选项来源：
  - 子代理允许模型策略（`subagent-model-selection-settings`）：策略启用时只列 `allowedModels`，避免写入被宿主 `assertAllowedModelSelection` 拒绝的路由；
  - 否则用宿主模型目录 `ctx.get('remote').session.modelCatalog()`（返回 `{ok, value:{groups, failures}}`，`llm/adapters-updated` 时刷新），provider 分组，loading / error / 空态可见；服务不可用时标 `unavailable` 并只保留当前配置；
  - 当前已配置路由始终并入选项；留空表示继承全局默认（`Config.member` / `Config.subagent`）。
- 「审查代码模型」是第三张卡（`#fsx-reviewerProvider` / `#fsx-reviewerModel`），写的是本工作区的 `reviewer` 路由：卡片说明为「审查代码成员 / 子代理（如 name="reviewer"）单独使用的模型路由；留空则回退到成员 / 子代理路由」。留空提示的口径与前两张不同——`renderRouteCard` 的 `emptyHint` 参数只对这张卡传入「留空则回退到成员 / 子代理路由」；若全局 `Config.reviewer` 已配齐，提示改为「留空则继承全局默认：<provider> / <model>」。候选模型同时并入本工作区已存的 reviewer 路由与全局 reviewer 路由，否则「留空则回退」指向的那个模型选不回来。保存时留空写入的是 `{ provider: '', model: '' }`，宿主侧 `optionalRoute` 归一化为「未配置」。三张卡、校验与禁用提示共用 `ROUTE_GROUPS` 这一张字段表，新增一组路由不会漏掉校验。设置页只写工作区级的 `reviewer`——保存载荷始终只有 `enabled` / `workspaces` / `mode` 三个 `set` op，全局 `Config.reviewer` 只能在 profile 的 `cordis.patch.yml` 里配（或靠「保存设置到所有工作区」把它逐工作区写出来）。
- 保存仍走 `form.mutate([{op:'set', path:['enabled']}, {op:'set', path:['workspaces']}, {op:'set', path:['mode']}], fresh.revision)`（顺序见 client.js）：整条 workspaces 覆写 + revision 围栏；三组路由中任一组 provider 与 model 不成对时保存按钮禁用，不会发出 mutate。
- 启用开关是**全局** `Config.enabled`（影响所有工作区）；模型路由按工作区保存。面板文案明确标注“全局”，保存按钮为“保存设置”，避免误以为开关只作用于当前工作区。
- 「保存设置到所有工作区」（`#fsx-save-all`）：把**选中工作区**的模型路由，连同全局 `enabled` 与 `mode`，一次写入所有**已枚举**的工作区——仍是一次 `form.mutate`、同一个 revision 围栏；配置里已有但当前枚举不到的工作区条目原样保留，不会被这次写入抹掉。它与“保存设置”共用同一个前提（必须先选中工作区，要广播的路由就取自那个工作区的 draft），区别只在范围：“保存设置”只写当前工作区，广播写全部已枚举工作区。本页不存在“只写全局开关 / 模式”的路径，两个保存都要求先选中工作区。
- 两个按钮被禁用时，原因写在保存条下方的可见文案里（同时点名两个按钮），不只是按钮的 `title`——键盘与屏幕阅读器读不到 `title`。不成对时的文案点名是哪张卡（`<卡名>的 provider 与 model 需成对选择`）：三张卡共用一句不带主语的「需成对选择」会把用户支到别的路由上去改。成员容量是全局单值（宿主 `subagent` 命名空间的 `maxActiveSubagents`），不参与该广播，仍由「应用容量」单独写入，详见下文《成员容量与嵌套深度》。
- 工作区服务读取失败、允许模型策略不可读时显示 `role="alert"` 的具体原因，不会退化成“没有工作区”，也不会静默放宽 `allowedModels` 围栏。
- 视觉使用宿主 `--dsw-*` / `--ds-*` CSS 变量，支持深浅色、`:focus-visible` 焦点环、`prefers-reduced-motion` 降级；`role="status"` / `role="alert"` 反馈，无外部字体与新增依赖。

## 内置 skills（随包分发，自动注册）

插件自带 4 个 team 技能：`team-adversarial-gatekeeper`、`team-lead-delegation`、`team-parallel-dispatch`、`team-recursive-orchestration`。它们随包分发（`package.json` 的 `files` 已包含 `skills`），安装后直接出现在技能列表，不需要手工拷贝到 `~/.dsh/skills`。

- 注册方式：走宿主 `skills` 服务的 `skills.registerProvider`。优先延迟注入（`ctx.inject(['skills'], …)`）——插件静态 `inject` 里**没有** `skills`，写进去会让没装 skill 层的宿主整个插件不 apply、门禁静默失效；`ctx.inject` 不可用时退化到 `ctx.get('skills')`，注销器交给 `ctx.effect` 托管。
- 每条 skill 的身份：`rank = 550`（宿主 `BUNDLED_SKILL_RANK = 600` 是打包 provider 与本地 bundled 根共用的口径，本插件取 550，数值上更低）、`source = 'custom'`、`provider = 'dsh-force-subagent'`，`invocation` 为 model + user 均可调用；`name` 取 SKILL.md frontmatter 的 `name`，缺省用目录名，且必须符合宿主语法（小写字母 / 数字 / 连字符）。
- 按需只读加载：`list()` 只扫本包 `skills/<name>/SKILL.md` 的 frontmatter 出候选（`name` / `description` 与可选的 `whenToUse`，正文留到 `get()` 才读）；`get()` 解析完整定义并给出 `resourceBase: { kind: 'directory', path: <该 skill 目录> }`，供正文里的相对引用。目录位置由 `import.meta.url` 推出，是包的装配事实，不是用户配置。
- 降级口径：`skills` 服务缺失（headless 组合 / 未装 skill 层的宿主）安静降级，不抛也不 warn，门禁与委派提示完全不受影响；本包没有 `skills` 目录（ENOENT）按空集合处理；真实的目录读取失败、SKILL.md 缺 frontmatter、skill 名不合法各自 warn 一次（warn-once = 同一原因每进程只提醒一次：模块级 Set 按问题键去重，同一问题在本进程内再次出现不会重复告警；重启 / 热重载重新 apply 后才重新计数）。内置 skills 是增值能力，不会拿门禁 / 提示主功能去换。
- 卸载：provider 由注入 scope 或 `ctx.effect` 托管，插件 scope 销毁时随之注销。
- 与本地技能目录的重名口径（条件式）：宿主 skill registry 跨层由最近的一层直接胜出，`rank` 只在同一层内决定重名、同层 rank 越小越优先——只有当 `~/.dsh/skills`（宿主 `user-dsh` 根，rank 400）与本插件（550）同在 global 层时，才是 400 优先于本插件、本插件优先于同层的宿主打包 bundled 根（600）；若 provider 落在更近的层，同名由本插件胜出，与 550 / 400 的大小无关。当前实际状态（2026-11-18 14:05 起）：`~/.dsh/skills/team-*` 四份旧拷贝已迁移到 `~/.dsh/backups/skills-team-20261118-140511/`，`~/.dsh/skills` 已无同名条目，所以现在命中的是随包 provider（550）；若把旧拷贝放回 `~/.dsh/skills`，同层按 rank 400 胜出。确认命中来源的自检（比对 `list()` 结果的 `source` / `path`）见 [docs/install.md](docs/install.md) 的《内置 skills》一节。

四份 SKILL.md 已按 DSH 0.2.2-rc.2 的真实工具面收编：成员用 `subagent` / `subagent_fork` 拉起（不再有 `spawn_teammate`），看板用 `todo_write` 这类真实工具（不再有 `team_task_*`），模型与思考强度由插件路由配置决定、不由派发参数决定，审查员成员统一命名为 `reviewer` 以命中上文「审查代码模型」路由。

## 部署

- 改 `client.js`：client-hmr 约 500ms stat-poll 自动重建并重跑 `apply`，通常无需重启宿主、无需刷新页面；若浏览器仍显示旧版再刷新一次。
- 改 `index.js`、`package.json`、`cordis.patch.yml`：需要重启 dsh web host（脚本故意不重启）。
- 若 host 日志出现 `ERR_MODULE_NOT_FOUND: '@deepseek-ai/schemastery'`，说明本仓库 `node_modules/@deepseek-ai/schemastery` 软链缺失、插件加载失败：重跑 `./scripts/install.sh`（或手工把该软链指向 profile 里那份）后重启。
- 重启前先把 `dsh-plugin-subagent-director` 升级到已删除 `/using-agent-team` 命令的版本。
- 否则两个插件争同名命令：本插件经 `ctx.logger.warn` 告警（点名 `dsh-plugin-subagent-director`，提示升级或卸载），并**跳过自己的命令注册**——section 提示仍照常工作，只是 `/using-agent-team` 由旧插件处理。其他注册错误原样抛出。

### 全量测试（仓库侧验收，不依赖宿主进程）

```bash
cd /home/csy/Code/Github/dsh-force-subagent
node --test "tests/**/*.test.js"
```

全量口径 = `tests/` 下全部 `*.test.js` **含 `tests/verify/`**（`using-agent-team.test.js` 的 18 个契约用例）。当前基线：**682 tests / 682 pass / 0 fail**（682 是下限，新增用例只增不减）。旧写法 `node --test tests/*.test.js` 只覆盖 26 个文件、664 个用例，会把 `tests/verify/` 漏在口径外；`node --test tests/` 与上面的 glob 等价（同为 682），但 glob 更明确。

## 禁用 / 卸载

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --uninstall
```

移除依赖、bundles 条目与符号链接（保留备份），随后重启 host 生效。插件作用域销毁时 section、命令与内置 skills provider 随之注销，无需手工清理。

## 宿主版本边界（0.2.2-rc.1 / 0.2.2-rc.2）

插件对两代宿主都能跑，差异集中在工具面与注入文案、成员身份、团队事件与容量四处。

| 判定点 | 0.2.2-rc.1 | 0.2.2-rc.2 |
| :--- | :--- | :--- |
| 成员身份 | `ctx.get('agentTeams').tryMembership(agent)` 直接给出 `role` / `root` / `name` | 该 API 已删除。插件改用委派树推导：`ctx.get('subagents').rootOf(agent)` 返回自己 → Lead；`session.header.delegationDepth === 1` 的后代 → 成员；深度 ≥ 2 不是团队成员，既不按 Lead 也不按成员门禁评估 |
| 团队事件 | `team/member`（花名册）+ `team/task` | 只有 `team/mode` 与 `team/task`。「已完成成员」判定改读 `team/task` 的 `ownerId`，Lead 自身会话 id 作为 owner 不算已完成成员 |
| 成员寻址 | Team 版 `send_message(target=名字)` | `send_message(agent=名字, message=文本)`：参数只有 `agent`（`list_agents` 展示的名字）与 `message`，没有 `target` / `agent_id`，`list_agents` 也没有 `scope`；`team_task_update` 的 `owner` 用模型侧名字，由宿主 `subagents.resolveName` 解析 |
| 成员容量 | 插件把 `maxMembers` 写进 `agent-team` 条目并改写运行时 | 插件不写任何配置文件。容量旋钮是宿主 `subagent` 服务的 volatile 字段 `maxActiveSubagents`（默认 8） |
| 嵌套深度 | 无此约束 | `subagent.maxDepth`（默认 1）。nested 模式要让成员再派子代理，必须 ≥ 2，否则成员派子代理会被宿主拒绝 |
| `agent-team` 可配置项 | `maxMembers` / `maxTasks` / `maxMessageBytes` / `disposalTimeoutMs` | 只剩 `maxTasks` 与 `defaultEnabled`；把已删除的键写进任一 patch 层会让 agent-team 服务在构造期抛 `TEAM_INVALID_CONFIG`，整个 Team 能力失效 |

身份推导是**结构性**的：rc.2 没有花名册，插件只能认出「委派树的根」与「根的直接后代」。Lead 用 `subagent` 派出的成员即深度 1；成员再派的子代理（深度 2）不再受本插件的成员门禁约束，这一点是宿主能力边界，不是插件的放宽。

`spawn_teammate` 在 rc.1 是真实注册的工具，rc.2 已删除；`subagent_role` / `close_subagent` 两代都没有注册。**插件不再保留这些旧工具名常量，也没有把它们放进任何判据集合**（`grep -c spawn_teammate index.js` 计数为 0）：档位、注入文案与门禁只按当前会话探测到的真实工具名决定（`capabilitiesFromNames` → `delegationTier`），同一套逻辑在 rc.1 上照样成立——那里这些工具是真实探测到的，而不是被写死在名字表里。提示词与提醒文案按会话实际工具面分档（见上文《行为》），team 档才提 `team_task_*` / `interrupt_agent`，standard 档只提 rc.2 真实存在的工具；rc.2 的破坏性变更与验证命令见 [docs/rc2-compat.md](docs/rc2-compat.md)。

### 成员容量与嵌套深度

`/team-limit [整数]` 与面板的「团队成员容量」卡片读写同一个来源——宿主 `subagent` 命名空间：读优先取运行中的 subagent 服务（`config.maxActiveSubagents.get()`），其次取 settings 文档里 `ns === 'subagent'` 的条目，两处都读不到就如实报告读不到（不拿内置默认值冒充当前值）；写经 `settings.update('subagent', { maxActiveSubagents })`，深度同写 `maxDepth`，由宿主持久化进 profile 层 patch 并即时生效。插件不打开任何 patch 文件，也不改写别的插件实例；宿主因更高优先级配置层拒绝覆盖时，面板与命令原样贴出宿主原文。

手工固定写法：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: subagent
  config:
    maxActiveSubagents: 1024
    maxDepth: 2
```

### 回滚

- 代码回滚：仓库无自动写入行为，把 `index.js` / `client.js` / `tests/` 恢复到目标版本后重启 dsh web host 即可（改 `index.js` 需要重启，改 `client.js` 由 client-hmr 自动重建）。
- 容量回滚：本插件不再往任何 patch 文件写成员上限；若你在 rc.2 上用过 `/team-limit` 或面板「应用容量」，宿主已把取值写进 profile 层 patch 的 `- id: subagent` 条目——回滚就是删掉该 `config:` 块（或改回原值）并重启 host。残留的 `agent-team.maxMembers` 一类旧键必须一并删除，否则 agent-team 服务构造期即失败。
- 插件卸载：`./scripts/install.sh --uninstall` 后重启 host。

## 契约

开关判定走宿主写入的 `command/run` 会话事件（`text(context)` 内读 `session.snapshotEvents()`），注入走全局 `systemPrompt.section`（`force-subagent:agent-team`，order 57）。成员身份经 `resolveMembership` 解析：`agentTeams.tryMembership` 存在（rc.1）就原样采用其结论，否则用 `ctx.get('subagents').rootOf(agent)` 加会话头 `delegationDepth` 推导（rc.2，见上文《宿主版本边界》）；`role === 'teammate'` 时取 `root.session` 判开关。`tools/pre-execute` 门禁在 `apply()` 最先独立注册，不依赖 `systemPrompt` / `commands`：这两个服务缺失时仅提示与命令停用（`ctx.logger.warn` + `return`），门禁仍然生效；注册后没有任何一处返回拒绝结果：Lead 侧对「除编排动作外的全部工具」（含 `mcp__*` 与未枚举的插件工具）投递一次 `[team-gate]` 提醒后 `return next()` 放行：`write` / `edit` / `bash` / `run_code` / `terminal_*` 等无论是否派发过都提醒，`read` / `grep` / `glob` 只在本轮已派发时豁免，判据见上文《行为》；成员侧与 flat 成员侧、已完成成员（仅 team 档，先判 `caps.board`）与 `wait_agent` 空转同样一律放行 + 一次 `[team-gate]` 软提醒；判定依据读不到（无 session / 事件不可读 / 找不到 `turn/start`）、身份或事件读不到等异常经闭包变量只 warn 一次（文案说明「门禁未生效，本次放行」）后 `return next()` 放行。不再走 `agent/pre-step` 消息追加；命令 handler 注册在 `apply` 闭包内，用 `agent.steer`（带 task）或 `agent.inject`（其余）向模型投递 notice，`source.kind` 固定为 `force-subagent`、`form` 为 `notice`，投递失败只 `warn` 一次且命令仍返回 success。子代理路由注入同样在 `apply` 内注册：包裹 `ctx.subagents.startActivation`，按 `commandState(parent.session).enabled` 与 `getProvider(spec.provider)?.capabilities?.agentOptions` 判定、命中即按成员判别选用 Config 的 `member` / `subagent` 路由（被 `isReviewerActivation` 识别为审查代码的激活先取可选的 `reviewer` 路由，未配置则回退前者）严格覆盖（配置优先于调用方显式 `agentOptions`）并一律删除 `reasoningEffort`，包裹经 `ctx.effect` 注销。注入后 `observeRouteOverride` 只在「注入模型 ≠ 会话当前模型」时留痕：一次 `ctx.logger.warn`（session id / 会话模型 / 注入模型 / 覆盖来源）加一条前缀 `[team-gate] MODEL_OVERRIDE:` 的提醒，去重口径是同一会话 + 同一注入路由 `kind|provider/model` 一次；会话模型读自 `sessionModelSelection`（投影 `modelSelection` 的 `next ?? lastUsed`），读不到投影、单元未注册或 provider/model 不成对就不比较不告警，投影读取抛错只 warn 一次且注入照常执行、不抛；覆盖优先不变。接口契约见
[docs/agent-team-api.md](docs/agent-team-api.md) 与 [docs/prompt-plugin-api.md](docs/prompt-plugin-api.md)。
