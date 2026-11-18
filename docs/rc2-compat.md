# rc.2 兼容说明（`dsh-force-subagent` / Agent Team）

> 适用于 DSH `0.2.2-rc.2`（对照 `0.2.1-rc.1`）。本文分三层：**用户会看到什么** → **实现事实（按符号名引用）** → **验证命令**。实现以当前 `index.js` 为准；设计取舍与备选方案见 [rc2-flat-mode-design.md](rc2-flat-mode-design.md)，工具面取证见 [../forensics/rc2-tool-inventory.md](../forensics/rc2-tool-inventory.md)。

## 1. 用户会看到什么

rc.2 把旧的 Team 工具删了、改了 schema，并把看板工具挂到**会话级 Team 开关**下。插件不再静态假设某组工具存在，而是按当前会话实际可见的委派工具决定提示词与门禁：

| 档位 | 判定（本会话可见的委派工具） | 你会看到的提示 |
| :--- | :--- | :--- |
| team | 有看板 `team_task_create` | 用 `team_task_create` 拆解并登记看板，再单轮并行 `subagent` 派成员 |
| standard | 没有看板，但有 `subagent` / `subagent_fork` | 用 `todo_write` 登记任务板，再单轮并行 `subagent` 派成员（rc.2 默认档） |
| 无委派能力 | `subagent` / `subagent_fork` 都不可用 | 直说「本会话没有委派能力，直接执行」，不教不存在的工具，也不静默 |

- **rc.2 默认是 standard 档**；在会话里打开 Team 开关后 `team_task_*` 才可见，此时进入 team 档。探测不到工具面时按 standard 档兜底（不会猜成 team 档）。
- **提示词只点名当前档位真实存在的工具**：team 档才出现 `team_task_*` 与 `interrupt_agent`（后者还要求会话里真的可见）；standard 档只出现 `subagent` / `subagent_fork` / `send_message` / `list_agents` / `wait_agent` / `todo_write`。
- **rc.2 的委派路径**：用 `subagent`（同进程）或 `subagent_fork`（继承上下文）创建成员；`list_agents` 查看成员（无参数，返回名字）；`send_message({ agent: 成员名, message })` 交回或追问；`wait_agent` 等待。没有 `spawn_teammate`，`send_message` 也没有 `target` / `agent_id`。
- **门禁只提醒、不阻断**：`[team-gate]` 提醒后工具照常执行，每 turn 至多一条；派发过成员只让 `read` / `grep` / `glob` 的校验动作静默，`write` / `edit` / `bash` / `run_code` 等仍会提醒（派发过一次 ≠ 整轮免检）。
- **`/using-agent-team on|off|<task>` 语义不变**：`on`/裸命令开启，`off` 关闭，其它文本视为开启并附带持续任务；开关存在会话事件里，不落盘。

## 2. 实现事实（rc.2 破坏性变更 + 证据）

> 本文对 `index.js` 的引用一律用「符号名 + 功能」（函数/常量名 + 它在做什么），不写行号——`index.js` 持续演进，行号必漂移。宿主源码路径与 commit 只作为取证入口；个别仍需行号的地方（forensics 取证条目、宿主源码片段）按「行号可能漂移，以符号名 / 条目名为准」处理。

| 变更 | rc.2 事实 | 取证入口（`forensics/rc2-tool-inventory.md` 条目；行号可能漂移，以条目内容 / commit 为准） |
| :--- | :--- | :--- |
| `spawn_teammate` 删除 | 无任何注册，仅剩客户端死标签；成员改由 `subagent` / `subagent_fork` 创建 | `forensics/rc2-tool-inventory.md` 的「已删除工具」条目 + commit `11479fca13` |
| `list_agents` 无 `scope` | `parameters: {}`，不再有 `scope` 开关 | 同上文件 `list_agents` 条目 + commit `3cd0624b8d` |
| `send_message` 只有 `agent` + `message` | 参数只有成员名字与正文；rc.1 的 Team 版 `target` 已不存在 | 同上文件 `send_message` 条目 |
| `interrupt_agent` 配置关闭 | 源码仍在，但内置组合写死 `interrupt: false`，不下发给模型 | 同上文件 `interrupt_agent` 条目 + commit `6cc45f22bd` |
| `team_task_*` 受会话 Team 开关门控 | 默认 `defaultEnabled: false`；只有根会话能改开关；每个工具注册带 `when: enabled(agent)`，开关 OFF 时不可见 | 同上文件「工具清单」条目 + 「Team 开关机制」条目 |
| rc.2 没有「flat 模式」 | `flat` 是本插件自定义概念，宿主不认 | 同上文件「宿主不认 flat」条目 |
| 看板工具「时有时无」的机制 | Team 开关默认关闭 + `when` 门控 + 只有根会话可写 `team/mode` | 同上文件「Team 开关机制」条目 |

### 2.1 插件怎么探测（rc.2）

- **探测点**：section 的 `text(context)` 与 `tools/pre-execute` 的 `exec` 上取 `context.toolSet` / `exec.toolSet`，交给 `capabilitiesFor()`（探测「本步真实可见的工具清单」→ 产出能力快照 `caps` 的唯一入口）。`toolSet` 必传：省略它读到的是注册期可见集合，会把 Team 开关 OFF 时的 `team_task_*` 误判为存在（`capabilitiesFor` 内两条分支：`capabilitiesCache` 命中直接返回、`toolSet` 缺失立即降级）。
- **三档判定**：`delegationTier(caps)`——探测到看板 `team_task_create`（`TOOL_MARKERS.board`）→ `team`；否则有 `subagent` / `subagent_fork` → `standard`；否则 `none`。能力字段由 `capabilitiesFromNames(工具名集合)` 装配，`caps.board` 就是「本会话有没有看板」。
- **探测失败（四种，一律降级、绝不猜 team）**：走 `fallbackCapabilities()`——① 宿主 `tools` 服务不可用 / `definitions` 不是函数；② 当前步 `toolSet` 缺失；③ `tools.definitions(scope, toolSet)` 抛错；④ **探测结果为空**（名字集合为空：宿主在 `toolSet` 已 dispose 或 `scope` 与本步解析者不一致时返回空清单，不能当成「已确认本会话没有委派工具」）。四种分别由 `noteToolProbeFallback` 打出对应 warn，每次 apply 只 warn 一次。兜底内容 = 只承诺 rc.2 稳定存在的委派名词（`STANDARD_CAPABILITIES`）；若宿主 Team 开关为 ON，再把 `board` 置回 true（还原 team 档的看板句），读开关失败则保持 standard。
- **文案按能力拼装**：`leadNudge()`（Lead 标准委派文案）、`flatLeadAppendix()`（flat 模式追加段）、`memberNudge()`（成员版）；看板 / 中断 / fork / workflow / send / list 等条件槽位只在探测到对应工具时出现（`planningHint`、`dispatchHint`、`leadGateSentence`）。
- **按步求值**：`capabilitiesFor` 用 `capabilitiesCache`（`WeakMap`，以 `toolSet` 对象为键）；升级宿主或切换 preset 后，下一步重新装配即重新探测，不冻结旧结论。
- **命令 notice 按档位分三态**：`buildNotice` 的正文来自 `reminderText` → `leadClause(caps)`，caps 取本会话最近一次真实探测。三种文案分支与触发条件是：
  - **未确认档（中性）**：`caps === undefined` 或 `caps.probed !== true`——即命令是本会话第一个动作（还没有任何一轮 section 注入或门禁先于它装配），或探测失败只拿到 `STANDARD_CAPABILITIES` 安全默认 → 「本会话的真实工具面尚未确认，是否具备委派能力以本轮系统提示的 Agent-Team 段为准」。既不承诺「能委派 / 必须委派」，也不否定「没有委派工具」，把判断让给同轮随后装配的 section。
  - **非 `none` 档（正面，team · standard）**：只有探测成功才走这支——判据是 `capabilitiesFromNames` 拿到**非空真实工具名集合**、`caps.probed === true`，且 `delegationTier(caps)` 为 `team` 或 `standard` → 「你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须委派（本会话真实可用的委派工具见系统提示的 Agent-Team 段）」。
  - **`none` 档（否定）**：探测成功但连 `subagent` / `subagent_fork` 都探测不到 → 「本会话未检测到委派工具，强制委派提示不生效……直接执行任务即可，不要声称已派发成员」。`off` 后是 `DISABLED_REMINDER`。三档的完整流程说明由 section 注入承担，notice 只给这一句结论。

## 3. 门禁规则（`[team-gate]`）

- **判定集合**：`isOrchestrationTool()` = `ORCHESTRATION_TOOLS`（`subagent` / `subagent_fork` / `workflow` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `todo_write` / `ask_user_question` / `skill`）+ `isJobTool()` 的 `job_*` 前缀 + **探测到才生效**的 `team_task_*`（探测失败 `caps.probed === false` 时也放行，避免把真实看板调用误判成「下场干活」）。
- **监控面 = 除编排动作外的全部工具**：`mcp__*`、`office_*`、未枚举的插件工具都按「Lead 亲自下场」处理，不再维护 17 个硬编码名字。
- **哪些豁免**：`VALIDATION_TOOLS`（`read` / `grep` / `glob`）仅当**本轮已派发**（`DISPATCH_TOOLS` = `subagent` / `subagent_fork` / `workflow`）时静默；未派发时同样提醒。
- **派发过一次 ≠ 整轮免检**：`write` / `edit` / `apply_patch` / `str_replace_editor` / `bash` / `run_code` / `terminal_*` / `web_fetch` / `web_search` / `read_image` / `pwsh` 及未枚举工具，无论本轮是否派发过都提醒（`leadGateReminder` 的两态文案按 `dispatched` 与档位措辞）。
- **每 turn 至多一次**：`remindOnce` 去重 key 为 `lead-evidence:${turnStart}`（`turnStart` = 最后一个 `turn/start` 的下标），容器是 `WeakMap<会话对象, Set<key>>`；新 turn 令牌变化后重新提醒。
- **只提醒、不阻断**：全插件没有任何 `{ kind: 'deny' }` 返回，提醒经 `agent.inject` 以 notice 形态投递后 `return next()`。
- **无委派能力档**：提醒直说「无法派发成员，工具由你直接执行」，并提示检查 `subagent` 服务与 `maxDepth`。
- **fail-open**：无 session、事件不可读、找不到 `turn/start`、读取抛错 → 放行 + `warnFailOpen` 只 warn 一次。
- **已完成成员门禁只在 team 档运行**：门禁分支先判 `caps.board`（= 本会话探测到 `team_task_create`）。standard 档（rc.2 默认、Team 开关 OFF）没有看板，就没有「成员名下任务全部 completed」这个判据，**整条门禁停用**，纪律改由注入文案承担（设计 §3.5）。team 档下才对 `send_message` 与 `team_task_update`（`action` 为 `claim` / `reassign`）生效：用 `memberByName` 按名字找成员、按 Lead 根会话的 `team/task` 事件判「已完成」，命中投递一次 `[team-gate] TEAM_MEMBER_FINISHED:`（`finishedMemberReminder`），仍放行。sender 是谁都受拦（Lead 与其它成员一样）。
- **区分方式（怎么知道当前是哪一档）**：看 Team 开关——ON → `team_task_*` 可见 → `caps.board` 为真 → 已完成成员门禁生效；OFF → standard 档 → 该门禁不运行，向已完成成员 `send_message` 不会出现 `TEAM_MEMBER_FINISHED` 提醒。
- **成员侧**：`role === 'teammate'` 的成员走独立成员门禁分支——flat 模式只封成员派子代理（提醒一次后放行）；nested 模式编排动作 + `read`/`grep`/`glob` 静默，其余工具提醒一次后照常执行。

## 4. 用户排查清单

**确认当前会话是 team 档还是 standard 档**

1. 看会话头部 Team 开关：ON → `team_task_*` 可见 → team 档；OFF → standard 档（rc.2 默认）。这不是唯一依据：探测始终以实际工具面为准。
2. 看第一条 `[team-gate]` 提醒内容：点名 `team_task_create` → team 档；只提 `todo_write` / `subagent` → standard 档；说「没有探测到委派工具」→ 无委派能力档。
3. 看模型实际能调用什么：`list_agents` 在默认组合下可用（无参数）；`team_task_create` 只在 Team 开关 ON 时可见；`interrupt_agent` 在 shipped 配置下不可见。
4. 看会不会出现 `[team-gate] TEAM_MEMBER_FINISHED:`：只有 team 档投递（已完成成员门禁按 `caps.board` 生效）；standard 档向已完成成员 `send_message` 不会有这条提醒。

**`/using-agent-team` 语义**

- 解析取会话事件里**最后一条** `command/run`（`data.name === 'using-agent-team'`）：去空白后为空或 `on`（不区分大小写）→ 开启；`off` → 关闭；其它文本 → 开启并把原文作为持续任务。
- 开启后 section 每轮注入提醒；关闭后 `text` 返回空串。成员会话没有自己的命令记录，开关从 Lead（根）会话回溯。
- 不落盘：插件状态全部来自会话事件，重启不保留旧的“开关文件”。

**出问题先看这几条 notice / warn**

- `[team-gate] …`：Lead 亲自下场或成员越界的提醒（只提醒，不阻断）。
- `[team-gate] TEAM_MEMBER_FINISHED:`：向「已完成任务」的成员 `send_message`、或把它 claim / reassign 成任务 owner；仅 team 档投递（见 §3）。
- `[team-gate] MODEL_OVERRIDE:`：子代理模型被插件默认路由覆盖的留痕。
- `[force-subagent] 宿主 tools 服务不可用（无法读取本会话真实工具清单）`：探测失败，已降级 standard 档。
- `[force-subagent] 当前步 toolSet 缺失（省略 toolSet 会读到注册期可见集合，team_task_* 会假阳性）`：装配上下文不完整，已降级 standard 档。
- `[force-subagent] 工具面探测结果为空（toolSet 可能已 dispose，或 scope 与本步解析者不一致）`：宿主返回空清单，**不当成「本会话确认没有委派工具」**，同样按探测失败降级（`capabilitiesFromNames` 拿到空集合时走 `noteToolProbeFallback` + `fallbackCapabilities`）。
- `[force-subagent] 工具面探测抛错（…）`：探测异常，已降级 standard 档。
- `[force-subagent] …门禁未生效，本次放行`：fail-open，工具已放行。
- `[force-subagent] systemPrompt section "force-subagent:agent-team" 已存在…`：profile 里同时存在 bundle 自挂载与手工 insert，删掉一处。

## 5. 验证命令

在仓库根目录执行：

```bash
# 1) 全量测试（含 tests/verify/ 的 18 个契约用例）：期望 `ℹ tests 682`、`ℹ pass 682`、`ℹ fail 0`
node --test "tests/**/*.test.js"

# 2) `/using-agent-team` 契约验收（单独复看那 18 个用例）：期望 `ℹ pass 18`、`ℹ fail 0`
node --test tests/verify/

# 3) 注入文本不再包含 rc.2 已删除的工具名：期望无输出（grep 退出码 1）
grep -n "spawn_teammate" index.js

# 4) 探测失败必须降级、不得猜成 team：期望 3 行（fallbackCapabilities 定义、Team 开关 ON 时还原看板、standard 兜底）
grep -n "const fallbackCapabilities\|return STANDARD_CAPABILITIES\|board: true" index.js

# 5) 门禁必须保留「派发后仍提醒」：期望命中 VALIDATION_TOOLS 的条件豁免与 leadGateReminder 调用
grep -n "VALIDATION_TOOLS.has(tool) && dispatched" index.js
grep -n "leadGateReminder(caps, tool, dispatched)" index.js

# 6) 探测失败必须覆盖「空清单」判据（不当成确认没有委派工具）：期望命中 1 行
grep -n "工具面探测结果为空" index.js

# 7) 已完成成员门禁必须按看板能力分档（team 档才生效）：期望命中 1 行 caps.board 判定
grep -n "caps.board && (tool === 'send_message'" index.js
```

预期要点：步骤 1、2 全绿；步骤 3 无输出；步骤 4 输出 3 行（`fallbackCapabilities` 定义、Team 开关 ON 时还原看板、standard 兜底）；步骤 5 各 1 行；步骤 6、7 各 1 行。

> 若 `node --test "tests/**/*.test.js"` 出现失败，先核对该断言是否仍在描述旧契约（例如旧测试期望 `inject` 不含 `'tools'`、或仍按 rc.1 的 17 个硬编码工具名断言）；不要仅凭失败用例反推插件行为，以当前 `index.js` 的符号与上文《实现事实》为准。

## 6. 设计稿 vs 实现的差异（以 `index.js` 为准）

- **仍存在的偏差（以实现口径为准）**：设计稿把 team 档判据写成「探测到 `spawn_teammate`」（`rc2-flat-mode-design.md` §2.4、§1.3 伪代码的 `spawn` 标记）；实现按「探测到看板 `team_task_create`」判定 team 档（`TOOL_MARKERS.board` → `capabilitiesFromNames` → `delegationTier`）。原因：rc.2 只有 `team_task_*`，且每个工具注册带 Team 开关的 `when`，打开开关即进 team 档——实现口径更贴合真实可用工具面。设计稿顶部已补《实现偏差说明》。
- **已对齐（本文旧表述作废）**：命令 notice 不再是统一文案。`buildNotice` → `reminderText` → `leadClause(caps)` 按 `none` / 非 `none` 两态分档：`none` 档明说「本会话未检测到委派工具，强制委派提示不生效」，非 `none` 档才说「真实可用的委派工具见系统提示的 Agent-Team 段」。与设计 §2.5 一致。
- **已对齐（本文旧表述作废）**：「已完成成员」门禁按 `caps.board` 分档——standard 档（rc.2 默认，Team 开关 OFF）**停用**，team 档才运行，与设计 §3.5 一致。本文旧版本称「standard 档仍运行该门禁：按 `send_message({agent})` 的名字与 `team/task` 的 owner 判定」，与实测相反：`caps.board` 为假时整条门禁分支不进入，`send_message({ agent: 已完成成员名 })` 不会投递 `[team-gate] TEAM_MEMBER_FINISHED:`；team 档（`team_task_create` 可见）才会命中 `memberByName` + `team/task` owner 判定并投递该提醒。
