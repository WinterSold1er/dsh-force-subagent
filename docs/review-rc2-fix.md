# RC.2 委派修复对抗审查报告（reviewer）

审查对象：`git diff index.js`（+413/−149 含 tests）、`README.md`、`docs/rc2-compat.md`、`docs/rc2-flat-mode-design.md`、`forensics/*`。
取证方式：读 `index.js` 实际行、读宿主源码 `/home/csy/Code/installer/deepseek-harness-0.2.2-rc.2/`、`node --test tests/`、`node --input-type=module` 只读实验（mock ctx，不落盘）。
说明：本会话 vectr MCP 不可用（`vectr_status` 报 unknown tool、`vectr_search` 报 Internal Server Error），已按降级规则改用 grep/read。

## 套件现状（不否决，仅记录）

`node --test tests/` → **603 tests / 602 pass / 1 fail**。唯一红：
`✖ rc.2 已完成成员门禁：send_message 用成员名寻址已完成成员时投递 TEAM_MEMBER_FINISHED 提醒`（`0 !== 1`）——该红不是测试写坏，而是 D-3 指出的实现缺口。

---

## 缺陷卡片

### D-1（HIGH / 阻塞）空工具面被当成「确认没有工具」，注入与门禁反过来教 Lead 放弃委派，且完全静默

- 位置：`index.js:1122-1130`（探测成功后直接 `capabilitiesFromNames(names)`，无 `names.size === 0` 判据）、`index.js:472-483`、`index.js:491`（`delegationTier`）。
- 宿主语义证据：`ResolvedToolSet.view(scope)` 在 **toolSet 已 dispose**（`closed === true`）或 **`scope !== 解析该 toolSet 的 agent`** 时返回**空 Map** —— `packages/core/tools/src/index.ts:284-295`；`definitions(scope, toolSet) = [...toolSet.view(scope).values()]` —— 同文件 `:305-308`。而 `ToolExecution` 只有 `agent`、**没有 `scope` 字段**（`packages/core/tools/src/contracts.ts:175-190`），插件取 `context?.scope ?? context?.agent`（`index.js:1123`）——嵌套 / PTC 派发时 `exec.agent` 未必等于解析者，必然落进空 Map 分支；`dispose()` 每步都会发生（`packages/core/agent-loop/src/agent.ts:315 / :320 / :398`）。
- 实测复现（mock 的 `definitions` 完全按宿主 `view` 语义实现）：
  - toolSet 已 dispose → section 文案 = 「本会话没有探测到委派工具（subagent / subagent_fork 都不可用）：没有委派能力，直接执行任务即可，不要声称已派发成员」；`claimsNoDelegation=true`。
  - `scope` 与解析者不一致 → 同上，且 **warnings = 0（无任何 warn，静默）**。
  - 门禁侧：`write` 的提醒变成「本会话没有探测到委派工具…无法派发成员，实现工具「write」由你直接执行」。
  复现命令：见本报告「实验」一节脚本（`node --input-type=module` 内联，无需落盘）。
- 后果：这正是本轮要修的「Lead 只能自己干活」缺陷的镜像——一次工具面误判就让插件主动劝退委派，并且没有任何 warn 可供追查。
- 建议修法：探测成功但 `names.size === 0` 视为探测失败（`noteToolProbeFallback('工具面探测结果为空（toolSet 可能已 dispose 或 scope 不匹配）')` → `fallbackCapabilities`）；或要求结果里至少包含必然存在的锚点工具（如 `read` / `todo_write`）才承认 `probed: true`。同时不要在有歧义时断言「没有委派工具」。

### D-2（MEDIUM）探测失败被写成「工具不存在」的假阴性

- 位置：`STANDARD_CAPABILITIES` 固定 `interrupt: false`（`index.js:458-469`）；兜底只补 `board: true`、不补 `interrupt`（`index.js:1093-1104`）。
- 证据：rc.2 里 `interrupt_agent` 默认注册，只有 `config.interrupt === false` 才不注册（`packages/subagent/tool-subagent-control/src/index.ts:40`、`:118-120`）。于是 rc.1（有 `interrupt_agent`）与任何 `toolSet`/`definitions` 缺失场景，Lead 文案都会断言「本会话没有中断成员的工具，不要声称中断或删除成员」（`index.js:517-519`、flat 追加 `:530`、已完成成员提醒 `:729`）。
- 复现：`node --input-type=module` 实验 E2a/E2b（`tools` 服务缺失或 `definitions` 抛错时，产出文案含「本会话没有中断成员的工具」）。
- 建议修法：能力字段改三态（true / false / unknown），unknown 时只说「未确认是否可中断成员」，不做否定断言。

### D-3（MEDIUM / 当前测试已红）team 档已完成成员门禁的 `send_message` 分支缺 `resolveName`，rc.2 下永久不触发

- 位置：`index.js:1231-1236` 只用 `idsByName.get(name)`；而 `idsByName` 仅由 `team/member` 事件填充（`index.js:315-318`）。rc.2 宿主只 append `team/task`（`packages/team/agent-team/src/journal.ts:62`、`task-board.ts:79 / :226`），`team/member` 只作为历史投影 schema 存在（`packages/team/agent-team/src/types.ts:179`）。对比：同函数 `reassign` 分支有 `subagents.resolveName` 兜底（`index.js:1244-1252`）。
- 宿主侧对照：宿主自己的 `send_message` 就是 `ctx.subagents.resolveName(sender, args.agent, exec.signal)`（`packages/subagent/tool-subagent-control/src/index.ts:79`），`resolveName` 返回 `SessionId`（`packages/subagent/subagent/src/index.ts:331`），与 `team/task` 的 `ownerId`（`sessionIdSchema`，`packages/team/agent-team/src/projection.ts:35`）同一口径。
- 复现：① `node --test tests/rc2-membership.test.js` → 「向已完成成员发消息必须提醒一次 0 !== 1」；② 独立实验（不依赖测试文件）：给 `subagents.resolveName('worker-1') → 'member-sid'`、事件只有 `team/task`（ownerId=member-sid, completed），team 档 `send_message({agent:'worker-1'})` → `fired=false`，同 fixture 的 `team_task_update action=reassign` → `fired=true`。
- 建议修法：`send_message` 分支在 `idsByName` 未命中时同样走一次 `resolveName` 拿 SessionId 再比对 `finished`；解析失败沿用「判不了就不提醒」。

### D-4（LOW-MEDIUM）命令 notice 未按档分文案，none 档与 section 自相矛盾

- 位置：`reminderText` / `ENABLED_REMINDER` 不接 `caps`（`index.js:563-570`）、`buildNotice`（`:583-589`）、命令 handler（`:1542-1550`）。
- 后果：none 档下 section 说「没有委派能力，直接执行任务即可」，同一 turn 的 notice 却说「实现与测试必须委派」，两条指令互相打架。
- 文档依据：`docs/rc2-flat-mode-design.md:222` 要求 notice 含「未检测到委派工具」；实现落点 `:268` 也列了「命令 notice 分档」；`docs/rc2-compat.md:42 / :109` 已承认未做。
- 建议修法：`buildNotice(state, caps)`，none 档文案改为「本会话未检测到委派工具，强制委派提示不生效」；带 task 的那条已经用「见系统提示的 Agent-Team 段」，无 task 的那条同样处理。

### D-5（LOW）文档与实现的三处不一致：逐条裁决

1. **team 档判据用 `team_task_create` 而非 `spawn_teammate`** → **实现正确、文档错**。`index.js:441 / :491` 的判据与 rc.2 工具面一致（`packages/team/tool-agent-team/src/index.ts:118 / :144 / :185 / :201` 只有 `team_task_create|list|get|update`，且都带 `{ when: enabled(agent) }`，同文件 `:141 / :182 / :198 / :234`；rc.2 无 `spawn_teammate`）。要改的是 `docs/rc2-flat-mode-design.md:17`（「team = 检测到 `spawn_teammate`」）与 `:51` 的 `spawn: 'spawn_teammate'` 标记表。
2. **命令 notice 未按档分文案** → **实现未做**，见 D-4。
3. **standard 档已完成成员门禁是否停用** → **`docs/rc2-compat.md:110` 的「实现仍运行该门禁」是错的**：整条分支被 `caps.board` 拦住（`index.js:1211`，注释 `:1208-1210` 已声明理由），`index.js:729` 只是文案函数、standard 档不可达；实测：standard 档 `send_message` → `fired=false`，team 档 `reassign` → `fired=true`。`:729` 与 `:1256` 之间不存在冲突，冲突在文档与代码之间。另注意 D-3 使 team 档 `send_message` 也不触发。

### D-6（LOW，非本轮阻塞）`ctx.tools.definitions` 依赖「profile 依赖装载」这条隐含契约

- 证据：经 plugin_manager 安装的 dynamic 插件走沙箱门面，`ctx.tools` / `ctx.get('tools')` 只有 `register / schemas / get(name → schema)`，**没有 `definitions`**（`packages/extensions/cordis-host-runner/src/guard.ts:648-654`、`:739`，注释 `:639-644` 明确不给 live `ToolDefinition`）。
- 本插件现状：`install.sh` 把包写进 profile 依赖（`/home/csy/.dsh/profiles/web/package.json`），拿到的是真 `ToolsService`（`packages/core/tools/src/index.ts:305`），所以现在探测可用；`ctx.get(name)` 不要求 `inject` 声明（`guard.ts:738-745`：`get` → `readService(name, false)`），所以 `ctx.get('agentTeams')` 不必加 inject，`inject` 追加 `'tools'` 是合理做法。
- 风险：一旦改用插件商店 / dynamic 安装，探测会永久降级 standard，且每次 apply 一条 warn。建议在 `docs/rc2-compat.md` 明确写为已知限制。

---

## 已核验为「通过」的项（附证据）

1. **能力探测真的把 toolSet 传进 definitions**：`index.js:1123-1129` `definitions(scope, toolSet)`，`scope = context?.scope ?? context?.agent`；宿主 `assembleContextFor` 就是 `{ agent, scope: agent }`（`packages/core/agent/src/dispatch.ts:174-176`），`AssembleContext.toolSet` 由 `packages/core/agent-loop/src/agent.ts:298-300` 注入，`tools/pre-execute` 收到含 `toolSet` 的 `ToolExecution`（`packages/core/tools/src/events.ts:18`、`contracts.ts:189-190`）。
2. **WeakMap 不会串味 / 不泄漏**：缓存只在探测成功时写入（`index.js:1129`），key 是本步 `ResolvedToolSet` 对象；每步 `tools.resolve` 产生新对象并 `dispose`（`agent.ts:298 / :315 / :320 / :398`），降级结果不入缓存 → 下一步重新探测（Team 开关 / preset 变化自动换档）。
3. **三条降级都到 standard 且每次 apply 只 warn 一次**：实测 `tools` 服务缺失 → standard 文案 + 1 条 warn；`toolSet` 缺失 + `agentTeams.isEnabled=true` → 恢复 `board: true`（rc.1 不回归，实测 `hasBoardText=true`）+ 1 条 warn；`definitions` 抛错连续 3 次 → **恰好 1 条 warn**、不抛。
4. **文案只含真实工具**（实测三档）：standard / none 对 `spawn_teammate|team_task_|interrupt_agent|subagent_role|close_subagent` **零匹配**；只有 team 档出现看板与 interrupt。
5. **门禁堵住「派发一次换整轮免检」**（实测矩阵，每调用单独一个 turn）：未派发 → `write` / `edit` / `bash` / `mcp__github__push_files` / `office_render` / 未知工具 `zzz_unknown` **全部提醒**；`subagent` / `send_message` / `team_task_update` / `interrupt_agent` / `job_*` / `skill` 不提醒；已派发后**只有** `read` / `grep` / `glob` 豁免（`index.js:1333`），`write` / `bash` / `edit` 仍提醒；去重 key 含本 turn 的 `turn/start` 下标（`index.js:1319-1335`）→ 同 turn 只 1 条、新 turn 重新提醒；所有路径 `next()` 被调用（`next=1`），**无任何 deny 路径**（`grep "deny|throw"` 在门禁段只命中 `return next()`）。
6. **无硬编码 / 无糊弄**：全文件无空 `catch`、无 `TODO/FIXME/HACK`；无按测试输入写死的特判；`IMPLEMENTATION_TOOLS` / `EXECUTION_TOOLS` / `EVIDENCE_TOOLS`（`index.js:670-694`）逐个标注宿主注册名并可在宿主源码核对（`run_code` 见 `packages/core/tools/src/contracts.ts:13`）；`index.js:1248-1251` 的 `void error` 是文档化且有测试的「判不了就不提醒」策略，不是吞异常装成功。
7. **契约一致**：`send_message` 只读 `agent`（`index.js:1234`）与宿主 schema 一致（`packages/subagent/tool-subagent-control/src/index.ts:44-56`）；`list_agents` `parameters: {}`（`list-agents.ts:56`）；`/using-agent-team on|off|<task>` 解析未变（`index.js:735-739`）。
8. **测试未被迁就**：11 个被改测试文件 `test(` 数量前后完全一致（33→33、30→30、16→16 等），无删用例；断言从「点名工具名」改为「按 `leadGateToolCategory` 类别断言 + 显式禁止死工具名」，非恒真断言；新增 `tests/capability-tier.test.js` 的 fake `tools` 会记录 `definitions` 实参以核对 toolSet 传递。

---

## 结论

修复方向正确、档位派生与门禁语义是真实实现（不是为测试写的分支），rc.1 兜底与三档文案经实测成立。但存在一条会造成「修好的缺陷重新出现」且**静默无 warn** 的高危健壮性缺口（D-1），一条让 team 档门禁在 rc.2 事实下永久失效的功能缺口（D-3，测试已红），以及把「探测不到」说成「工具不存在」的假阴性（D-2）。要求先修 D-1 / D-3 / D-2 并补对应真实用例，再复核。

VERDICT: REJECT
