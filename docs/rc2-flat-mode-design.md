# rc.2 flat 模式设计方案（工具面自适应委派）

> 状态：设计稿，未改代码。唯一可写文件 = 本文。
> 取证：`forensics/rc2-tool-inventory.md`（rc.2 工具面 + toolSet 探测 API）、`forensics/plugin-stale-refs.md`（S1–S8 漏洞）、`index.js` / rc.2 checkout 源码逐行核对。
> 结论先行：**不按版本号判断，按「当前 step 真实可见的工具」判断**；rc.2 走标准委派文案（`subagent` / `subagent_fork` / `send_message` / `list_agents` / `wait_agent` / `todo_write`），rc.1 走原文案；探测失败一律降级为标准文案，绝不提已删除工具。

> **实现偏差说明（实现定稿后回填，正文按原稿保留）**：本设计稿与实现有一处判据差异——设计稿把 team 档判据写成「探测到 `spawn_teammate`」（§0 维度表的 `toolProfile` 行、§1.3 伪代码 `TOOL_MARKERS` 的 `spawn` 项、§2.4「team 档（rc.1）」）。实现按「探测到看板 `team_task_create`」判定 team 档：rc.2 只有 `team_task_*` 可探测，且每个工具注册带会话 Team 开关的 `when`（打开开关即进 team 档）；`spawn_teammate` 已被 rc.2 删除，作为判据永远不会命中，所以实现的 `TOOL_MARKERS` 里没有 `spawn` 项，档位判定走 `capabilitiesFromNames` → `delegationTier`（`caps.board`）。其余部分（探测点与 `toolSet` 必传、降级链、文案分档、命令 notice 分档、门禁新规则、已完成成员门禁仅 team 档生效、测试清单）均按本文落地。逐条实现事实见 [rc2-compat.md](rc2-compat.md)。

## 0. 背景与根因（简）

- rc.2 删除 `spawn_teammate`（commit `11479fca13`），成员创建统一为 `subagent` / `subagent_fork`；`send_message({ agent, message })` 用名字寻址；`list_agents({})` 无 `scope`；`team_task_*` 变成根会话 Team 开关下的可选插件；shipped 组合里 `interrupt: false`（commit `6cc45f22bd`），`interrupt_agent` 不下发。
- 本插件在 `8e9d60c` 只适配了「成员身份 / 容量」，注入文本与门禁仍是 rc.1 形状（以下引用为当时的符号名，不写行号——行号随实现漂移）：`LEAD_NUDGE` 教 `team_task_create`，`FLAT_LEAD_APPENDIX` 教 `interrupt_agent` / `team_task_update`，`leadGateReminder` 也教 `team_task_create`；`send_message` 取参读 `target` / `agent_id`，而 rc.2 schema 是 `agent`。
- 唯一可执行出路只剩 `subagent`；更糟的是门禁在「本轮出现过任意 `DISPATCH_TOOLS`」后整轮静默（旧门禁里的 `dispatchedAt >= 0` 提前 `return next()`），Lead 调一次 `subagent` 再自己 `bash` / `write` 就无人提醒。这不是模型不听话，是**插件给出的指令不可执行 + 监控面被一次派发整体关闭**。

本设计把两个正交维度分开，避免「flat」一词继续含糊：

| 维度 | 取值 | 来源 | 含义 |
| --- | --- | --- | --- |
| `toolProfile` | `team` / `standard` | **运行时探测**（本文 §1） | team = 检测到看板工具（原稿写作 `spawn_teammate`，实现改用 `team_task_create`，见顶部《实现偏差说明》）；standard = 只有 `subagent` 系列（rc.2） |
| `mode` | `nested` / `flat` | 现有配置（不变） | 只决定**成员**能否再派子代理；不参与 Lead 文案选择 |

文案 = `f(role, toolProfile, mode)`；`toolProfile` 决定工具名与看板/收敛句，`mode` 只决定成员「是否允许派子代理」那一段。

## 1. 检测策略：section 渲染期按 `context.toolSet` 探测（选 A）

### 1.1 裁决

**选 A：在 section `text(context)` 与 `tools/pre-execute` 的 `exec.toolSet` 上做特性探测。**
不选 B（版本判断）：没有可靠的运行时版本服务；`engines.dsh: ">=0.2.1-rc.1"` 同时允许 rc.1/rc.2，本机 `dsh --version` 甚至是 rc.1 而 host 跑 rc.2 checkout；rc.2 的 `agentTeams` 服务仍存在、但 `team_task_*` 是可选项且受根会话开关控制——服务存在 ≠ 工具可见。加载期探测还会被插件注册顺序打败。
不选 C（静态双份 + 条件从句）：已删除的工具名会随每轮注入反复出现，模型会照着调；两套文本也会漂移。

### 1.2 API 证据（全部 rc.2 checkout）

> 下表路径已逐条对 rc.2 源码树核实存在；行号可能漂移，以文件内的符号名 / 字段名为准。

| 环节 | 证据 |
| --- | --- |
| `text` 是每轮求值的回调 | `packages/core/system-prompt/src/index.ts:64` |
| `AssembleContext` 基础字段 `{scope,signal}` | 同文件 `:42-49`（merge-extensible） |
| 扩展出 `agent` / `modelSelection` | `packages/core/agent/src/runtime-types.ts:19-24` |
| 扩展出 `toolSet` | `packages/core/tools/src/index.ts:19-23` |
| 先定工具、再装配 prompt | `packages/core/agent-loop/src/agent.ts:298-300`：`tools.resolve(...)` → `systemPrompt.assemble({ ...assembleContextFor(this, signal), toolSet })` |
| `scope` 与 `agent` 同给 | `packages/core/agent/src/dispatch.ts:174-176` |
| 可见工具清单 / 点查 | `packages/core/tools/src/index.ts:305-307` `definitions(scope?, toolSet?)`、`:239-240` `get(name, scope?, toolSet?)` |
| `when` 在 resolve 时求值 | 同文件 `:264-280` |
| gate 侧 `exec.toolSet` | `packages/core/tools/src/contracts.ts:190`（`ToolExecutionInput.toolSet`） |
| 宿主自己的同款写法 | `packages/subagent/tool-subagent-control/src/index.ts:90-105`：`text({ agent, scope, toolSet })` + `ctx.tools.get(name, scope, toolSet)` |

**硬约束：必须传 `toolSet`。** 省略它读到的是「注册期可见」集合，`when` 门控的工具（如 `team_task_*`）会误报存在（见 `forensics/rc2-tool-inventory.md` §4.2）；这正是 rc.2 上最危险的误判方向。

### 1.3 关键伪代码

> 伪代码按原稿保留。实现里的 `TOOL_MARKERS` 没有 `spawn` 项，team 档判据是 `board`（`team_task_create`）；探测入口符号是 `capabilitiesFor`，能力装配是 `capabilitiesFromNames`。

```js
const TOOL_MARKERS = {
  spawn: 'spawn_teammate', board: 'team_task_create', interrupt: 'interrupt_agent',
  subagent: 'subagent', fork: 'subagent_fork', control: 'send_message', list: 'list_agents', wait: 'wait_agent',
}

function capsFor(ctx, scope, toolSet, warnOnce) {
  let tools
  try { tools = ctx.get('tools') } catch { tools = undefined }
  // 探测失败 = 安全默认 standard；绝不猜 team
  if (!tools || typeof tools.definitions !== 'function' || toolSet === undefined) {
    warnOnce('工具面探测失败（tools 服务缺失或 toolSet 未提供），降级为标准委派文案')
    return { probed: false, team: false, board: false, interrupt: false,
             subagent: true, fork: true, control: true, wait: true }
  }
  try {
    const names = new Set(tools.definitions(scope, toolSet).map(d => d.name))
    return { probed: true, team: names.has(TOOL_MARKERS.spawn), board: names.has(TOOL_MARKERS.board),
             interrupt: names.has(TOOL_MARKERS.interrupt), subagent: names.has(TOOL_MARKERS.subagent),
             fork: names.has(TOOL_MARKERS.fork), control: names.has(TOOL_MARKERS.control),
             list: names.has(TOOL_MARKERS.list), wait: names.has(TOOL_MARKERS.wait) }
  } catch (error) {
    warnOnce(`工具面探测抛错（${error instanceof Error ? error.message : String(error)}），降级为标准委派文案`)
    return { probed: false, /* 同上 standard 默认 */ }
  }
}
```

- section：`text(context)` 取 `{ agent, scope, toolSet }`；`agent` 缺失返回 `''`。
- gate：`tools/pre-execute` 取 `exec.agent` + `exec.toolSet` 调同一函数。
- **不缓存**：每次装配 / 每次工具调用重算（几次 Map 查询，成本可忽略）；升级、preset 切换、中途 `tools/change` 都在下一步生效，不存在「升级前开、升级后继续」的残留。
- 探测成功且 `!team && !subagent`（完全没有委派工具）→ section 返回 `''`，门禁不提醒，命令仍可执行但 notice 明说「未检测到委派工具」。

### 1.4 降级链（安全默认 = standard）

1. `tools.definitions(scope, toolSet)` 成功 → 精确判定。
2. `toolSet` 缺失 / `tools` 服务缺失 / `definitions` 抛错 → **standard 文案**（只提 `subagent` / `subagent_fork` / `send_message` / `list_agents` / `wait_agent` / `todo_write`）；`ctx.logger.warn` 每次 apply 只打一条。
3. `team_task_create` 单独可见（rc.2 Team 开关打开）但无 `spawn_teammate` → 仍是 standard，但把看板句换成 `team_task_*`；不改变「派发用 `subagent`」。
4. 探测成功且没有任何委派工具 → 不注入、不提醒（避免「拿到指令但无法执行」）。

## 2. 注入文案最终稿（只出现真实工具名）

两档总览（本文的「flat 档」= rc.2 标准工具面；「nested 档」= rc.1 team 工具面；配置里的 `mode` 是第三维，只影响成员能否再派子代理）：

| 档位 | 判定 | Lead | 成员 |
| --- | --- | --- | --- |
| flat 档 | `caps.team === false`（有 `subagent` 系列） | §2.1 | §2.2 / §2.3（按 `mode`） |
| nested 档 | `caps.team === true`（`spawn_teammate` 可见） | 现有 `LEAD_NUDGE`（+`mode=flat` 的 appendix） | 现有 `MEMBER_NUDGE` / `MEMBER_NUDGE_FLAT` |

### 2.1 Lead（standard / rc.2，默认：有 subagent、fork、send_message、list_agents、wait_agent；无 team_task_*、无 interrupt_agent）

```text
本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭）。
【铁律】Lead 只做架构、拆解、调度、仲裁与验收：不亲自写代码、不亲自跑验证命令、不亲自取证。
【派发】先拆成互不依赖的小任务（写范围互斥、依赖只写真实依赖）；单轮内并行 subagent 拉起全部成员（需继承上下文用 subagent_fork），用 list_agents 记下成员名，不要串行建一个等一个。
【调度】成员并行执行；被阻塞才 wait_agent 一次（同 turn 不连续两次），收到消息立即处理；成员交回后不再 send_message，新活再派新成员；本会话没有中断成员的工具，不要声称中断或删除成员。
【看板】任务与进度用 todo_write 维护。
【验收】交付前单轮派独立成员做对抗验收（真实跑测试、看 diff），不通过派回重做，Lead 不自己验收。
【旧→新】已删除：spawn_teammate→subagent/subagent_fork；team_task_create→todo_write；team 版 send_message→标准 send_message；interrupt_agent/team_task_update 无对应。
【提醒】本轮未派发时自己动 bash/read/grep/write/edit 等取证、实现、执行工具，会收到一次 [team-gate] 提醒；工具照常执行。
```

- 628 字；硬上限 650，测试断言（原 `LEAD_NUDGE` 约 1000+ 字，缩短约 40%）。
- `【旧→新】` 是**唯一允许出现删除名的段落**，且以「已删除、不要调用」开头；其余段落一律不得出现 `spawn_teammate|team_task_*|interrupt_agent|subagent_role|close_subagent`。

**条件槽位**（按 `caps` 替换，不新增段落）：

| 条件 | 替换 |
| --- | --- |
| `caps.board` | `【看板】任务与进度用 team_task_create / team_task_update 登记。`，同时 `【旧→新】` 的 `team_task_create→todo_write` 改为 `team_task_create 已可用` |
| `caps.interrupt` | `成员完成后用 interrupt_agent 收敛（名字取 list_agents 的输出），此后不再 send_message。` |
| `!caps.wait` | `本会话没有 wait_agent：不要空转等待，直接处理已有结果。` |
| `!caps.fork` | `本会话没有 subagent_fork：需要继承上下文时用 subagent，并在任务描述里带上必要背景。` |
| `!caps.control` | `本会话没有 send_message / list_agents：成员结果以 subagent 返回为准。` |

### 2.2 成员（standard，`mode=flat`）

```text
你是 Agent-Team 成员（flat：本团队只用成员、不派子代理；你就是 Lead 直接派出的 subagent，用 list_agents 给出的名字被寻址）。Lead 已启用强制委派提示：分给你的任务自己执行——read / grep / glob 取证、write / edit 改代码、bash 跑命令与测试都由你完成；完成后用 send_message 把结果交回 Lead（收件人用 list_agents 给出的名字），不要等其它成员。任务与进度用 todo_write 登记；本会话没有中断成员的工具，不要声称被中断或删除。只做自己这一小块，做完立即交回。
```

≈289 字；硬上限 310。

### 2.3 成员（standard，`mode=nested`）

```text
你是 Agent-Team 成员（nested：可再派子代理；你是 Lead 直接派出的 subagent，用 list_agents 给出的名字被寻址）。Lead 已启用强制委派提示：加载必需技能后，本轮第一个业务工具调用必须是委派（subagent / subagent_fork）；拆分子任务、划清写范围后单轮批量派发，read / grep / glob 只用于校验产物，合并与校验由你做；宿主有委派深度上限，派不出就回报 Lead。完成后用 send_message 把结果交回 Lead（收件人用 list_agents 给出的名字）；任务与进度用 todo_write 登记；本会话没有中断成员的工具，不要声称被中断或删除。
```

≈319 字；硬上限 340。成员侧同样受 §2.1 条件槽位约束（`board` / `interrupt` / `control`）。

### 2.4 team 档（rc.1）

`caps.team === true`（实现里对应 `caps.board === true`，判据是 `team_task_create`，见顶部《实现偏差说明》）时**原样复用**现有常量，零改动：`LEAD_NUDGE` +（`mode==='flat'` 时）`FLAT_LEAD_APPENDIX`；成员 `MEMBER_NUDGE` / `MEMBER_NUDGE_FLAT`。用「文本哈希相等」的回归测试锁死。注意：这些旧文案里点名 `team_task_create` / `interrupt_agent`，在 rc.1 真实存在；在 rc.2 永不进入该分支。

### 2.5 命令 notice（`/using-agent-team`）同步分档

- `on|off|<task>` 解析语义完全不变（`parseCommandInput`）。
- `on` 的模型可见 notice：team 档保留 `team_task_*` 句；standard 档改为「实现与测试必须拆解后单轮并行 `subagent` 委派」；无委派工具档追加「本会话未检测到委派工具，提示不生效」。
- 结果 kind 不变（始终 success/error），避免 UI 行为变化。

## 3. 门禁新规则（`[team-gate]`）

### 3.1 分类

| 类别 | 工具 | 处理 |
| --- | --- | --- |
| 编排动作（允许） | `subagent`、`subagent_fork`、`send_message`、`list_agents`、`wait_agent`、`todo_write`、`skill`、`job_*`；team 档另加 `team_task_*`、`interrupt_agent`、`subagent_role`、`close_subagent`、`workflow` | 不提醒，直接放行 |
| 校验（有条件豁免） | `read`、`grep`、`glob` | 本轮**未派发** → 提醒；本轮**已派发** → 静默（只当校验用） |
| 硬接管（始终提醒） | `write`、`edit`、`apply_patch`、`str_replace_editor`、`bash`、`run_code`、`terminal_*` | 无论本轮是否派发过，**每个 turn 至多投递一次** |
| 外部取证（始终提醒） | `web_fetch`、`web_search`、`read_image`、`pwsh` | 同硬接管（外部取证不属「校验产物」） |

### 3.2 关键修正：删除「派发过一次 → 整轮静默」

现状（修复前 `tools/pre-execute` 门禁里的 `dispatchedAt >= 0` 提前返回；不再标行号，以符号名为准）：本轮只要有一个 `DISPATCH_TOOLS` 调用就直接 `return next()`。改为：

```js
const dispatched = thisTurn.some(ev => ev?.type === 'tool/call' && DISPATCH_TOOLS.has(ev?.data?.name))
if (VALIDATION_TOOLS.has(tool) && dispatched) return next()   // read/grep/glob 的校验豁免
remindOnce(agent, `lead-evidence:${turnStart}`, leadGateReminder(tool, caps, dispatched))
return next()
```

- 去重 key 仍为 `lead-evidence:${turnStart}`：**一个 turn 至多一条**（保持既有机制与测试口径）。
- `write` / `edit` / `bash` / `run_code` 在派发后仍会提醒 → 消除 S1「一次 subagent 换整轮免检」。
- `read` / `grep` / `glob` 的校验豁免用于保留「Lead 合并与校验」的正当动作，避免提醒泛滥。

### 3.3 文案两态（只提当前存在的工具）

```text
[team-gate] 提醒：本轮还没有派发成员，{取证|实现|执行}工具「{tool}」仍会照常执行。正确做法：先把工作拆成互不依赖的小任务（写范围互斥、依赖只写真实依赖），再在单轮内并行 subagent 派成员承接（需要继承上下文用 subagent_fork，看板用 todo_write）；Lead 只做拆分、派发、合并与校验。本轮只提醒一次，新 turn 开始后会再提醒一次。
```

```text
[team-gate] 提醒：本轮已派发成员，但你仍在亲自执行{取证|实现|执行}工具「{tool}」——派发不等于放手：实现与执行必须由成员完成，Lead 只做拆分、派发、合并与校验。本轮只提醒一次，新 turn 开始后会再提醒一次。
```

- 有 `team_task_create` 时，第一态把「看板用 todo_write」换成「看板用 team_task_*」；无 `subagent_fork` 时删掉括号里的 fork 句。
- 提醒始终是 **notice（`agent.inject` + notice 形态）**，不返回 deny：现有全部门禁都是软提醒（commit `a6329bc`），阻断会在身份/事件读不到或没有成员可派时直接毁掉用户 turn；本设计不改变这条契约。

### 3.4 会话中途工具集变化

- **不冻结、不缓存**：section 每个 step 重新装配、gate 每次调用重新探测，升级/换 preset 后下一步自动换文案；`/using-agent-team` 的启用状态存在会话事件里，升级后继续有效，无需重开。
- 同一 turn 内探测结果变化（极罕见）：仍受 `lead-evidence:${turnStart}` 限制，只提醒一次；文案用**当次** caps，不混用。
- 探测失败后恢复：下一次装配若 `toolSet` 可用即回到精确判定，无需重启。

### 3.5 已完成成员门禁（TEAM_MEMBER_FINISHED）

- standard 档**停用**：rc.2 不写 `team/member`，`idsByName` 恒空；`send_message` 参数是 `agent`（名字）而非 `target`/`agent_id`，现有判定必然失效（S3）。
- 规则改由文案承担：「成员交回结果后不再 `send_message`，新活派新成员；没有 `interrupt_agent` 不要声称中断/删除」。
- team 档保留；若将来 rc.2 启用 subagent 生命周期事件，可作为 P2（监听 `subagent/end` 按 id 标记）再补，不在本期范围。

## 4. 兼容矩阵

| 环境 | 探测结果 | Lead 注入 | 成员注入 | 门禁 | `/using-agent-team` |
| --- | --- | --- | --- | --- | --- |
| 0.2.1-rc.1（team 工具齐全） | `team=true` | 现有 `LEAD_NUDGE`（+`mode=flat` 的 appendix），**逐字节不变** | 现有 `MEMBER_NUDGE` / `MEMBER_NUDGE_FLAT` | 新规则（§3）同样生效（只增加「派发后硬接管」提醒，不阻断）；已完成成员门禁保留 | on/off/task 不变 |
| rc.2 标准面（本会话：subagent/fork/send_message/list_agents/wait_agent） | `team=false, subagent=true` | §2.1 standard | §2.2 / §2.3 | 软提醒；read/grep/glob 派发后豁免；硬接管始终可提醒 | on/off/task 不变；notice 去掉 team_* |
| rc.2 打开 Team 开关（多出 `team_task_*`，仍无 spawn） | `team=false, board=true` | §2.1 + 看板槽位 | 同上 + 看板槽位 | 同 rc.2 标准面 | 同上 |
| rc.2 打开 interrupt | `interrupt=true` | §2.1 + 收敛槽位 | 同上 | `interrupt_agent` 视为编排，不提醒 | 同上 |
| 探测失败（无 tools / 无 toolSet / definitions 抛错） | `probed=false` | §2.1 standard（warn 一次） | standard | 只按静态触发集提醒，文案 standard | 同上 |
| 无任何委派工具 | `subagent=false, team=false` | `''`（不注入） | `''` | 不提醒 | 命令仍成功，notice 说明「未检测到委派工具」 |

`mode`（nested/flat）在所有行都只影响成员侧「是否允许派子代理」一句，Lead 文案不受影响；这修掉了 S6 里「全局 mode 翻转影响所有会话」的不可预期性——toolProfile 是每会话探测，mode 仍是全局配置，但两者不再共同决定 Lead 工具名。

## 5. 测试清单（行为断言，新增/修改）

**探测（核心）**

1. `toolSet` 含 `spawn_teammate` → `team` 档，Lead 文本含 `team_task_create` / `interrupt_agent`（rc.1 回归）。
2. `toolSet` 只有 `subagent/fork/send_message/list_agents/wait_agent` → standard；对 Lead、成员、gate notice、命令 notice 统一断言**不得出现**：`spawn_teammate`、`team_task_create|get|list|update`、`interrupt_agent`、`subagent_role`、`close_subagent`（`【旧→新】` 行先剥离再断言）。
3. 同一注册表：`team_task_create` 注册了 `when` 且该 `when` 不通过 → 传 `toolSet` 时不可见；省略 `toolSet` 时可见。断言实现**必须**把 `toolSet` 传给 `definitions(scope, toolSet)`（fake 记录第二参 + 两种结果对照），防止「注册期可见」误判。
4. `tools` 服务缺失 / `definitions` 抛错 / `toolSet === undefined` → standard 文案 + 每次 apply 一条 warn，不抛。
5. 无任何委派工具 → section 返回 `''`；命令返回 success 且 notice 含「未检测到委派工具」。

**文案**

6. Lead standard 长度 ≤ 650 字；成员 flat ≤ 310、nested ≤ 340；`task` 只追加一次、不重复铁律。
7. team 档文本与现有常量严格相等（哈希/字符串），成员 flat/nested 选择不变。
8. 条件槽位：board/interrupt/wait/fork/control 五组开关分别断言替换句出现、旧句消失。

**门禁**

9. standard：turn 内首个 `bash`（未派发）→ 恰好 1 条 notice，工具仍执行（`next()` 被调）；同 turn 第二次 `bash` → 仍 1 条。
10. 新 `turn/start` 后再 `bash` → 第 2 条。
11. 派发 `subagent` 后 `write` → **仍提醒**，文案为「本轮已派发成员…派发不等于放手」，不得整轮静默（S1 回归）。
12. 派发后 `read` / `grep` / `glob` → 不提醒（校验豁免）。
13. 先 `read`（提醒）再 `write` 同 turn → 仅 1 条（每 turn 至多一次）。
14. 编排动作（`send_message` / `list_agents` / `wait_agent` / `todo_write`，team 档的 `team_task_*` / `interrupt_agent`）永不触发 Lead 提醒；成员调 `bash` 不触发 Lead 门禁。
15. `exec.toolSet` 缺失时 gate 文案降级 standard，不抛、不改放行。

**命令/兼容**

16. `/using-agent-team on|off|<task>` 解析与结果 kind 不变（迁移现有用例）；standard 下 notice 不含已删除工具名。
17. 中途工具集变化：同一 fake 连续两次装配换 `toolSet` → 文本随之变化；同 turn 内 gate 仍至多 1 条。
18. 全量旧测试：补 `tools` fake 后 rc.1 用例全部保持通过（现有 fake ctx 没有 `tools`，会走 fail-safe，必须显式注入 team 工具集才能锁旧文案）。

## 6. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 漏传 `toolSet` / 用了 `get(name, scope)` 旧写法 | 把不存在的 `team_task_*` 当可用（最危险，教模型调死工具） | 只允许 `definitions(scope, toolSet)`；测试 3 专门锁死；code review 检查 |
| 误判成 standard（明明有 team 工具） | 少用看板/中断，但仍可 `subagent` 完成工作 | 安全方向；warn 日志带 caps 指纹；`toolProfile:'legacy'` 可强制回旧文案 |
| 文案漂移 / 两套文本不同步 | 模型收到互相矛盾的指令 | 单一 builder + 条件槽位；删除名测试 + 长度上限 + team 文本哈希回归 |
| 派发后仍硬提醒 `write/bash` | 少量噪音 | 每 turn 至多一次 + 文案区分「校验豁免」；仍为软提醒，不阻断 |
| 只读校验被豁免后 Lead 用 `read` 拼凑实现 | 绕过实现门禁 | `write/edit/bash/run_code` 始终提醒；`read` 无法产出代码，风险可接受 |
| rc.1 回归 | 旧会话文本/命令变化 | team 文本逐字节冻结；命令解析不改；gate 新规则只在「派发后硬接管」增加提醒 |
| 探测失败静默失效 | Lead 完全不被提醒 | 失败降级 standard（不是不注入）；warn 一条含原因 |
| 性能 | 每 step 一次 `definitions()` | 仅 Map 遍历（可见工具 ~几十个），无缓存换取正确性 |

**回滚开关**

1. 配置 `toolProfile: 'auto' | 'legacy' | 'standard'`（`DEFAULT_CONFIG` 增字段，默认 `auto`；无 UI，settings JSON 可写）。`legacy` = 强制走 `caps.team` 旧文案（rc.1 回滚）；`standard` = 强制新文案（探测异常时的逃生口）。
2. `/using-agent-team off`：运行时关闭全部注入与提醒（既有语义，不变）。
3. 插件级：移除 section / 命令注册即完全停用；`cordis.patch.yml` 只有 `insert: dsh-force-subagent`，无版本约束需要回滚。
4. 所有门禁保持 notice + `next()`，任何探测异常都不会阻断工具调用，最坏情况退化为「无提醒」。

---

**实现落点（给实现者，不改本文件）**：`index.js` 新增 `capsFor()`、`leadStandardNudge(caps)`、`memberStandardNudge(mode, caps)`、`leadGateReminder(tool, caps, dispatched)`；`text(context)` 取 `{agent, scope, toolSet}`；`tools/pre-execute` 取 `exec.toolSet`；`inject` 追加 `'tools'`（或保留 lazy `ctx.get('tools')`，两者都行，前者让注册表就绪更确定）；`DISPATCH_TOOLS` 早退删除；`send_message` 参数在 team 档补 `agent`；命令 notice 分档。`client.js` 无工具名，不需要改。
