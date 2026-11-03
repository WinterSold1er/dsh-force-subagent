# Lead 取证门禁对抗审查报告（第 3 轮 · 终版）

- 审查对象：index.js（299 行）Lead 侧 tools/pre-execute 取证门禁；tests/lead-gate.test.js（375 行）
- 审查时间：2026-11-03（Asia/Shanghai）
- 证据基线：仓库 git 全部 untracked（`git status --porcelain` 全为 `??`），`git diff` 为空；以工作树逐行 + 宿主源码 + 真实跑测 + 独立探针为唯一事实源。
- 环境：node v26.13.0；命令 `cd /home/csy/Code/Github/dsh-force-subagent && node --test tests/`

## 1. 结论

VERDICT: APPROVE（第 3 轮 · 最终）

- 最终工作树真实跑测：exit 0，`ℹ tests 177 / suites 0 / pass 177 / fail 0 / duration_ms 235.903936`。
- D1（Lead 门禁对 read/grep/glob 失效）、D2（fail-open warn 未断言）、D3（无 membership 的 subagent 被误拦）全部修复并复测。
- D3 修法以宿主源码为准：读 `agent.session.header.delegationDepth`。第 2 轮 APPROVE 曾把 `packages/core/agent/src/index.ts:84` 当作 Agent 字段，实为 session 创建选项的 meta；该判断错误已在本轮纠正并重写报告。
- 交付前计数说明：L10c 由 Lead DIRECT 仲裁为 deny 语义（header 缺失 = depth 0，仍按 Lead 拦截），并新增 L10d 覆盖 header getter 抛错的 fail-open；测试计数由 176 增至 177，全量重跑 177/177 通过。

## 2. 宿主源码依据（D3 判据）

| 事实 | 宿主源码位置 |
|---|---|
| Agent 接口字段仅 options / session / inbox / status / ctx，无 delegationDepth | packages/core/agent/src/runtime-types.ts:163-174 |
| delegationDepth 属 SessionHeader，缺省=0=顶层会话 | packages/core/session/src/types.ts:119-124 |
| 写入点：session 创建时由 meta 写入 header | packages/core/session/src/index.ts:1174-1184（delegationDepth 在 1182） |
| 读取示例：`a2.session.header.delegationDepth` | packages/core/agent-loop/tests/resume.spec.ts:939 |

结论：index.js:196 `agent?.session?.header?.delegationDepth ?? 0` 是宿主真实可取路径；`agent.delegationDepth` 不存在，旧写法恒为 0。

## 3. 逐条核验（最终代码 index.js 299 行）

| 核验项 | 代码位置 | 结论 |
|---|---|---|
| EVIDENCE_TOOLS 恰好 bash/read/grep/glob | index.js:105-109 | 通过（Set 恰好 4 项，注释说明防 Lead 自己取证） |
| write/edit 未被拦 | index.js:109；L5；探针 F/G | 通过（Lead + write/edit → allow） |
| Lead 分支覆盖 EVIDENCE_TOOLS 全表 | index.js:174、182、192；L3；探针 A/B | 通过（bash/read/grep/glob 全 deny） |
| 成员门禁既有行为未改 | index.js:182、184-186；L6；探针 H/I | 通过（teammate read 放行、bash deny；member-gate-* 全绿） |
| subagent 不被误拦（D3） | index.js:192-201；L10；探针 C | 通过（header.delegationDepth=1 → allow） |
| header.delegationDepth=0 仍按 Lead 拦截（反向对照） | L10b；探针 B | 通过（deny） |
| header 缺失按 depth=0 处理，不 fail-open | index.js:196；L10c；探针 A/E | 通过（header undefined / 无 header 属性 → deny） |
| header 读取抛错 fail-open 且 warn 恰好 1 次 | index.js:194-200；L10d；探针 D | 通过（allow + 1 条 warn，文案点名 header 与放行后果） |
| turn 边界以最后一个 turn/start 为界 | index.js:215-228；L7 | 通过 |
| 复用 readEvents / enabledIn / warnFailOpen，未另起状态 | index.js:151-158、209、218、162-167 | 通过（零新增依赖、零新状态机） |
| fail-open 四类且 warn 一次点名原因 | index.js:203-228；L8/L9 | 通过 |
| 拒绝文案可执行 | index.js:111-112 | 通过（点名工具 + write_scopes/blocked_by） |
| 无硬编码/特判/吞异常 | index.js 全文 | 通过（无工具名+turn 号特判、无空 catch；header 读取异常单独 catch 且 warn） |

## 4. 缺陷闭环

### D1 [第 1 轮 BLOCKER → 已修复]
- 第 1 轮：index.js:174 `agent === undefined || isAllowedTool(tool)` 提前放行，read/grep/glob ∈ ALLOWED_TOOLS 被短路；L3 失败（拦 0/3）。
- 修复：174 只判 agent 缺失；182 白名单短路收窄为仅 teammate。
- 复核：L3 四工具全绿；探针 A/B 全 deny。

### D2 [第 1 轮 MINOR → 已修复]
- tests/lead-gate.test.js:308-311 现断言 fail-open `warnings.length === 1` 且文案命中工具/原因/后果；L8 绿。

### D3 [第 1 轮 MINOR → 第 2 轮误判 → 第 3 轮已修复]
- 第 1 轮：无 membership 会话进 Lead 分支（探针 case7 复现）。
- 第 2 轮误修：`agent?.delegationDepth ?? 0`（Agent 无此字段，恒 0，isSubagent 恒 false）。
- 第 3 轮修复：index.js:194-201 读 `agent?.session?.header?.delegationDepth ?? 0`；读取抛错 fail-open + warn 一次；depth≥1 放行。
- 测试：L10（depth=1 放行）、L10b（depth=0 必须 deny）、L10c（header 缺失 = depth 0 → deny，Lead 仲裁后定稿）、L10d（header getter 抛错 → fail-open + warn 恰好 1 次）。修复前实测 L10/L10c 红灯（见 5.2），证明用例非空转。
- 独立探针：C allow、B deny、D allow+warn1。

### D4 [INFO] warnFailOpen 进程级 once（index.js:162-167）
成员分支先 fail-open 后，Lead 分支同类降级不再告警；与既有「防刷屏只 warn 一次」风格一致，记录不改判。

## 5. 测试证据（三次真实跑测，原始输出）

### 5.1 第 1 轮（REJECT）：tests 172 / pass 168 / fail 4

命令：`node --test tests/`；退出码：1；失败：L3 的 read、grep、glob。

```text
✔ apply 注册命令与 systemPrompt section，声明 inject、不监听 agent/pre-step (4.243377ms)
✔ handler 返回会话页可见的 success 行；off 返回关闭确认 (1.923867ms)
✔ 无 command/run 记录的普通会话：text 返回空串 (0.416184ms)
✔ 最后一条 using-agent-team 记录为 on/task：text 非空 (0.274472ms)
✔ 未带 args（直接 /using-agent-team）：视为开启 (0.26686ms)
✔ 最后一条记录为 off：text 返回空串（大小写/空格不敏感） (0.198491ms)
✔ 只认 using-agent-team，其它命令记录不触发 (0.236629ms)
✔ 以最后一条 using-agent-team 记录为准：先 on 后 off 不注入，先 off 后 on 注入 (0.250692ms)
✔ 会话隔离：A 开启不影响 B；B 自己开启后才有提示 (0.316314ms)
✔ context.agent 路径注入提醒（session 兜底已移除） (0.471272ms)
✔ 真实 Session 形态：私有日志通过 snapshotEvents() 读取 (0.260833ms)
✔ 会话形状异常：返回空串且 logger.warn 记录异常（不空 catch） (0.281651ms)
✔ 无 session 上下文：返回空串且不告警 (0.142784ms)
✔ 成员：Lead 会话已开启时自动注入成员提醒（不依赖 Lead 手动提醒） (0.241124ms)
✔ 成员：Lead 未开启或已 off 时不注入 (0.19477ms)
✔ 成员判定优先于自身记录：成员自身有 on 但 Lead 未开启仍不注入 (0.142749ms)
✔ Lead 身份（role=lead）仍按自身会话门控，注入 Lead 版提醒 (0.140593ms)
✔ 成员：无 agentTeams 服务时退回本会话门控，不误判为成员 (0.118212ms)
✔ 成员：Lead 会话读取异常 → warn 且不注入 (0.17561ms)
✔ 命令撞名 already registered：warn 含命令名与修复步骤，section 仍注册 (0.213583ms)
✔ 命令注册的其它错误必须原样抛出，不得吞掉 (0.545586ms)
✔ systemPrompt.section 撞名 already registered：warn 含 section 名，命令仍注册且 handler 返回 success (0.237334ms)
✔ systemPrompt.section 注册的其它错误必须原样抛出，不得吞掉 (0.179105ms)
✔ parseCommandInput：空串与 on（含大小写/空白）开启且无 task，off 关闭，其它文本带 task 原文 (0.233368ms)
✔ section 文本：开启带 task 时追加任务段并保留 Lead 指令 (0.163223ms)
✔ section 文本：开启无 task 与关闭时都不出现任务段 (0.13859ms)
✔ handler 带 task：steer 恰好一次、inject 零次，消息为 user notice 且含任务原文 (0.381218ms)
✔ handler 无 task（裸命令 / on）：inject 一次、steer 零次，提醒说明持续到 off (0.274902ms)
✔ handler off：inject 一次关闭提醒且文案表达关闭 (0.211914ms)
✔ handler：agent 缺失 steer/inject 时跳过投递，仍 success 且不 warn (0.239073ms)
✔ handler：steer / inject 抛错时各 warn 一次并仍返回 success（不空 catch） (0.278972ms)
✔ handler 已开启会话再次执行：每次都再投递一条新 notice（重复 steer） (0.203437ms)
✔ 成员会话：Lead 下达的 task 也出现在成员 section 文本里 (0.157306ms)
✔ agentTeams 服务缺失：门禁降级必须 warn，且文本点名 agentTeams 或说明门禁未生效 (1.899407ms)
✔ tryMembership 抛错：warn 文本必须包含被拦工具名与异常原因（不空 catch） (0.381216ms)
✔ 同一降级条件连续触发两次：warn 计数仍为 1（防刷屏） (0.324259ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（Lead 门禁断言的前提） (1.89586ms)
✔ L1 启用 + Lead + 本轮无 team_task_create：bash 必须 deny（next 0 次，理由点名 bash 与 team_task_create） (1.176304ms)
✔ L2 启用 + Lead + 本轮已有 team_task_create 的 tool/call：bash 放行（next 恰好 1 次） (0.577816ms)
▶ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次）
  ✔ bash (0.379086ms)
  ✖ read (1.034099ms)
  ✖ grep (0.349136ms)
  ✖ glob (0.310258ms)
✖ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次） (4.064233ms)
▶ L4 force-subagent 未启用：bash 放行（next 恰好 1 次）
  ✔ 无 command/run 记录 (0.373497ms)
  ✔ 最后一次记录 args=off (0.356469ms)
  ✔ 先 on 后 off（以最后一次为准） (0.222103ms)
✔ L4 force-subagent 未启用：bash 放行（next 恰好 1 次） (1.650121ms)
▶ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次）
  ✔ spawn_teammate (0.294037ms)
  ✔ team_task_create (0.149313ms)
  ✔ wait_agent (0.11979ms)
✔ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次） (1.101079ms)
▶ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行
  ✔ bash (0.390987ms)
  ✔ read (0.112867ms)
  ✔ grep (0.099021ms)
  ✔ glob (0.103269ms)
✔ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行 (1.207349ms)
▶ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次）
  ✔ create 在前一 turn，随后 turn/start 开新 turn (0.219871ms)
  ✔ 本 turn 只有非 create 的 tool/call (0.144511ms)
✔ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次） (0.704811ms)
✔ L8 fail-open：snapshotEvents 抛错时放行（next 恰好 1 次、不抛异常、不 deny） (0.358091ms)
✔ 契约：apply 注册 tools/pre-execute 处理器且为函数 (1.918303ms)
✔ 白名单表自检：恰好 21 项且无重复 (0.280325ms)
▶ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行
  ✔ subagent (0.686009ms)
  ✔ subagent_fork (0.262184ms)
  ✔ subagent_role (0.235653ms)
  ✔ close_subagent (1.396551ms)
  ✔ workflow (0.213536ms)
  ✔ team_task_create (0.223304ms)
  ✔ team_task_get (0.283198ms)
  ✔ team_task_list (0.275553ms)
  ✔ team_task_update (0.24465ms)
  ✔ send_message (0.154086ms)
  ✔ wait_agent (0.116698ms)
  ✔ list_agents (0.123075ms)
  ✔ interrupt_agent (0.112858ms)
  ✔ job_output (0.110785ms)
  ✔ job_kill (0.138125ms)
  ✔ job_list (0.093316ms)
  ✔ skill (0.114919ms)
  ✔ todo_write (0.108898ms)
  ✔ read (0.082665ms)
  ✔ grep (0.095222ms)
  ✔ glob (0.0699ms)
✔ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行 (8.034077ms)
▶ B 组：门禁不生效或评估失败时必须经 next() 放行
  ▶ B1 未命中成员：tryMembership 返回 undefined
    ✔ read (0.220234ms)
    ✔ subagent (0.091116ms)
    ✔ send_message (0.103276ms)
    ✔ bash (0.311478ms)
    ✔ edit (0.103336ms)
    ✔ mcp__github__get_me (0.112ms)
  ✔ B1 未命中成员：tryMembership 返回 undefined (1.687684ms)
  ▶ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined
    ✔ read (0.189503ms)
    ✔ subagent (0.103038ms)
    ✔ send_message (0.126493ms)
    ✔ bash (0.104462ms)
    ✔ edit (0.08658ms)
    ✔ mcp__github__get_me (0.084048ms)
  ✔ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined (1.222047ms)
  ▶ B3 Lead 会话最后一次 command/run 为 off
    ✔ read (0.256941ms)
    ✔ subagent (0.151421ms)
    ✔ send_message (0.08537ms)
    ✔ bash (0.135266ms)
    ✔ edit (0.186023ms)
    ✔ mcp__github__get_me (0.117776ms)
  ✔ B3 Lead 会话最后一次 command/run 为 off (1.522685ms)
  ▶ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.162417ms)
    ✔ subagent (0.084784ms)
    ✔ send_message (0.083807ms)
    ✔ bash (0.15064ms)
    ✔ edit (0.088225ms)
    ✔ mcp__github__get_me (0.095482ms)
  ✔ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next (1.240862ms)
  ▶ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.183465ms)
    ✔ subagent (0.092665ms)
    ✔ send_message (0.07996ms)
    ✔ bash (1.044697ms)
    ✔ edit (0.11422ms)
    ✔ mcp__github__get_me (0.090566ms)
  ✔ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next (2.108239ms)
✔ B 组：门禁不生效或评估失败时必须经 next() 放行 (8.321325ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（deny 断言的前提） (1.642753ms)
▶ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next
  ✔ bash (1.06047ms)
  ✔ edit (0.279087ms)
  ✔ write (0.269035ms)
  ✔ web_search (0.225715ms)
  ✔ web_fetch (2.007937ms)
  ✔ run_code (0.221488ms)
  ✔ pwsh (0.22078ms)
  ✔ terminal_open (0.348928ms)
  ✔ terminal_send (0.30091ms)
  ✔ str_replace_editor (0.20229ms)
  ✔ create_skill (0.191632ms)
  ✔ caveman_browse (0.125026ms)
  ✔ create_worktree (0.110691ms)
  ✔ lsp (0.133018ms)
  ✔ spawn_teammate (0.169402ms)
  ✔ ask_user_question (0.102214ms)
  ✔ present (0.08961ms)
  ✔ update_goal (0.121103ms)
  ✔ mcp__github__get_me (0.100036ms)
  ✔ mcp__telegram__any (0.083599ms)
✔ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next (9.20328ms)
▶ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法）
  ✔ args=undefined (0.231532ms)
  ✔ args="on" (0.093472ms)
  ✔ args="ON" (0.098882ms)
  ✔ args="enable" (0.124585ms)
  ✔ args="  on  " (0.086945ms)
✔ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法） (1.248316ms)
▶ 边界组：门禁不成立时不得 deny，且 next 恰好一次
  ✔ B1 Lead 身份（role=lead，Lead 会话已开启） (0.408972ms)
  ✔ B2 teammate 但 Lead 会话 command/run args=off (0.187704ms)
  ✔ B3 非成员（tryMembership 返回 undefined） (0.219187ms)
  ✔ B4 agentTeams 服务缺失 (0.200329ms)
✔ 边界组：门禁不成立时不得 deny，且 next 恰好一次 (1.623057ms)
✔ T1 命令注册名精确为 using-agent-team (1.954883ms)
✔ T2 新 session 未 invoke → 空串 (0.452608ms)
✔ T3 invoke 后同一 session → 提醒含关键词与任务原文；裸命令仍单行 (2.471397ms)
✔ T4 args 为 off（含大小写/前导空白）→ 空串 (0.50584ms)
✔ T5 最后一条记录生效：on → off → on (0.53627ms)
✔ T6 无关命令（clear）不触发 (0.240616ms)
✔ T7 会话隔离（双向）：B 先 on 不影响 A；A on、B on→off 后 A 仍开 (0.313408ms)
✔ T8 幂等：重复 invoke 不叠加 (0.381981ms)
✔ T9 handler 返回 success 且 text 非空 (0.34141ms)
✔ T10 无伪造注入：未注册 agent/pre-step，返回值里不含消息（投递走 agent.steer/inject） (0.504454ms)
✔ T11 诊断路径：context 缺 agent/session 时 text 返回空串且不抛 (0.269105ms)
✔ T12 snapshotEvents 路径：无 .events、返回值被冻结 (0.365888ms)
✔ T13 依赖声明：apply 期间 get 的服务全部在模块 inject 数组内 (0.211835ms)
✔ T14 不可变：handler 不写 session 日志、不改写 agent (0.932538ms)
✔ T15 裸命令：data 无 args 字段与 args:"" 都必须开启 (0.223742ms)
✔ T16 handler on/off 文案语义：on 与 off 都必须成功且文案互斥 (0.340164ms)
✔ T17 handler 返回形状防漂移：恒为 { kind, text } 对象 (0.23539ms)
✔ T18 每次 invoke 都投递模型可见 notice：带 task 走 steer，其余走 inject (0.46776ms)
ℹ tests 172
ℹ suites 0
ℹ pass 168
ℹ fail 4
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 144.953135

✖ failing tests:

test at tests/lead-gate.test.js:225:13
✖ read (1.034099ms)
  AssertionError [ERR_ASSERTION]: L3 Lead 已启用且本轮无 create（read） / read：必须 deny，实际处理器返回：[{"kind":"allow","via":"next"}]
      at assertDenied (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:162:10)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:229:7)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:225:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at tests/lead-gate.test.js:225:13
✖ grep (0.349136ms)
  AssertionError [ERR_ASSERTION]: L3 Lead 已启用且本轮无 create（grep） / grep：必须 deny，实际处理器返回：[{"kind":"allow","via":"next"}]
      at assertDenied (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:162:10)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:229:7)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:225:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at tests/lead-gate.test.js:225:13
✖ glob (0.310258ms)
  AssertionError [ERR_ASSERTION]: L3 Lead 已启用且本轮无 create（glob） / glob：必须 deny，实际处理器返回：[{"kind":"allow","via":"next"}]
      at assertDenied (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:162:10)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:229:7)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:225:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

### 5.2 第 3 轮修复前（红，证明 L10/L10c 有效）：tests 176 / pass 174 / fail 2

命令：`node --test tests/`；退出码：1；失败：L10（header.delegationDepth=1 仍 deny）、L10c（当时为「header getter 抛错 → fail-open 放行」用例，因实现返回 deny 而红；该用例后由 Lead 仲裁改名/改语义为「header 缺失按 depth=0 → deny」）。

```text
✔ apply 注册命令与 systemPrompt section，声明 inject、不监听 agent/pre-step (9.8166ms)
✔ handler 返回会话页可见的 success 行；off 返回关闭确认 (4.425712ms)
✔ 无 command/run 记录的普通会话：text 返回空串 (2.723452ms)
✔ 最后一条 using-agent-team 记录为 on/task：text 非空 (0.443085ms)
✔ 未带 args（直接 /using-agent-team）：视为开启 (2.013877ms)
✔ 最后一条记录为 off：text 返回空串（大小写/空格不敏感） (0.810873ms)
✔ 只认 using-agent-team，其它命令记录不触发 (0.832429ms)
✔ 以最后一条 using-agent-team 记录为准：先 on 后 off 不注入，先 off 后 on 注入 (5.022352ms)
✔ 会话隔离：A 开启不影响 B；B 自己开启后才有提示 (4.057523ms)
✔ context.agent 路径注入提醒（session 兜底已移除） (0.984898ms)
✔ 真实 Session 形态：私有日志通过 snapshotEvents() 读取 (1.172614ms)
✔ 会话形状异常：返回空串且 logger.warn 记录异常（不空 catch） (0.442388ms)
✔ 无 session 上下文：返回空串且不告警 (2.729369ms)
✔ 成员：Lead 会话已开启时自动注入成员提醒（不依赖 Lead 手动提醒） (0.48888ms)
✔ 成员：Lead 未开启或已 off 时不注入 (2.234149ms)
✔ 成员判定优先于自身记录：成员自身有 on 但 Lead 未开启仍不注入 (0.482973ms)
✔ Lead 身份（role=lead）仍按自身会话门控，注入 Lead 版提醒 (0.288904ms)
✔ 成员：无 agentTeams 服务时退回本会话门控，不误判为成员 (0.283318ms)
✔ 成员：Lead 会话读取异常 → warn 且不注入 (0.355239ms)
✔ 命令撞名 already registered：warn 含命令名与修复步骤，section 仍注册 (0.604128ms)
✔ 命令注册的其它错误必须原样抛出，不得吞掉 (1.553506ms)
✔ systemPrompt.section 撞名 already registered：warn 含 section 名，命令仍注册且 handler 返回 success (0.680475ms)
✔ systemPrompt.section 注册的其它错误必须原样抛出，不得吞掉 (0.502538ms)
✔ parseCommandInput：空串与 on（含大小写/空白）开启且无 task，off 关闭，其它文本带 task 原文 (0.640757ms)
✔ section 文本：开启带 task 时追加任务段并保留 Lead 指令 (0.480623ms)
✔ section 文本：开启无 task 与关闭时都不出现任务段 (0.355897ms)
✔ handler 带 task：steer 恰好一次、inject 零次，消息为 user notice 且含任务原文 (0.955646ms)
✔ handler 无 task（裸命令 / on）：inject 一次、steer 零次，提醒说明持续到 off (0.740094ms)
✔ handler off：inject 一次关闭提醒且文案表达关闭 (0.447464ms)
✔ handler：agent 缺失 steer/inject 时跳过投递，仍 success 且不 warn (0.575406ms)
✔ handler：steer / inject 抛错时各 warn 一次并仍返回 success（不空 catch） (0.44498ms)
✔ handler 已开启会话再次执行：每次都再投递一条新 notice（重复 steer） (0.455966ms)
✔ 成员会话：Lead 下达的 task 也出现在成员 section 文本里 (0.262614ms)
✔ agentTeams 服务缺失：门禁降级必须 warn，且文本点名 agentTeams 或说明门禁未生效 (6.165157ms)
✔ tryMembership 抛错：warn 文本必须包含被拦工具名与异常原因（不空 catch） (1.133808ms)
✔ 同一降级条件连续触发两次：warn 计数仍为 1（防刷屏） (1.005935ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（Lead 门禁断言的前提） (3.340091ms)
✔ L1 启用 + Lead + 本轮无 team_task_create：bash 必须 deny（next 0 次，理由点名 bash 与 team_task_create） (1.831913ms)
✔ L2 启用 + Lead + 本轮已有 team_task_create 的 tool/call：bash 放行（next 恰好 1 次） (3.744521ms)
▶ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次）
  ✔ bash (0.718107ms)
  ✔ read (0.421318ms)
  ✔ grep (0.482784ms)
  ✔ glob (0.458153ms)
✔ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次） (3.554554ms)
▶ L4 force-subagent 未启用：bash 放行（next 恰好 1 次）
  ✔ 无 command/run 记录 (0.680103ms)
  ✔ 最后一次记录 args=off (0.502818ms)
  ✔ 先 on 后 off（以最后一次为准） (0.338022ms)
✔ L4 force-subagent 未启用：bash 放行（next 恰好 1 次） (2.632215ms)
▶ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次）
  ✔ spawn_teammate (0.451653ms)
  ✔ team_task_create (0.25499ms)
  ✔ wait_agent (0.253132ms)
✔ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次） (1.641526ms)
▶ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行
  ✔ bash (0.667631ms)
  ✔ read (0.189346ms)
  ✔ grep (0.206725ms)
  ✔ glob (0.159276ms)
✔ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行 (1.987669ms)
▶ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次）
  ✔ create 在前一 turn，随后 turn/start 开新 turn (0.353927ms)
  ✔ 本 turn 只有非 create 的 tool/call (0.218512ms)
✔ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次） (1.211323ms)
✔ L8 fail-open：snapshotEvents 抛错时放行（next 恰好 1 次、不抛异常、不 deny） (0.795585ms)
✔ L9 Lead 启用但事件中无 turn/start：read 走 fail-open 放行（对齐 member-gate-allow B1/B2/B4a） (0.522651ms)
✖ L10 subagent 会话头 delegationDepth=1：取证 read 不被 Lead 门禁误伤（放行） (2.629299ms)
✔ L10b 反向对照：同一 fixture header.delegationDepth=0（Lead）→ read 必须 deny（next 0） (0.59567ms)
✖ L10c 会话头不可读（header getter 抛错）：fail-open 放行且 warn 恰好 1 次 (1.009481ms)
✔ 契约：apply 注册 tools/pre-execute 处理器且为函数 (7.066722ms)
✔ 白名单表自检：恰好 21 项且无重复 (0.518922ms)
▶ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行
  ✔ subagent (5.095997ms)
  ✔ subagent_fork (0.753985ms)
  ✔ subagent_role (0.668577ms)
  ✔ close_subagent (2.879444ms)
  ✔ workflow (0.614541ms)
  ✔ team_task_create (0.752806ms)
  ✔ team_task_get (0.783111ms)
  ✔ team_task_list (0.851026ms)
  ✔ team_task_update (0.706141ms)
  ✔ send_message (0.494339ms)
  ✔ wait_agent (0.406592ms)
  ✔ list_agents (0.343972ms)
  ✔ interrupt_agent (3.624028ms)
  ✔ job_output (0.359294ms)
  ✔ job_kill (0.312269ms)
  ✔ job_list (0.288661ms)
  ✔ skill (0.21538ms)
  ✔ todo_write (0.287376ms)
  ✔ read (0.214451ms)
  ✔ grep (0.24342ms)
  ✔ glob (0.214908ms)
✔ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行 (28.291116ms)
▶ B 组：门禁不生效或评估失败时必须经 next() 放行
  ▶ B1 未命中成员：tryMembership 返回 undefined
    ✔ read (1.41012ms)
    ✔ subagent (0.30477ms)
    ✔ send_message (0.27373ms)
    ✔ bash (0.319677ms)
    ✔ edit (0.308293ms)
    ✔ mcp__github__get_me (0.360576ms)
  ✔ B1 未命中成员：tryMembership 返回 undefined (5.409652ms)
  ▶ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined
    ✔ read (0.271814ms)
    ✔ subagent (0.140232ms)
    ✔ send_message (0.144624ms)
    ✔ bash (0.181526ms)
    ✔ edit (0.13995ms)
    ✔ mcp__github__get_me (0.128876ms)
  ✔ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined (1.801228ms)
  ▶ B3 Lead 会话最后一次 command/run 为 off
    ✔ read (0.953634ms)
    ✔ subagent (0.141141ms)
    ✔ send_message (0.173619ms)
    ✔ bash (0.187739ms)
    ✔ edit (0.943753ms)
    ✔ mcp__github__get_me (0.181322ms)
  ✔ B3 Lead 会话最后一次 command/run 为 off (3.445403ms)
  ▶ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.414974ms)
    ✔ subagent (0.161496ms)
    ✔ send_message (0.130253ms)
    ✔ bash (0.147648ms)
    ✔ edit (0.142625ms)
    ✔ mcp__github__get_me (0.126509ms)
  ✔ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next (1.962728ms)
  ▶ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.328211ms)
    ✔ subagent (0.130132ms)
    ✔ send_message (0.133638ms)
    ✔ bash (0.226692ms)
    ✔ edit (0.296105ms)
    ✔ mcp__github__get_me (0.227004ms)
  ✔ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next (4.725861ms)
✔ B 组：门禁不生效或评估失败时必须经 next() 放行 (18.409638ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（deny 断言的前提） (8.140753ms)
▶ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next
  ✔ bash (3.00174ms)
  ✔ edit (0.859726ms)
  ✔ write (1.164812ms)
  ✔ web_search (1.291929ms)
  ✔ web_fetch (0.745682ms)
  ✔ run_code (0.609386ms)
  ✔ pwsh (0.677624ms)
  ✔ terminal_open (1.15409ms)
  ✔ terminal_send (1.030035ms)
  ✔ str_replace_editor (0.598516ms)
  ✔ create_skill (0.476797ms)
  ✔ caveman_browse (0.458072ms)
  ✔ create_worktree (0.34107ms)
  ✔ lsp (1.164496ms)
  ✔ spawn_teammate (0.399088ms)
  ✔ ask_user_question (0.359249ms)
  ✔ present (0.328371ms)
  ✔ update_goal (0.30674ms)
  ✔ mcp__github__get_me (0.239472ms)
  ✔ mcp__telegram__any (0.20989ms)
✔ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next (27.588479ms)
▶ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法）
  ✔ args=undefined (0.608267ms)
  ✔ args="on" (0.28691ms)
  ✔ args="ON" (0.328012ms)
  ✔ args="enable" (0.404024ms)
  ✔ args="  on  " (0.83432ms)
✔ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法） (4.291044ms)
▶ 边界组：门禁不成立时不得 deny，且 next 恰好一次
  ✔ B1 Lead 身份（role=lead，Lead 会话已开启） (1.546071ms)
  ✔ B2 teammate 但 Lead 会话 command/run args=off (0.588378ms)
  ✔ B3 非成员（tryMembership 返回 undefined） (0.701966ms)
  ✔ B4 agentTeams 服务缺失 (0.577221ms)
✔ 边界组：门禁不成立时不得 deny，且 next 恰好一次 (5.418604ms)
✔ T1 命令注册名精确为 using-agent-team (5.784ms)
✔ T2 新 session 未 invoke → 空串 (3.588477ms)
✔ T3 invoke 后同一 session → 提醒含关键词与任务原文；裸命令仍单行 (3.637391ms)
✔ T4 args 为 off（含大小写/前导空白）→ 空串 (1.035785ms)
✔ T5 最后一条记录生效：on → off → on (0.964174ms)
✔ T6 无关命令（clear）不触发 (0.356764ms)
✔ T7 会话隔离（双向）：B 先 on 不影响 A；A on、B on→off 后 A 仍开 (0.476064ms)
✔ T8 幂等：重复 invoke 不叠加 (0.563277ms)
✔ T9 handler 返回 success 且 text 非空 (0.849632ms)
✔ T10 无伪造注入：未注册 agent/pre-step，返回值里不含消息（投递走 agent.steer/inject） (4.336722ms)
✔ T11 诊断路径：context 缺 agent/session 时 text 返回空串且不抛 (0.488523ms)
✔ T12 snapshotEvents 路径：无 .events、返回值被冻结 (0.494461ms)
✔ T13 依赖声明：apply 期间 get 的服务全部在模块 inject 数组内 (0.498652ms)
✔ T14 不可变：handler 不写 session 日志、不改写 agent (1.694981ms)
✔ T15 裸命令：data 无 args 字段与 args:"" 都必须开启 (0.328726ms)
✔ T16 handler on/off 文案语义：on 与 off 都必须成功且文案互斥 (0.486356ms)
✔ T17 handler 返回形状防漂移：恒为 { kind, text } 对象 (0.354991ms)
✔ T18 每次 invoke 都投递模型可见 notice：带 task 走 steer，其余走 inject (0.711319ms)
ℹ tests 176
ℹ suites 0
ℹ pass 174
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 419.48464

✖ failing tests:

test at tests/lead-gate.test.js:328:1
✖ L10 subagent 会话头 delegationDepth=1：取证 read 不被 Lead 门禁误伤（放行） (2.629299ms)
  AssertionError [ERR_ASSERTION]: L10 subagent header.delegationDepth=1 / read：不得 deny，处理器 #1 返回 {"kind":"deny","reason":"Lead 会话已启用 force-subagent：本轮必须先调用 team_task_create 登记任务（write_scopes 写明改哪些文件、blocked_by 写明依赖），再执行取证工具「read」。bash/read/grep/glob 属取证动作，由你派发的 subagent 执行；Lead 只做拆分、派发、合并与校验。"}
      at assertAllowed (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:134:12)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:331:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'deny',
    expected: 'deny',
    operator: 'notStrictEqual',
    diff: 'simple'
  }

test at tests/lead-gate.test.js:340:1
✖ L10c 会话头不可读（header getter 抛错）：fail-open 放行且 warn 恰好 1 次 (1.009481ms)
  AssertionError [ERR_ASSERTION]: L10c header 不可读 fail-open / read：不得 deny，处理器 #1 返回 {"kind":"deny","reason":"Lead 会话已启用 force-subagent：本轮必须先调用 team_task_create 登记任务（write_scopes 写明改哪些文件、blocked_by 写明依赖），再执行取证工具「read」。bash/read/grep/glob 属取证动作，由你派发的 subagent 执行；Lead 只做拆分、派发、合并与校验。"}
      at assertAllowed (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:134:12)
      at async TestContext.<anonymous> (file:///home/csy/Code/Github/dsh-force-subagent/tests/lead-gate.test.js:352:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'deny',
    expected: 'deny',
    operator: 'notStrictEqual',
    diff: 'simple'
  }
```

### 5.3 交付前最终（APPROVE）：tests 177 / pass 177 / fail 0

命令：`node --test tests/`；退出码：0；`ℹ tests 177 / suites 0 / pass 177 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 235.903936`。

```text
✔ apply 注册命令与 systemPrompt section，声明 inject、不监听 agent/pre-step (8.071235ms)
✔ handler 返回会话页可见的 success 行；off 返回关闭确认 (3.645403ms)
✔ 无 command/run 记录的普通会话：text 返回空串 (0.691913ms)
✔ 最后一条 using-agent-team 记录为 on/task：text 非空 (0.477409ms)
✔ 未带 args（直接 /using-agent-team）：视为开启 (0.409044ms)
✔ 最后一条记录为 off：text 返回空串（大小写/空格不敏感） (0.328402ms)
✔ 只认 using-agent-team，其它命令记录不触发 (0.388211ms)
✔ 以最后一条 using-agent-team 记录为准：先 on 后 off 不注入，先 off 后 on 注入 (0.408343ms)
✔ 会话隔离：A 开启不影响 B；B 自己开启后才有提示 (0.583116ms)
✔ context.agent 路径注入提醒（session 兜底已移除） (0.672762ms)
✔ 真实 Session 形态：私有日志通过 snapshotEvents() 读取 (0.390929ms)
✔ 会话形状异常：返回空串且 logger.warn 记录异常（不空 catch） (0.449619ms)
✔ 无 session 上下文：返回空串且不告警 (0.221373ms)
✔ 成员：Lead 会话已开启时自动注入成员提醒（不依赖 Lead 手动提醒） (0.398001ms)
✔ 成员：Lead 未开启或已 off 时不注入 (0.387968ms)
✔ 成员判定优先于自身记录：成员自身有 on 但 Lead 未开启仍不注入 (0.227061ms)
✔ Lead 身份（role=lead）仍按自身会话门控，注入 Lead 版提醒 (0.193639ms)
✔ 成员：无 agentTeams 服务时退回本会话门控，不误判为成员 (0.14385ms)
✔ 成员：Lead 会话读取异常 → warn 且不注入 (0.20637ms)
✔ 命令撞名 already registered：warn 含命令名与修复步骤，section 仍注册 (0.235324ms)
✔ 命令注册的其它错误必须原样抛出，不得吞掉 (0.692188ms)
✔ systemPrompt.section 撞名 already registered：warn 含 section 名，命令仍注册且 handler 返回 success (0.355503ms)
✔ systemPrompt.section 注册的其它错误必须原样抛出，不得吞掉 (0.30559ms)
✔ parseCommandInput：空串与 on（含大小写/空白）开启且无 task，off 关闭，其它文本带 task 原文 (0.364204ms)
✔ section 文本：开启带 task 时追加任务段并保留 Lead 指令 (0.261191ms)
✔ section 文本：开启无 task 与关闭时都不出现任务段 (0.232794ms)
✔ handler 带 task：steer 恰好一次、inject 零次，消息为 user notice 且含任务原文 (0.571471ms)
✔ handler 无 task（裸命令 / on）：inject 一次、steer 零次，提醒说明持续到 off (0.449111ms)
✔ handler off：inject 一次关闭提醒且文案表达关闭 (0.266221ms)
✔ handler：agent 缺失 steer/inject 时跳过投递，仍 success 且不 warn (0.407603ms)
✔ handler：steer / inject 抛错时各 warn 一次并仍返回 success（不空 catch） (0.444476ms)
✔ handler 已开启会话再次执行：每次都再投递一条新 notice（重复 steer） (0.384235ms)
✔ 成员会话：Lead 下达的 task 也出现在成员 section 文本里 (0.312065ms)
✔ agentTeams 服务缺失：门禁降级必须 warn，且文本点名 agentTeams 或说明门禁未生效 (2.487582ms)
✔ tryMembership 抛错：warn 文本必须包含被拦工具名与异常原因（不空 catch） (0.464044ms)
✔ 同一降级条件连续触发两次：warn 计数仍为 1（防刷屏） (0.376844ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（Lead 门禁断言的前提） (3.430711ms)
✔ L1 启用 + Lead + 本轮无 team_task_create：bash 必须 deny（next 0 次，理由点名 bash 与 team_task_create） (1.962838ms)
✔ L2 启用 + Lead + 本轮已有 team_task_create 的 tool/call：bash 放行（next 恰好 1 次） (1.023005ms)
▶ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次）
  ✔ bash (2.307562ms)
  ✔ read (0.572655ms)
  ✔ grep (0.520713ms)
  ✔ glob (0.412391ms)
✔ L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次） (5.360015ms)
▶ L4 force-subagent 未启用：bash 放行（next 恰好 1 次）
  ✔ 无 command/run 记录 (0.6877ms)
  ✔ 最后一次记录 args=off (0.555357ms)
  ✔ 先 on 后 off（以最后一次为准） (0.353162ms)
✔ L4 force-subagent 未启用：bash 放行（next 恰好 1 次） (2.845629ms)
▶ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次）
  ✔ spawn_teammate (0.481412ms)
  ✔ team_task_create (0.237158ms)
  ✔ wait_agent (0.298353ms)
✔ L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次） (1.885775ms)
▶ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行
  ✔ bash (0.676014ms)
  ✔ read (0.197663ms)
  ✔ grep (0.192727ms)
  ✔ glob (0.231075ms)
✔ L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行 (2.156402ms)
▶ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次）
  ✔ create 在前一 turn，随后 turn/start 开新 turn (0.378762ms)
  ✔ 本 turn 只有非 create 的 tool/call (0.227776ms)
✔ L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次） (1.208794ms)
✔ L8 fail-open：snapshotEvents 抛错时放行（next 恰好 1 次、不抛异常、不 deny） (0.749052ms)
✔ L9 Lead 启用但事件中无 turn/start：read 走 fail-open 放行（对齐 member-gate-allow B1/B2/B4a） (0.279673ms)
✔ L10 subagent 会话头 delegationDepth=1：取证 read 不被 Lead 门禁误伤（放行） (0.338045ms)
✔ L10b 反向对照：同一 fixture header.delegationDepth=0（Lead）→ read 必须 deny（next 0） (0.387297ms)
✔ L10c 会话头缺失按 depth=0 处理 → deny（next 0） (0.419925ms)
✔ L10d 会话头 getter 抛错：fail-open 放行且 warn 恰好 1 次 (0.592846ms)
✔ 契约：apply 注册 tools/pre-execute 处理器且为函数 (2.78193ms)
✔ 白名单表自检：恰好 21 项且无重复 (0.336419ms)
▶ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行
  ✔ subagent (0.801454ms)
  ✔ subagent_fork (0.347519ms)
  ✔ subagent_role (0.259954ms)
  ✔ close_subagent (2.839643ms)
  ✔ workflow (0.275976ms)
  ✔ team_task_create (0.317102ms)
  ✔ team_task_get (0.550078ms)
  ✔ team_task_list (0.348208ms)
  ✔ team_task_update (0.355886ms)
  ✔ send_message (0.211832ms)
  ✔ wait_agent (0.19834ms)
  ✔ list_agents (0.152093ms)
  ✔ interrupt_agent (0.209601ms)
  ✔ job_output (0.211182ms)
  ✔ job_kill (0.133486ms)
  ✔ job_list (0.106346ms)
  ✔ skill (0.150066ms)
  ✔ todo_write (0.215842ms)
  ✔ read (0.100502ms)
  ✔ grep (0.086864ms)
  ✔ glob (0.078662ms)
✔ A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行 (12.058063ms)
▶ B 组：门禁不生效或评估失败时必须经 next() 放行
  ▶ B1 未命中成员：tryMembership 返回 undefined
    ✔ read (0.915076ms)
    ✔ subagent (0.109528ms)
    ✔ send_message (0.144306ms)
    ✔ bash (0.121018ms)
    ✔ edit (0.24584ms)
    ✔ mcp__github__get_me (0.126692ms)
  ✔ B1 未命中成员：tryMembership 返回 undefined (2.402517ms)
  ▶ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined
    ✔ read (0.244654ms)
    ✔ subagent (0.101307ms)
    ✔ send_message (0.094725ms)
    ✔ bash (0.138944ms)
    ✔ edit (0.09169ms)
    ✔ mcp__github__get_me (0.089092ms)
  ✔ B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined (1.312037ms)
  ▶ B3 Lead 会话最后一次 command/run 为 off
    ✔ read (0.274223ms)
    ✔ subagent (0.098496ms)
    ✔ send_message (0.159997ms)
    ✔ bash (0.114109ms)
    ✔ edit (0.184349ms)
    ✔ mcp__github__get_me (0.134425ms)
  ✔ B3 Lead 会话最后一次 command/run 为 off (1.614128ms)
  ▶ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.257946ms)
    ✔ subagent (0.155253ms)
    ✔ send_message (0.104131ms)
    ✔ bash (0.187288ms)
    ✔ edit (0.093233ms)
    ✔ mcp__github__get_me (0.09372ms)
  ✔ B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next (1.488309ms)
  ▶ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next
    ✔ read (0.305006ms)
    ✔ subagent (0.106539ms)
    ✔ send_message (0.110669ms)
    ✔ bash (0.219973ms)
    ✔ edit (0.181357ms)
    ✔ mcp__github__get_me (0.103756ms)
  ✔ B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next (3.038529ms)
✔ B 组：门禁不生效或评估失败时必须经 next() 放行 (10.552104ms)
✔ 契约：apply 注册 tools/pre-execute 处理器（deny 断言的前提） (5.068065ms)
▶ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next
  ✔ bash (2.872242ms)
  ✔ edit (0.412985ms)
  ✔ write (0.314519ms)
  ✔ web_search (0.278629ms)
  ✔ web_fetch (0.323407ms)
  ✔ run_code (0.237126ms)
  ✔ pwsh (0.298473ms)
  ✔ terminal_open (0.394753ms)
  ✔ terminal_send (0.42441ms)
  ✔ str_replace_editor (0.210552ms)
  ✔ create_skill (0.131464ms)
  ✔ caveman_browse (0.123674ms)
  ✔ create_worktree (0.125471ms)
  ✔ lsp (0.139496ms)
  ✔ spawn_teammate (0.141032ms)
  ✔ ask_user_question (0.13456ms)
  ✔ present (0.151244ms)
  ✔ update_goal (0.115293ms)
  ✔ mcp__github__get_me (0.137572ms)
  ✔ mcp__telegram__any (0.099853ms)
✔ deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next (12.533364ms)
▶ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法）
  ✔ args=undefined (0.461393ms)
  ✔ args="on" (0.346446ms)
  ✔ args="ON" (0.141828ms)
  ✔ args="enable" (0.323174ms)
  ✔ args="  on  " (0.2918ms)
✔ deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法） (2.855359ms)
▶ 边界组：门禁不成立时不得 deny，且 next 恰好一次
  ✔ B1 Lead 身份（role=lead，Lead 会话已开启） (1.579148ms)
  ✔ B2 teammate 但 Lead 会话 command/run args=off (0.564311ms)
  ✔ B3 非成员（tryMembership 返回 undefined） (0.594969ms)
  ✔ B4 agentTeams 服务缺失 (0.513924ms)
✔ 边界组：门禁不成立时不得 deny，且 next 恰好一次 (5.013354ms)
✔ T1 命令注册名精确为 using-agent-team (2.094559ms)
✔ T2 新 session 未 invoke → 空串 (0.622862ms)
✔ T3 invoke 后同一 session → 提醒含关键词与任务原文；裸命令仍单行 (3.047107ms)
✔ T4 args 为 off（含大小写/前导空白）→ 空串 (0.74788ms)
✔ T5 最后一条记录生效：on → off → on (0.623886ms)
✔ T6 无关命令（clear）不触发 (0.271375ms)
✔ T7 会话隔离（双向）：B 先 on 不影响 A；A on、B on→off 后 A 仍开 (0.359864ms)
✔ T8 幂等：重复 invoke 不叠加 (0.413561ms)
✔ T9 handler 返回 success 且 text 非空 (0.721051ms)
✔ T10 无伪造注入：未注册 agent/pre-step，返回值里不含消息（投递走 agent.steer/inject） (0.817099ms)
✔ T11 诊断路径：context 缺 agent/session 时 text 返回空串且不抛 (0.524876ms)
✔ T12 snapshotEvents 路径：无 .events、返回值被冻结 (0.576559ms)
✔ T13 依赖声明：apply 期间 get 的服务全部在模块 inject 数组内 (0.32097ms)
✔ T14 不可变：handler 不写 session 日志、不改写 agent (1.421458ms)
✔ T15 裸命令：data 无 args 字段与 args:"" 都必须开启 (0.368933ms)
✔ T16 handler on/off 文案语义：on 与 off 都必须成功且文案互斥 (0.616315ms)
✔ T17 handler 返回形状防漂移：恒为 { kind, text } 对象 (0.419382ms)
✔ T18 每次 invoke 都投递模型可见 notice：带 task 走 steer，其余走 inject (0.56675ms)
ℹ tests 177
ℹ suites 0
ℹ pass 177
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 235.903936
```

## 6. 独立探针（真实 apply 登记处理器，/tmp/probe-r3.mjs）

```text
{"case":"A-lead-empty-header","tool":"read","kind":"deny","nextCalled":false,"warns":[]}
{"case":"B-lead-depth0","tool":"read","kind":"deny","nextCalled":false,"warns":[]}
{"case":"C-subagent-depth1","tool":"read","kind":"allow","nextCalled":true,"warns":[]}
{"case":"D-header-throws","tool":"read","kind":"allow","nextCalled":true,"warns":["[force-subagent] Lead 门禁读取会话头 delegationDepth 失败：header exploded，门禁未生效，本次放行「read」。"]}
{"case":"E-no-header-prop","tool":"read","kind":"deny","nextCalled":false,"warns":[]}
{"case":"F-lead-write","tool":"write","kind":"allow","nextCalled":true,"warns":[]}
{"case":"G-lead-edit","tool":"edit","kind":"allow","nextCalled":true,"warns":[]}
{"case":"H-teammate-read","tool":"read","kind":"allow","nextCalled":true,"warns":[]}
{"case":"I-teammate-bash","tool":"bash","kind":"deny","nextCalled":false,"warns":[]}
SUMMARY A/B/E deny: true | C/F/G/H allow: true | D allow+warn1: true | I deny: true
```

判读：A（空 header）、B（depth=0）、E（无 header 属性）均 deny → 缺省按 0 处理，Lead 语义保持；C（depth=1）allow → subagent 不误伤；D（header getter 抛错）allow 且 warn 恰好 1 条；F/G（write/edit）allow → 未超范围；H（teammate read）allow、I（teammate bash）deny → 成员门禁行为不变。

## 7. 复现步骤

```bash
cd /home/csy/Code/Github/dsh-force-subagent
node -v            # v26.13.0
node --check index.js
node --test tests/ # 终版 exit 0，177/177 通过
```

## 8. 裁决

VERDICT: APPROVE

- 放行依据：177/177 真实通过（exit 0，独立重跑）；D3 以宿主源码纠正为 session.header.delegationDepth，L10/L10b/L10c/L10d 正反用例与独立探针佐证；成员门禁无回归；无硬编码/特判/空 catch。
- 遗留：仅 D4（INFO）。
- 轮次：第 3 轮（上限），无争议焦点，无需 Lead 仲裁。
