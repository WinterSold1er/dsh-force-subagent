# RC.2 委派修复第 2 轮对抗复核（reviewer2b）

- 审查对象：`git diff index.js`（+413/−149，含 tests）、`docs/rc2-compat.md`、`tests/probe-fallback.test.js`。
- 依据：第 1 轮 `docs/review-rc2-fix.md` 的 D-1 / D-2 / D-3 / D-4。
- 取证：`node --test tests/` + 4 个 `node --input-type=module` 内联实验（mock ctx，未落盘）。
- 说明：本会话 vectr MCP 不可用（`vectr_status` 报 unknown tool），已按降级规则改用 grep/read。

## 0. 全量测试（实跑一次）

```
$ node --test tests/
ℹ tests 611
ℹ pass 611
ℹ fail 0
```

## 1. 四个定向实验（真实 apply + 真实注册的 section / tools-pre-execute）

夹具与 `tests/probe-fallback.test.js` / `tests/member-finished-gate.test.js` 同构：`apply(ctx)` 后取 `systemPrompt.sections[0].text({agent, scope, toolSet})` 或直接调用注册的 `tools/pre-execute` handler；工具面用 `definitions(scope, toolSet)` 替身。

### E1 空工具面（D-1）→ 通过

`definitions` 返回 `[]`（数组）与 `new Map()`（宿主 view 原始空形状），同一 toolSet 连调 section 两次：

```
E1(array): standard=true forbidden=false noneWording=false warns=1 probes=1 len=1524
E1(map):   standard=true forbidden=false noneWording=false warns=1 probes=1 len=1524
```

- 落 standard 档（出现「再在单轮内并行 subagent 拉起 / 用 list_agents 记下成员名」），**不落 none 档**；
- 零命中 `spawn_teammate|team_task_|interrupt_agent|subagent_role|close_subagent`，也零命中「没有探测到委派工具 / 没有委派能力 / 无法派发成员 / 由你直接执行」；
- 探测降级 warn 恰好 1 条；同 toolSet 只调用 `definitions` 1 次（WeakMap 缓存，`index.js:1217-1227`）。

### E2 interrupt 三态（D-2）→ 通过

```
E2: trueMentions=true len=770
E2: falseNegative=true falseMentions=false
E2: undefMentions=false undefNegates=false len=762
```

- `interrupt: true`（definitions 含 `interrupt_agent`）→ 文案点名 `interrupt_agent`；
- `interrupt: false`（team 工具在、`interrupt_agent` 不在）→ 走「本会话没有中断成员的工具」，且不点名；
- `interrupt: undefined`（tools 服务缺失 → `fallbackCapabilities`/`STANDARD_CAPABILITIES`，`index.js:483-493`）→ 不点名、不做任何否定断言（零命中「没有中断成员/不中断/无法中断」）。
- 「键缺省」这一形态由代码级判据保证：`knownTool` 仅 `=== true` 点名（`:526`），否定分支仅 `=== false` 触发（`:573-579`），缺键与 `undefined` 行为一致。

### E3 已完成成员 `send_message` 寻址（D-3）→ 通过

team 档（definitions 含 `team_task_create`）+ `team/member(m1, worker-1)` + `team/task(t1, completed, owner=m1)`：

```
E3: agentArgHit=true targetArgHit=false n1Len=279 n2Delta=0
E3 noticeHead="[team-gate] TEAM_MEMBER_FINISHED: send_message 的目标成员「worker-1」 已被判定为「已完成任务」——其名下…"
```

- `arguments:{agent:'worker-1'}` 命中 `TEAM_MEMBER_FINISHED` 提醒；
- `arguments:{target:'worker-1'}`（rc.1 旧参数）不命中，与 rc.2 `send_message` schema 一致（`index.js:1334-1337`）；
- 提醒只投递一次（第二参数形状未产生增量），且门禁只放行、无 deny。

### E4 门禁矩阵（D-4）→ 通过

每个工具单独一个 turn（dedupe key 按 turn 去重，必须分开测）：

```
E4c each-in-own-turn: subagent=0 write=1 read=0 mcp__github__push_files=1 zzz_unknown=1 bash=1 grep=0 edit=1
E4d same-turn: write=1 read=0 turn2write=1 deny=0
```

- 未派发：`write/bash/edit/push_files/未知工具` 各提醒 1 条，`subagent` 不提醒；
- 同 turn 先 `subagent` 再 `write` 仍是 1 条（**派发不换整轮免检**），`read` 0 条（取证豁免）；
- 跨 turn 再 1 条；所有调用 `next()` 均被调用、`deny=0`、handler 恰好 1 个。

## 2. 三件附加检查（各一句）

1. **无空 catch / `TODO` / 测试写死分支 / 静默吞异常**：全文件零 `TODO|FIXME|HACK`、零 `process.env.*TEST*` 分支、零空 catch；`index.js:362` 的 `void error` 是 `memberByName` 文档化的「判不了就不提醒」fail-open（有测试），其余 catch 全部经 `warnFailOpen` / `noteToolProbeFallback` 至少 warn 一次。
2. **`git diff tests/` 无删用例/恒真断言**：删 25 条 / 增 26 条，删除项均为旧语义用例（deny→提醒、`target`→`agent`、「已派发→免检」→「派发不等于放手」）的等价重写，新增项一一覆盖；全库 `assert.ok(true)` 零命中。
3. **`docs/rc2-compat.md` 仍有 2 条硬矛盾（文档滞后，非实现缺陷）**：第 110 行称「standard 档仍运行已完成成员门禁」，实测 standard 档 `finishedReminder=false`、team 档 `=true`（实现按 `caps.board` 仅在 team 档启用，`index.js:1312`，与设计 §3.5 及代码注释一致）；第 39 行称「命令 notice 统一文案」，实测 `buildNotice` 经 `leadClause(caps)` 按 none/非 none 分档（`index.js:638-643,662-669`）。另 `:39` 一批 `file:line` 引用已相对实现漂移（`fallbackCapabilities` 现为 `:1179`、`noteToolProbeFallback` 现为 `:1162`、`STANDARD_CAPABILITIES` 现为 `:483`）。

## 3. 结论

第 1 轮的 D-1（空工具面静默落 none）、D-2（能力假阴性）、D-3（rc.2 `send_message({agent})` 寻址失配）、D-4（命令 notice 不分档）在实现层均已真实修复：四个定向实验全绿、全量 611/611、无硬编码/吞异常/空测试。剩余问题仅为 `docs/rc2-compat.md` 的文档滞后（P2，不改代码、单独文档提交即可）。

VERDICT: APPROVE
