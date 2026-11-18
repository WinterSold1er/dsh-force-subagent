# dsh-force-subagent：rc.2 过时引用与门禁放行审计（只读）

审计对象：`/home/csy/Code/Github/dsh-force-subagent`（HEAD `8e9d60c`「feat(rc2): 适配 DSH 0.2.2-rc.2」）
宿主源码：`/home/csy/Code/installer/deepseek-harness-0.2.2-rc.2/`（运行中的 host 进程即此 checkout）
方法：vectr MCP 在本会话不可用（`mcp__vectr__vectr_status` → unknown tool），按检索策略降级到 grep/read；rc.2 checkout 一律 grep/read。

## 0. 结论速览

插件在 `8e9d60c` 里**只把「成员身份判定 / 容量读写」适配到了 rc.2**，但**注入文本、门禁工具名集合、成员收尾指令仍是 rc.1 形状**，且门禁本身是「只提醒不阻断」。结果是：注入文本把 Lead 指向当前运行时不存在的工具（`team_task_create`、`interrupt_agent`、`subagent_role`、`close_subagent`、`team_task_*`），唯一能真正执行的出路只剩 `subagent`；而 Lead 只要调过一次 `subagent`，本轮 17 个被监控工具就全部静默放行。**「Lead 自己干」不是模型不听话，而是插件给出的指令不可执行、监控面又只覆盖 17 个硬编码名字。**

---

## 1. 过时引用清单（file:line → rc.2 实际状态）

判定基准：
- rc.2 运行时实际暴露：`subagent` / `subagent_fork` / `send_message` / `list_agents` / `wait_agent` / `workflow`（本会话工具清单），无 `team_task_*` / `interrupt_agent` / `spawn_teammate` / `subagent_role` / `close_subagent`。
- rc.2 源码：`spawn_teammate` / `subagent_role` / `close_subagent` **没有任何工具注册**（仅 UI 字符串残留：`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:122`、`control-details-model.ts:171`）；`team_task_*` 在 `packages/team/tool-agent-team/src/index.ts:118/144/185/201`（可选插件，当前 profile 未装载）；`interrupt_agent` 在 `packages/subagent/tool-subagent-control/src/index.ts:119`（源码有，本会话工具表未暴露）。

### 1.1 `index.js`（注入文本 = 真正喂给模型的部分，最高优先级）

| 位置 | 过时内容 | rc.2 实际 |
|---|---|---|
| `index.js:414`（`LEAD_NUDGE`） | `先用 team_task_create 把工作拆成…`、`正确做法是先 team_task_create 拆分任务，再…subagent 派成员承接` | `team_task_create` 不存在（需可选 tool-agent-team，本 profile 未装） |
| `index.js:414` | `wait_agent 一次` | 存在，OK |
| `index.js:417`（`FLAT_LEAD_APPENDIX`） | 点名 `subagent_role`、`close_subagent` | rc.2 无注册 |
| `index.js:417` | `立即 interrupt_agent(agent_id=该成员) 中断该成员` | 本会话不可用；且 rc.2 该工具参数是 `agent`（名字），不是 `agent_id`（见 §1.5） |
| `index.js:417` | `用 team_task_update 关闭对应任务`、`给它建新的 team_task`、`send_message / interrupt_agent 都用 list_agents 给出的 agent_id` | 工具不存在；`send_message` 参数也不是 `agent_id` |
| `index.js:417` 末句 | `出路是先 team_task_create 拆分，再…subagent` | 同 414 |
| `index.js:420`（`MEMBER_NUDGE`） | 白名单文案点名 `subagent_role`、`close_subagent`、`team_task_*`、`interrupt_agent` | 前三/四均不在运行时不 guaranteed；成员被要求去用不存在的工具 |
| `index.js:423`（`MEMBER_NUDGE_FLAT`） | 同样点名 `subagent_role` / `close_subagent` / `team_task_*` / `interrupt_agent`；要求「用 team_task_* 看板登记」「Lead…interrupt_agent 收敛你」 | 本会话（flat 成员）**收到的就是这段文本**：`team_task_*` 与 `interrupt_agent` 均不可调用 |
| `index.js:472-493`（`ALLOWED_TOOLS`） | 21 项里含 `subagent_role`、`close_subagent`、`team_task_create/get/list/update`、`interrupt_agent` | 6 个名字在当前运行时不存在 |
| `index.js:503`（`DELEGATION_TOOLS`） | `subagent`、`subagent_fork`、`subagent_role`、`close_subagent`、`workflow` | 后两个无注册（flat 门禁对它们永远不可能命中） |
| `index.js:549`（`DISPATCH_TOOLS`） | `spawn_teammate`、`subagent`、`subagent_fork`、`subagent_role`、`workflow` | `spawn_teammate`/`subagent_role` 无注册（保留是为 rc.1 兼容，注释已说明） |
| `index.js:560`（`leadGateReminder`） | 提醒正文明写「先 **team_task_create** 把工作拆成…再 **subagent** 并行派成员」 | 提醒给出的第一步无法执行 |
| `index.js:567`（`finishedMemberReminder`） | 「再 subagent 派一个新成员承接，并给它建新的 **team_task**」 | `team_task` 不存在 |
| `index.js:995-996` | 从 `callArgs.target` / `callArgs.agent_id` 取 `send_message` 目标 | rc.2 参数是 `agent`（名字）+ `message`（见 §1.5）→ **已完成成员门禁在本会话对 send_message 永不触发** |
| `index.js:305-307`（`finishedMembers`） | 依赖 `team/member` 事件建立 name→id | rc.2 不再追加 `team/member`（有 ownerId 兜底，已适配，不算硬伤） |

### 1.2 `README.md`

| 位置 | 过时内容 | 说明 |
|---|---|---|
| `README.md:17` | nested 白名单「只有 21 个」并逐个列出 `subagent_role`/`close_subagent`/`team_task_*`/`interrupt_agent` | 6 个名字运行时不存在 |
| `README.md:21` | 「正确做法：先 `team_task_create`…再单轮并行 `subagent`」 | 第一步不可执行 |
| `README.md:22` | 称提示词点名 17 个工具并给出「`team_task_create` + 单轮并行 `subagent`」的正确做法 | 同上 |
| `README.md:24` | 自认 `mcp__*`、`terminal_close/list`、`lsp`、`session_*`、`create_worktree` 等**不触发提醒** | 这是漏洞的自证，不是笔误 |
| `README.md:36` / `README.md:49` | flat 完成即「`interrupt_agent` 中断 + `team_task_update` 关闭」 | 两个工具当前都不可用 |
| `README.md:156` | 「成员寻址 `send_message(agent_id=会话 id)`」 | rc.2 `send_message` 参数为 `agent`（名字，`list_agents` 展示的名字），宿主用 `resolveName` 解析；`list_agents` 无 `scope` 参数 |
| `README.md:163` | 「提示词与提醒文案一律只点名 rc.2 真实存在的工具名」 | **与代码矛盾**：414/417/420/423 均含不存在名字，见 1.1 |

### 1.3 `docs/`（历史文档，多数已有边界声明）

- `docs/agent-team-api.md:7` 已有明确「0.2.2-rc.2 起本文为历史契约」banner；`45-49`、`283`、`306-315` 仍讲 `agentTeams.tryMembership`，被 banner 覆盖，**可保留但需在引用处重申**。
- `docs/review-lead-gate.md:331` 等多处 `interrupt_agent` / `team_task_update` / `spawn_teammate`（`ttc×20`、`spawn×6`、`role/close×6`、`send×18`）——历史评审记录，非现行契约。
- `docs/multicast-session-check.md`（`team_task_create×2`、`spawn_teammate×2`）、`docs/prompt-plugin-api.md`（`spawn_teammate×1`、`agentTeams×10`）、`docs/root-cause.md:23/64/126`、`docs/verification-log.md`、`docs/review-report*.md`、`docs/DELIVERY.md`、`docs/install.md`：均为历史取证/评审，含 rc.1 工具名。
- `docs/message-injection-api.md` 未被本审计发现工具名引用。

### 1.4 `forensics/`

- `forensics/code-path.md`（`interrupt_agent×5`、`send_message×17`、`spawn_teammate×2`、`list_agents×5`、`wait_agent×6`、`team_task_create×1`）
- `forensics/review-finished-gate.md`（`send_message×7`、`interrupt_agent×1`、`spawn_teammate×1`）
- `forensics/session-timeline.md:23/25/27/54/66/92`（真实 rc.1 会话时间线里的 `spawn_teammate`/`interrupt_agent`）
- `forensics/verify.md`（`interrupt_agent`/`spawn_teammate`/`send_message`/`list_agents`）
- 性质：历史取证，**不应改写事实**；但需在文件头标注「rc.1 会话记录，工具名不可作为 rc.2 契约」。

### 1.5 与 rc.2 工具 schema 不符的两处（独立于改名问题）

1. `packages/subagent/tool-subagent-control/src/index.ts:44-60`：`send_message` 参数是 `agent`（"The name of another agent…as shown by list_agents"）+ `message`；`README.md:156` 的 `agent_id=` 与 `index.js:417` 的「用 agent_id」均错。
2. `index.js:995-996` 该门禁的取参路径（`target`/`agent_id`）与真实 schema（`agent`）不一致 → 门禁对 rc.2 的 `send_message` 完全失效。

### 1.6 `client.js` / `cordis.patch.yml`

- `client.js`（1514 行）：grep `spawn_teammate|team_task|interrupt_agent|wait_agent|list_agents|send_message|subagent_role|close_subagent|agentTeams` **0 命中** → 无工具名硬编码（只有 UI/工作区/模型路由）。
- `cordis.patch.yml`（3 行）：只有 `insert: dsh-force-subagent`，**无版本约束**。

---

## 2. 门禁逻辑时序（文字版）

`apply(ctx, config)`（`index.js:822`）：

1. `ctx.inject(['settings'])` 关闭宿主自动设置页（`826-851`，可选、失败只 warn）。
2. 定义 `warnFailOpen`（闭包变量 `warnedFailOpen`，**整个 apply 生命周期只 warn 一次**，`856-860`）。
3. **先注册 `tools/pre-execute`**（`905`）——早于 1274 的服务就绪检查，所以 `systemPrompt/commands` 缺失时门禁仍生效（`1274-1278` 才 return）。
4. `installTeamMemberRoute(ctx.get('subagents'))` 包裹 `startActivation` 注入子代理模型路由（`1264-1271`、`1112+`）。
5. 注册 systemPrompt section `force-subagent:agent-team` order 57（`1281-1298`）：`text(context)` 读 `resolveMembership` → teammate 用 root 会话的 `command/run` 状态取 `MEMBER_NUDGE(_FLAT)`；否则取 `LEAD_NUDGE(+FLAT_LEAD_APPENDIX)`；`promptText` 在开关关闭时返回空串。
6. 注册 `/using-agent-team` 命令（`1300+`）。

每次工具调用进入 `tools/pre-execute(exec, next)`（`905`）：

```
tool = exec.name; agent = exec.agent
├─ agent 缺失 → next()                                   (907-908)
├─ resolveMembership(ctx, agent)                         (910-916)
│    rc.1: agentTeams.tryMembership
│    rc.2: subagents.rootOf(agent)
│          root===agent → {role:'lead'}
│          session.header.delegationDepth===1 → {role:'teammate'}
│          其它 → undefined
│    取身份抛错/服务缺失 → identityUnavailable → next()   (914-916, 339-390)
├─ wait_agent 空转门禁                                    (919-963)
│    tool===wait_agent && enabled(root.session)
│    本 turn 内「上一次非本次 callId 的 tool/call」名字也是 wait_agent
│    → remindOnce(agent,'wait-spin',waitGateReminder()) → next()
├─ 已完成成员门禁（send_message / team_task_update claim|reassign）  (969-1025)
│    读 root 会话事件 → finishedMembers(team/member + team/task)
│    解析目标成员 id（target/agent_id 或 owner→resolveName）
│    finished → remindOnce(`finished-member:${id}`, TEAM_MEMBER_FINISHED 文案) → next()
├─ 成员门禁（role==='teammate'）                          (1027-1040)
│    flat:   DELEGATION_TOOLS.has(tool) && enabled(root) → remindOnce('flat-delegation') → next()
│    nested: ALLOWED_TOOLS.has(tool) → next()（静默）
│            否则 enabled(root) → remindOnce('member-gate') → 继续往下（角色检查挡住 Lead 门禁）
├─ Lead 门禁（role!=='teammate' && LEAD_BLOCKED_TOOLS.has(tool)）  (1053-1105)
│    session.header.delegationDepth ?? 0 >= 1 → next()     (1055-1060)
│    session 缺失 / enabledIn(session) 抛错或 false → next() (1061-1078)
│    readEvents 不可读 → next()                             (1072-1079)
│    找不到 turn/start → next()                             (1081-1090)
│    扫「最后一个 turn/start 之后」的 tool/call
│      DISPATCH_TOOLS 命中 → 不提醒，next()
│      未命中 → remindOnce(`lead-evidence:${turnStart}`, leadGateReminder(tool)) → next()
└─ 任何异常 → warnFailOpen(...) → next()                    (1106-1110)
```

**全插件没有任何 `{kind:'deny'}`**（`lead-gate-per-turn-reminder.test.js:148` 的 T4 还用源码断言把这条写死）。

---

## 3. 放行漏洞清单（按严重度）

### S1（致命）提醒不阻断，且唯一「正确出路」不可执行

- `index.js:1102-1104`：命中只 `remindOnce(...)` 然后 `return next()`，工具照常执行；`1106-1110` 异常也 next。
- `index.js:560` / `414` / `417`：提醒与提示词要求「先 team_task_create 拆分」，而运行时无此工具。
- 唯一可执行的出路是 `subagent`，但 `index.js:1092-1099` 一旦本轮出现过任何 `DISPATCH_TOOLS` 命中就**整轮不再提醒**。Lead 调一次 `subagent`（哪怕只是取证/试探），随后 `bash/write/edit` 全部静默放行。
- 加重：无 `turn/start` 事件（`1088-1090`）→ 整轮 fail-open。
- 结论：门禁的「教育」信号在一轮里最多出现一次，且出现的文案不可执行；模型没有可遵循的成功路径。

### S2（高）监控面 = 17 个硬编码工具名，且集合不来自宿主工具清单

- `index.js:519/527/543/546` 定义 `EVIDENCE∪IMPLEMENTATION∪EXECUTION` 共 17 个；`inject` 只有 `['commands','systemPrompt','subagents']`（`22`），**全程没有 `ctx.get('tools')` / 工具注册表 / 版本读取**（grep 0 命中）。
- `README.md:24` 明确写：`mcp__*`、`terminal_close/list`、`lsp`、`cordis_*`、`session_*`、`create_worktree` 不触发提醒。
- 因此 Lead 用 `mcp__github__create_pull_request`、`mcp__vectr__*`、`office_*`、`plugin_manager`、`present`、`schedule_*`、`ask_user_question` 干活完全无提醒；rc.2 新增/改名的工具只要不在 17 名单内即静默。
- `apply_patch` / `str_replace_editor` / `run_code` 在 rc.2 属不同 preset（`packages/fs/tool-fs/src/apply-patch.ts`、`packages/fs/tool-str-replace-editor/src/index.ts`、PTC preset 的 `run_code`）；当前 profile 里不存在时这些名字是**死条目**，不构成覆盖。

### S3（高）已完成成员门禁在 rc.2 上对 `send_message` 失效

- `index.js:995-996` 取 `callArgs.target` / `callArgs.agent_id`；rc.2 schema 是 `agent`（名字）+ `message`（`packages/subagent/tool-subagent-control/src/index.ts:44-60`）。
- `idsByName` 只来自 `team/member` 事件（`305-307`），rc.2 不追加该事件 → `memberId` 恒为 undefined → 永不提醒。
- 同时 `index.js:417` 教模型传 `agent_id`，按 rc.2 schema 会被参数校验直接拒绝：Lead 连「给成员发消息」都做不成。

### S4（高）flat 模式收尾闭环依赖不存在的工具

- `index.js:417`：Lead 被要求「完成 → `interrupt_agent` + `team_task_update` 关闭任务」；`423`：成员被要求「用 `team_task_*` 登记、等 Lead `interrupt_agent` 收敛」。
- 两者当前都不可用 → flat 模式名义上的「软踢出」无法执行；成员做完只能 `send_message` 回话，Lead 无法关闭任务、无法中断，只能继续复用或自己接手。

### S5（中）身份判定 fail-open 面很宽

- `resolveMembership` 返回 `undefined`（`339-390`）时：成员门禁不套、`role!=='teammate'` 仍会套 Lead 门禁——但 `1055-1060` 的 `delegationDepth>=1` 直接 next：**任何「本身是 subagent 的 Lead」（嵌套团队、fork 出来的编排者）永久不触发 Lead 门禁**。
- 读身份抛错 → `identityUnavailable` → 直接 next（`914-916`），只 warn 一次（`856-860`）。
- `enabledIn(session)` 读事件抛错/无记录 → next（`1061-1078`）。

### S6（中）状态源不一致：模式是全局实时配置，开关是每会话事件

- `modeFor()`（`900`）读全局 live config（页面只有一个下拉）；section 用 `modeFor()` 决定 member/lead 文案，门禁用 `modeFor()` 决定 flat/nested 分支。
- 会话进行中改全局 `mode`：所有会话的提示词与门禁同时翻转，没有「会话已冻结模式」的一致性检查；`command/run` 仍是每会话（`1290-1294` 读 root 会话），两者可不同步。

### S7（低）去重粒度导致提醒只出现一次

- Lead：`lead-evidence:${turnStart}`，每轮一次（`1102-1103`）。
- 成员：`member-gate` / `flat-delegation` / `wait-spin` 是**每 agent 终身一次**（`872-886`），成员越界第二次起完全静默。

### S8（低）版本约束与代码假设不匹配

- `package.json:48-51` `engines.dsh = ">=0.2.1-rc.1"`：允许 rc.1（无 `rootOf`，走 `tryMembership`）也允许 rc.2（走 `rootOf`），但代码与文案只按 rc.2 实况写了一半；没有任何 `dsh` 版本探测（grep 0 命中）。
- 本机 `dsh --version` = `0.2.2-rc.1`，而运行中的 host 进程是 rc.2 checkout（`ps` 证据）——「engines 满足」不等于「工具集是假设的那套」。

---

## 4. 测试覆盖图

### 4.1 与本次问题相关的测试（21 个文件里的 12 个）

| 文件 | 断言的行为 | rc.2 改名后的状态 |
|---|---|---|
| `tests/lead-gate.test.js` | L1-L10d：Lead 命中 17 工具 → 放行 + 每轮一次提醒；fail-open 矩阵；L15 已派发不提醒；L18/L22/L23 提醒文案含「`team_task_create` → `subagent`」 | **锁死过时文案**（`:562`、`:620`、`:206` 默认 hint） |
| `tests/lead-gate-per-turn-reminder.test.js` | T1 同轮一次、T2 跨轮再提醒、T3 已 `subagent` 派发不提醒、T4 源码 `kind:'deny'` 出现 0 次、T5 17 工具逐个 | T4 是「断言不存在」的结构测试，**不证明门禁有效** |
| `tests/lead-gate-bypass-tools.test.js` | B1-B14：绕过面（`run_code`/`terminal_*`/实现类）与边界（`terminal_close/list` 不入集合）、`delegationDepth=1` 放行 | `:151` 要求提醒含 `team_task_create`；`:217/:228` 用 `spawn_teammate` 当派发证据 |
| `tests/member-gate-allow.test.js` | 21 项白名单逐项 `next()`；`:155` 「恰好 21 项且无重复」 | **fixture 与计数一起锁死 6 个不存在名字** |
| `tests/member-gate-deny.test.js` | 白名单外工具 → 放行 + 成员提醒；`:40` `spawn_teammate` 作为"违禁"样本 | 用不存在工具当样本，测的是字符串集合而非真实工具 |
| `tests/mode-flat.test.js` | `:145-156` 断言 flat 成员提示词**逐一点名 DELEGATION_TOOLS 的 5 个工具**；`:163` Lead 段必须含 `team_task_create`；`:165` 必须含 `interrupt_agent`；`:261-263` flat 不拦 `team_task_create` | **改提示词就会红**：测试本身在维护过时契约 |
| `tests/gate-reminder.test.js` | `:307` Lead 段必须匹配 `/team_task_create[\s\S]*subagent/`；`:309-310/:320/:331` 不得出现硬拒绝措辞 | 同上 |
| `tests/force-subagent.test.js` | section 开/关文本；`:120/:242/:249` 断言含 `team_task_create`；`:217` 成员文本不得含 `team_task_create` | 同上 |
| `tests/member-finished-gate.test.js` | 向已完成成员 `send_message` / claim / reassign → 提醒；`:376-399` `interrupt_agent` 不受拦 | 测试把 `interrupt_agent` 当既有工具；且未覆盖 rc.2 的 `agent` 参数形态 |
| `tests/rc2-membership.test.js` | `rootOf`+`delegationDepth` 身份推导；`team/task` 形状；`:286` **仅断言 notice 文案不含** `spawn_teammate\|close_subagent` | **假通过**：section / `LEAD_NUDGE` / `FLAT_LEAD_APPENDIX` 仍含这些名字 |
| `tests/wait-gate.test.js` | `wait_agent` 相邻两次 → 提醒一次；W5/W9 fail-open | `team_task_create` 仅作"打断空转"的事件样本，影响小 |
| `tests/gate-observability.test.js` | 缺 `agentTeams` / `tryMembership` 抛错 → warn 一次、点名工具与原因 | 文案与 rc.2 实际分支（rootOf）不完全对应，但断言是「有 warn」，仍会绿 |

与工具名无关（不受影响）：`capacity-settings` / `client-ui*` / `save-all-workspaces` / `settings-policy` / `live-config` / `model-route-config` / `team-model-route` / `route-override-observability` / `workspace-route`。

### 4.2 假通过的机制

1. 所有门禁测试直接伪造 `tools/pre-execute` 的 `exec.name`（`lead-gate.test.js:177` 的 `assertAllowed`），**没有任何测试校验「插件里的工具名集合 ⊆ 宿主实际注册的工具集」**。
2. `rc2-membership.test.js:286` 只检查 notice，不检查注入给模型的 section 文本 —— 这正是过时内容藏身之处。
3. `lead-gate-per-turn-reminder.test.js:148` T4 用「源码里没有 deny」证明「软门禁成立」，把「不阻断」写成了验收标准。
4. 没有测试覆盖 `mcp__*` / 新增工具 / 工具改名 / 派发后整轮静默 / `send_message(agent=…)` 参数形态。

### 4.3 需要改 / 需要新增的测试

**必须改（改代码后会红）：**
1. `tests/mode-flat.test.js:145-156`（逐一点名 DELEGATION_TOOLS）、`:163`（`team_task_create`）、`:165`（`interrupt_agent`）。
2. `tests/lead-gate.test.js:206`（默认 hint `/team_task_create/`）、`:562`、`:570`、`:600-601`、`:631`。
3. `tests/lead-gate-bypass-tools.test.js:151`（提醒含 `team_task_create`）、`:201-228`（`spawn_teammate` 派发证据）。
4. `tests/gate-reminder.test.js:307`（`/team_task_create[\s\S]*subagent/`）。
5. `tests/force-subagent.test.js:120`、`:242`、`:249`。
6. `tests/member-gate-allow.test.js:32-60` + `:155`（21 项 fixture 与计数）。
7. `tests/member-gate-deny.test.js:40`（`spawn_teammate` 样本）。

**必须新增：**
1. **提示词 × 工具集一致性**：给一个 rc.2 工具名 fixture（`subagent`/`subagent_fork`/`send_message`/`list_agents`/`wait_agent`/`workflow`/`bash`/`read`/`write`/…），断言 section 文本里所有被反引号或空格分隔的「工具名 token」都在集合内（至少要断言不含 `team_task_create`/`interrupt_agent`/`subagent_role`/`close_subagent`/`spawn_teammate`，或在缺失时文案降级）。
2. **派发即静默的回归测试**：`toolCall('subagent')` 后同轮 `write` 不提醒 —— 明确这是设计还是漏洞，并据此改判据（例如要求派发后仍有成员在跑、或每 N 次提醒一次）。
3. **`send_message` 参数形态**：用 `{agent:'worker-1', message:'…'}` 驱动已完成成员门禁，断言提醒出现（当前会挂）。
4. **覆盖盲区决策测试**：`mcp__github__*` / `office_*` / `present` 是否该提醒；若不该，README 需写明理由（现有 `README.md:24` 是理由，但没测试）。
5. **版本/工具集探测测试**：`resolveMembership` 在「无 tryMembership 且无 rootOf」时的 warn 文案、以及门禁集合如何随宿主能力降级。

---

## 5. 工具清单 / 版本号读取现状

- **没有任何代码读取宿主工具清单**：`index.js:22` 的 `inject = ['commands','systemPrompt','subagents']` 不含 `tools`；全文 grep `ctx.get('tools')` / `tools.list` / `availableTools` = 0 命中；`client.js` 也没有。
- **没有任何 dsh 版本探测**：grep `version` 只命中包名/文案；`engines.dsh = ">=0.2.1-rc.1"`（`package.json:50`）是唯一约束，且这个范围同时覆盖行为不同的两代宿主。
- **`cordis.patch.yml`**（3 行）只做 `insert: dsh-force-subagent`，无版本门槛。
- 现存的「能力探测」只有两处：`resolveMembership` 里 `typeof subagents?.rootOf === 'function'`（`376`）与 `agentTeams.tryMembership` 优先（`339-364`）；以及 `ctx.get('subagents').resolveName` 存在性判断（`1011`）。**它们只决定身份判定走哪条路，不决定提示词与工具名集合。**

---

## 6. 给实现者的 5 条要点

1. **先让指令可执行，再谈门禁**：`index.js:414/417/420/423` 与 `560/567` 里的 `team_task_create`、`team_task_*`、`interrupt_agent`、`subagent_role`、`close_subagent` 必须按运行时能力降级（探测 + 回退文案），否则模型收到的是「照做即报错」的指令，最优策略自然变成自己干。
2. **门禁集合必须从宿主工具清单派生**（`ctx.get('tools')` 或 `inject: ['tools']`），至少在启动时过滤掉不存在的名字并 warn；`LEAD_BLOCKED_TOOLS` 的 17 项硬编码是漏掉 `mcp__*`、`office_*`、`present` 等整类工作通道的根因（`index.js:519-549`、`README.md:24`）。
3. **修 `send_message` 取参**：`index.js:995-996` 要认 rc.2 的 `agent` 参数（并保留 `target`/`agent_id` 兼容），否则已完成成员门禁在 rc.2 上是死代码；同时把 `README.md:156` 与 `index.js:417` 的调用示例改成 `send_message(agent=<list_agents 的名字>)`。
4. **收紧「派发即放行」**：`index.js:1092-1099` 把任意一次 `subagent`/`workflow` 调用当成整轮豁免；应至少要求「派发发生在该工具调用之前且成员仍在跑」，或对同一轮的后续命中做限频提醒，否则每次 Lead 都能用一次试探性派发换整轮自由。
5. **把 `delegationDepth>=1` 的豁免显式化**：`index.js:1055-1060` 让「编排者本身是 subagent」（嵌套团队、fork 出的 Lead）永久跳过 Lead 门禁；若这是有意的，README 要写明并在 `rc2-membership` 测试里固定；若无意的，需要按「是否是团队 root」而不是「深度是否≥1」判定。

---

## 附：本次审计的定位命令（可复现）

```bash
# rc.2 是否还有这些工具注册
grep -rn "name: 'spawn_teammate'\|name: 'subagent_role'\|name: 'close_subagent'" packages --include=*.ts
grep -rn "name: 'team_task_create'" packages/team/tool-agent-team/src/index.ts
grep -rn "name: 'interrupt_agent'" packages/subagent/tool-subagent-control/src/index.ts
# 当前 host 是哪个版本
ps aux | grep 'deepseek-harness' ; dsh --version
```
