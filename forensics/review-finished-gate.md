# T3 对抗复核：「已完成成员不再接活」门禁（task-6）

审查者：reviewer。时间：2026-11-05 22:35 +08:00。对抗轮次：1/3。

## VERDICT: APPROVE

硬门禁真实存在于 pre-execute 链路并且真的阻断工具调用；我独立构造的 32 条宿主语义忠实反例全部与预期一致；全量测试 322/322 通过且无 skip/only/todo。未发现硬编码、提示词糊弄、提前 return 短路、ownerName 误用、恒真断言或快照取错版本。

---

## 1. diff 事实（不是口头总结）

```
$ git diff --stat index.js
 index.js | 93 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 92 insertions(+), 1 deletion(-)
$ md5sum index.js
ab5e9a90842893de98db4bc018d1bea2  index.js
```

`git diff -U0 index.js` 共 4 个 hunk，无其它夹带改动：

| hunk | 内容 | 位置 |
|---|---|---|
| `@@ -218,0 +219,41 @@` | `export function finishedMembers(events)` 判定函数 | index.js:231-258 |
| `@@ -230 +271 @@` | `FLAT_LEAD_APPENDIX` 提示词改写（声明这是硬门禁 + 解法） | index.js:271 |
| `@@ -331,0 +373,4 @@` | `finishedMemberDenyReason(subject)` 文案 | index.js:374-375 |
| `@@ -511,0 +557,46 @@` | pre-execute 第四条 deny | index.js:557-602 |

`git status --short` 只有 `M index.js` 与未跟踪的 `tests/member-finished-gate.test.js`：**既有测试文件一条都没改**（无从篡改旧断言）。

判定核心（index.js:231-258）：

```js
if (typeof ownerId === 'string' && (task?.status === 'completed' || task?.status === 'deleted')) everDone.add(ownerId)   // :245
for (const task of lastTask.values()) { if (status === 'pending' || 'in_progress') openByOwner.set(ownerId, …) }          // :248-251
if (everDone.has(memberId) && !openByOwner.has(memberId)) finished.add(memberId)                                        // :255
```

deny 分支（index.js:562 / 573 / 595-597）：

```js
if (tool === 'send_message' || (tool === 'team_task_update' && (callAction === 'claim' || callAction === 'reassign'))) {
  const teamSession = membership?.root?.session ?? agent?.session
  teamEvents = readEvents(teamSession); gateEnabled = enabledIn(teamSession) === true      // 与其余三条门禁同一开关来源
  if (Array.isArray(teamEvents) && gateEnabled) { … if (memberId !== undefined && finished.has(memberId)) return { kind: 'deny', reason: finishedMemberDenyReason(subject) } }
```

---

## 2. 宿主契约核对（决定「身份比较用对字段」的依据）

宿主 checkout `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.5/`（vectr 只索引本插件仓库，此路径按规则降级 grep）：

- `TeamTaskSnapshot.ownerId?: SessionId`；快照**没有 ownerName**（`packages/experimental/agent-team/src/types.ts:75-84`）。ownerName 只在工具侧视图 `TeamTaskView`（同文件 :87-99）。⇒ 实现用 `ownerId` 正确；若用 ownerName 会永远漏拦。实测实现只用 `task.ownerId`（index.js:243/249）。
- `TeamMembership.id` 是 `TeamId(root.id)`（Lead 会话 id），**不是成员自己的 id**；成员真实 id 是 `agent.id`（`roster.ts:28-33`，`tryMembership` 返回 `{ root, id: TeamId(root.id), role, name }`，成员查找用 `members.find(c => c.id === agent.id)`；`Agent.id: SessionId` 见 `packages/core/agent/src/types.ts:17`）。⇒ 实现 claim 走 `memberId = agent?.id`（index.js:588），send_message / reassign 走 `idsByName`（team/member 事件 name→member.id，index.js:238）。我的 harness 把 `membership.id` 故意做成 Lead 会话 id：若实现误用 `membership.id`，C10（已完成成员 self-claim）必然放行——实际 DENY，证明没有踩这个坑。
- `team/task` 每次变更 append 一条快照、`revision` 递增（`task-board.ts:66/208`）；`snapshotEvents()` 返回升序全量日志（`packages/core/session/src/index.ts:725-735`）。⇒ `lastTask.set(task.id, task)` 取最后快照成立。
- `reopen` / `release` / `reassign(省略 owner)` 都经 `withoutOwner()` 剥离 ownerId 并置 pending（`task-board.ts:138-141 / 167-171 / 181 / 251-254`）；`authorizeOwner = lead || owner`（`task-board.ts:121-124`）⇒ **Lead 有权 reopen 别人已完成的任务**，这是最现实的绕过路径。
- `team/member` 事件只写 teammate（`roster.ts:260/410/458`），Lead 行只在 `roster.list()` 视图里合成 ⇒ Lead 永不会被判 finished。
- 成员名永不复用：`roster.ts:255` `TEAM_MEMBER_NAME_TAKEN`。

---

## 3. 我独立构造的反例（真实运行，非转述）

脚本：`/tmp/review-harness.mjs`、`/tmp/review-harness2.mjs`（临时，未提交）。事件形状逐字段照抄宿主（TeamMemberSnapshot / TeamTaskSnapshot / TeamMembership / command-run）。

```
$ node --check index.js && echo CHECK_OK && node /tmp/review-harness.mjs
CHECK_OK
...
=== 汇总：31/32 符合预期；不符合 1 ===
  - C22 flat 模式成员发信给已完成成员也被拦（不被 flat 提前 return 短路）: decision=allow
```

C22 是我 harness 自身写错：那条场景里 `worker-b` 一个任务都没有（按契约零任务不算 finished），放行才正确；配套的 C22b（给 worker-b 一个 completed 任务）实测 `decision=DENY`，短路问题不存在。

关键条目原文（`/tmp/harness-out.txt`）：

| 用例 | 结果 | 结论 |
|---|---|---|
| C1 Lead `send_message target=worker-a`（其任务 completed） | DENY，reason 以 `[team-gate] TEAM_MEMBER_FINISHED:` 开头 | 事故原型被真拦 |
| C2 其它成员发给已完成成员 | DENY | sender 无关 |
| C3 completed + in_progress 混合 | allow | 不误判 |
| C4 零任务成员 | allow | 新成员不会被锁死 |
| C5 只有 deleted 任务 | DENY | 契约第 4 条成立 |
| C6 `ownerId: null` / 缺失 | allow | 不误判 finished |
| C7 同 task 多快照 completed(rev2)→in_progress(rev3) | allow | 取最后快照，旧 completed 不压制新状态 |
| C8 Lead reopen 已完成任务 | allow | 契约：reopen 不拦 |
| **C9 reopen（宿主剥离 ownerId）后 Lead 再 send_message 同一成员** | **DENY** | 绕过路径被封（见 §5） |
| **C10 reopen 后该成员自己 claim** | **DENY** | task-6 验收 (d) 成立 |
| **C11 reopen 后 Lead reassign 回该成员** | **DENY** | 绕过路径被封 |
| C12 成员自行 reopen 后再接活 | DENY | 自复用被封 |
| C13 reopen 后由新成员 B claim | allow | 交接正常 |
| C14 release（同样剥离 ownerId）后自复用 | DENY | 同上 |
| C15 `/using-agent-team off` 之后 | allow | 与其余三条门禁同一开关来源，off 即不干预 |
| C16 从未执行该命令的 team 会话 | allow | 不越权干预 |
| C17 target=`lead`（Lead 名下任务全 completed） | allow | Lead 不被判 finished，成员回话不被封 |
| C18 target 不是成员 | allow | — |
| C19 target 带首尾空格 | DENY | trim 生效 |
| C20 已完成成员 `action=complete` 自己任务 | allow | 收尾不被卡死 |
| C21 已完成成员 `action=edit` | allow | — |
| C22b flat 模式已完成成员 | DENY | 不被 flat 提前 `return next()` 短路 |
| C23 nested 模式（send_message 在 ALLOWED_TOOLS 内） | DENY | 不被白名单短路 |
| C24 换成员名 / 换任务 id 同结构 | DENY | 非硬编码特判 |
| C25 deny 路径 `nextCalls === 0` | 0 | 真的阻断执行，不是只返回文案 |
| C26 事件读取抛错 | allow + 1 条 warn，不抛给调用方 | fail-open 不吞 deny 也不炸宿主 |
| C27 无 membership 的普通 subagent | allow | 不串味 |
| C28 事件里 ownerId 属于别的 session 的成员 | allow | 跨 team 不串味 |

第二轮探针（`/tmp/review-harness2.mjs`，12 条，`前缀不符数量=0`）：failed 成员（phase=failed）已完成仍被拦（无 phase 特判）；Lead 自己 claim 放行；`arguments` 缺失/为字符串不崩、放行；`team/member` 字段畸形不崩；completed+deleted 两任务 DENY；已完成成员向 Lead 回话 allow；新 pending 任务未派时对该成员仍 DENY、它自己 claim 该任务也 DENY；`team_task_list` 等非 team 工具 allow；事件顺序颠倒（completed 快照先于 member 事件）仍 DENY。

---

## 4. 测试真实性核验

```
$ node --test tests/member-finished-gate.test.js
ℹ tests 36  ℹ pass 36  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
$ node --test tests/
ℹ tests 322  ℹ pass 322  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
$ grep -rn "test\.only\|\.only(\|skip: true\|todo: true" tests/     # 无命中
```

- 断言统计：`assert.equal` 13、`assert.match` 7、`assert.ok` 4；无 `expect(true)` 型恒真断言，无 `skip/only/todo`。
- 断言打在**真实 handler 返回值**上（`gateOutcome` 取 `ctx.on('tools/pre-execute')` 注册的处理器链，tests/member-finished-gate.test.js:139-153），不是打在 mock 自身：`finishedDenials` 用前缀过滤（:163-166）、deny 侧要求 `nextCalls === 0`（:187-191）、allow 侧要求 `nextCalls === handlerCount`（:207-211）、两侧都断言 `threw === undefined`。
- 事件替身忠实宿主语义：`REOPENED = [memberEvent('m1','worker-1'), taskEvent('t1','completed',2,'m1'), taskEvent('t1','pending',3)]`（:223-227）——reopen 后**没有 ownerId**，与 `task-board.ts:167-171 withoutOwner()` 一致。这不是为了配合实现编造的形状。
- 身份形状忠实：成员 agent id `'m1'` == team/member 的 `member.id` == `task.ownerId`；`leadSender` 无成员 id 命中。
- 旧三条门禁回归用例（:421-462）断言真实 deny 与 reason 内容，未修改既有测试文件。
- 用例 11 覆盖 `/using-agent-team off` flat+nested 两种模式完全不干预。

## 5. 为什么「reopen 绕过」没有成立（我原本判定这是最可能的硬伤）

按 task-4 契约字面口径（“其名下任务全部 completed/deleted”），reopen 剥离 ownerId 后该成员名下零任务 ⇒ 应不再 finished ⇒ send_message 放行 ⇒ 事故复现。实现的判定比契约更严：`everDone`（index.js:234/245）记录**任何历史快照**中出现过的 completed/deleted owner，`openByOwner` 只看最后快照（:248-251）。因此 C9/C10/C11/C12/C14 全部 DENY，绕过被封。契约第 3 条「reopen 后由 claim 拦截」在这里是靠 `everDone` 兑现的，而不是靠 owner 状态。

## 6. 遗留注意点（不构成 REJECT）

1. `finished` 单调不可逆：成员一旦曾经 completed/deleted 过任务就永久 finished，而 claim/reassign 又被拦，它无法重新变为 open。后果：Lead 连「让原成员把刚 reopen 的同一任务继续修完」都做不到，必须 `spawn_teammate` 新名字 + 新任务。与用户诉求一致，但 Lead 侧提示词应明确这条流程（index.js:271 已写明）。
2. 策略口径副作用：Lead 无法向已完成成员发任何 `send_message`（含收尾、致谢、追问），只能用 `interrupt_agent`（实测 allow，测试用例 8）。
3. `membership?.root?.session` 缺失时回退成员自己的会话，那里没有 `command/run` 记录 ⇒ `gateEnabled === false` 静默放行（index.js:565/573）。宿主始终提供 root（`roster.ts` tryMembership），属可接受 fail-open，非缺陷。
4. 门禁只拦工具调用；roster 行仍在（宿主无删除 API），UI 上成员行不会消失——这是宿主事实，不是实现缺口。

## 7. 复现命令

```bash
cd /home/csy/Code/Github/dsh-force-subagent
node --check index.js
node --test tests/                        # 322/322
node --test tests/member-finished-gate.test.js   # 36/36
node /tmp/review-harness.mjs              # 31/32（唯一 FAIL 是 harness 自身用例 C22，见 §3）
node /tmp/review-harness2.mjs             # 12 探针，前缀不符 0
```
