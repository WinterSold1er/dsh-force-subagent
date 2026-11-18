# T3 对抗复核：裁决「成员完成后被复用」的真实成因

复核人：verifier。方法：不采信两份输入报告的结论，独立回到原始会话 journal 与宿主/插件源码重建证据。所有「我测得」的时间戳来自我自己解压并 jq 解析的目标 journal，所有源码行号来自我自己 `sed`/`read` 的逐行核对。

- 目标会话：`/home/csy/.dsh/sessions/--home-csy-Work-twoplus--/session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef`，我解压 `session.v4.jsonl.zstd` → 438 条记录（lead journal）。成员侧日志我直接读 `/tmp/t1-cli.jsonl`、`/tmp/t1-docx.jsonl`（与 T1 同一批原始件）。
- 宿主源码根：`/home/csy/Code/installer/deepseek-harness-0.2.1-rc.5/`（不在 vectr 索引内，我降级用 `sed`/`read`/`grep`，已注明）。

## 1. 抽查表（断言 → 核对结果 → 我的独立证据）

| # | 来源断言 | 核对结果 | 我的独立证据（路径 + 行/键 + 片段/实测值） |
|---|---|---|---|
| 1 | T1 §1：成员只有 3 个，`team/member` 事件 = 6 = 3×2，无第三条/无删除/重建 | **SUPPORTED** | lead journal `grep -c '"type":"team/member"'`=6；jq 解析：cli-dev(713f62c8) provisioning→active、docx-editor(94036895) provisioning→active、board-runner(2481f483) provisioning→active；无 failed、无第三条 |
| 2 | T2：spawn 同名不复用旧成员，而是报错 | **SUPPORTED** | `roster.ts:254-255` `if (state.members.some(m=>m.name===name)) throw TeamError('teammate name "…" was already used in this Team','TEAM_MEMBER_NAME_TAKEN')`；另 `projection.ts:241-246` `replaceAt` 只有 push/覆盖两分支，无删除分支 |
| 3 | T2：`roster.ts:42-53` 寻址只看 `phase==='active'` | **SUPPORTED** | `roster.ts:48-52` `const member = state.members.find(…); if (member===undefined || member.phase!=='active') throw … 'TEAM_MEMBER_NOT_FOUND'`（`lead` 走 `root.id` 特例，第47行） |
| 4 | T2：`complete` 不清 owner；`reopen` 清 owner | **SUPPORTED** | `task-board.ts:162-166` `case 'complete': … next={…status:'completed'}`（无 `withoutOwner`）；`task-board.ts:167-170` `case 'reopen': … next=this.withoutOwner({…status:'pending'})`；`task-board.ts:136` `claim` 才 `ownerId=caller.id` |
| 5 | T2：`interrupt` 不是删除，不清 inbox、不动 phase | **SUPPORTED** | `roster.ts:187-198` 仅 `ctx.subagents.interrupt(target.id,…)`；`roster.ts:194` `if (live===undefined) return {previousStatus:'inactive'}`（成员不在 `state.members` 上做任何删除） |
| 6 | T2：`list_agents` 的 `inactive` 只表示无 turn 在跑 | **SUPPORTED** | `tool-agent-team/src/index.ts:241` “…inactive means no turn is executing, not a task result…”；`roster.ts:475-477` `availability(agent)=agent?.status==='running'?'running':'inactive'` |
| 7 | T2：send 走 `steerHostSubagentPrompt`，不新建成员 | **SUPPORTED** | `agent-team/src/index.ts:239-247` `else { messageId = await steerHostSubagentPrompt(ctx.subagents, root, target.id, …) }` |
| 8 | T2：coldResume 只在有入站投递时触发，非自动 re-dispatch | **SUPPORTED** | `manager.ts:1250-1256` `deliverFollowup` 内 `const activation=this.resident.get(childId); if (activation===undefined) return this.coldResume(parent, childId, content, options)`；`coldResume` 签名 `manager.ts:1329-1333` 需要 `content` |
| 9 | T1 §5 / Lead #1：B 类（resume/fork/restart 重建 roster）无证据 | **SUPPORTED** | 我对 lead journal `grep -oE '"type":"[^"]*(resume\|fork)[^"]*"'` = 0 命中；无 `resumeFrom/forkedFrom/parentSession` 等字段；每个成员 journal 仅 1 条 `session` 头；resume/fork 串只出现在提示词文本里 |
| 10 | Lead #3：cli-dev 的 task-1 completed 后被 reopen+reclaim+complete | **SUPPORTED** | lead journal `team/task`（jq，`.data.task.*`）：task-1 rev3 completed@1793883708532 → rev4 pending@1793883796482（`team_task_update action":"reopen"`@1793883796482）→ rev5 pending(edit) → rev6 in_progress@1793884063921（cli-dev 自己 reclaim，不在 lead 的 update 里）→ rev7 completed@1793884081976 |
| 11 | Lead #3：docx-editor 的 task-2 从未 completed | **SUPPORTED** | lead journal：task-2 rev1 pending → rev2 in_progress → rev3 in_progress，无 completed；docx-editor `turn/start` 第6个 1793885645516 无对应 `turn/end` |
| 12 | T1 §3：Lead 看到 `inactive` 后 send 唤醒同一成员（A 类） | **SUPPORTED（因果），但「≤20 ms」为 IMPRECISE** | 见 §2 反证 C；docx-editor turn/end 1793882096009 → 空闲；Lead `list_agents` tool/result `status":"inactive"`@1793882257381 → `send_message` tool/call@1793882257401 → docx `turn/start`@1793882257604（实测 +203 ms） |
| 13 | T1 §4：已 interrupt 的完成成员仍在 roster | **SUPPORTED** | lead journal `interrupt_agent` tool-call `arg {"target":"cli-dev"}`@1793884154126（在 cli-dev `turn/end`1793884124927 之后）；member 记录仍在（无删除 API，见 #2/#5） |

统计：抽查 13 条断言，12 条 SUPPORTED，1 条为「因果成立但数字 IMPRECISE」（#12 的 ≤20 ms）。未发现硬伤级 UNSUPPORTED。

## 2. 反证清单（我主动证伪）

**反证 A — 「宿主自动复用同一成员」？** 证伪。三条独立证据同时成立：
1. spawn 同名直接 `TEAM_MEMBER_NAME_TAKEN` 报错，不会复用（#2）。
2. 会话 journal 内 `resume/fork/recover/restart` 作为事件类型 = 0 命中；`team/member` 只有 6 条 = 3×2，没有任何成员的第三条 member 事件或删除/重建事件（#1/#9）。
3. 宿主唯二的自动钩子只做「结算 provisioning」和「唤醒 wait_agent 等待者」，不重新派活：`roster.ts:175-178` `recoverFor` 仅 `reconcileProvisioning`；`agent-team/src/index.ts:94-97` `ctx.on('agent/status')` 仅 `activity.notify`；`activity.ts:72-76` `notify` 只 resolve waiters。派新活必须某 Agent 显式 `send_message`/`spawn_teammate`。
→ **B 不成立**（作为「自动复用/自动重派」）。B 仅剩「roster 行 append-only，重启后原样回来」这一结构事实，它保留成员身份但不产生新 turn。

**反证 B — 「其实只是成员自己的 turn 续跑，不是 send 触发」？** 部分成立，但不足以解释「完成后再被派活」：
- cli-dev 全程只有 **1 个** turn：`turn/start` 1793881716948 → `turn/end` 1793884124927（同一 turn 内含 174 step、18 条入站 user/message 的 mid-turn inbox splice）。所以 cli-dev 在完成 task-1 后 **从未 idle/被踢**，其「复用」是同一 turn 内被 Lead 持续投递 + Lead `reopen` 了已 completed 的 task-1，而非「宿主把 idle 成员唤醒」。即使取「成员一直在跑」这个最简解释，新活（reopen+裁决）仍是 Lead 主动给的。
- docx-editor 相反：`turn/start`×6、`turn/end`×5，第5个 turn 前空闲约 15 分钟（1793882833622→1793883741351），只在 1793883741020（cli-dev 转发）到达后 +331 ms 才起 turn。这是「从 inactive 被唤醒」的干净证据，不是 self-continuation。
→ 无论哪种，触发都指向 A（显式 send/reopen），没有一个 turn 是被宿主 wake 事件凭空复活的（宿主无该事件）。

**反证 C — T1 的「≤20 ms 对齐」是否成立？** 不成立（数字被高估约 10–25×）。我实测：
- docx-editor：Lead send→其 `turn/start` = 203 / 363 / 519 / 271 ms（turn2/3/4/6）；turn5 由 cli-dev 转发触发 = 331 ms。
- cli-dev：Lead send tool/call → cli-dev `agent/inbox/spliced` = 534 ms；→ 该 turn 内首个 step 起跳 ~9–42 s。
- T1 §3 line 77 的「20 ms」实际是 Lead 自己 `list_agents` tool/result(1793882257381) → `send_message` tool/call(1793882257401) 的 Lead 内部决策间隔（确为 20 ms），但它测的是「Lead 看到 inactive 到决定 send」，不是「send 到成员起 turn」。T1 把两个不同的 20 ms 混用了。
→ 因果方向（send/reopen → 成员起新 turn）成立；「≤20 ms」这一具体精度 **UNSUPPORTED**。

**反证 D — 用户看到的「复用」是否只是 roster 视觉残留（C）？** 机制上成立（append-only roster、无删除 API、interrupt 不清行、`inactive` 仍被 `list_agents` 列出：#2/#5/#6），即完成+interrupt 的成员永远可点名。但「把它误读为复用」这一步在本会话 journal 内无对应证据——它来自用户措辞，T1 line 123 也承认「用户原话不在该会话 journal 内」。故 C 是**结构性事实**，「误读」本身属推断。

## 3. 完成情况审计（Lead #3）

我对 lead journal `team/task`（16 条）全量 jq 解析，结论：**全会话只有 task-1 到达过 `completed`**（且到两次）。
- task-1（cli-dev）：pending→in_progress→**completed**(rev3)→reopen→edit→in_progress(claim, rev6)→**completed**(rev7)。
- task-2（docx-editor）：pending→in_progress→in_progress，**从未 completed**。
- task-3：rev1..4 全程 pending，从未 claim。
- task-4（board-runner）：pending→in_progress，快照时未 completed。
→ 除 cli-dev 的 task-1 外，**没有任何成员完成过任务**。对 docx-editor 谈不上「完成后复用」——它是在 `in_progress` 状态下被反复 `send_message` 追加 turn（4 个额外 turn：Lead×3 + cli-dev 转发×1）。board-runner 同理（in_progress）。

## 4. 最终裁决（≤15 行）

1. 被证据支持的是 **A 为主 + C 为结构性成因**；**B（宿主自动复用/重建 roster 后自动重派）被证伪**。
2. 「复用」的实际机制 = Lead（或同事）显式 `send_message`（经 `steerHostSubagentPrompt`→coldResume 唤醒 inactive 成员）+ Lead `team_task_update reopen` 把已 completed 的任务重开并再派给同名成员。全程无宿主自动重派。
3. cli-dev 的「完成后被复用」真实且可回溯：task-1 completed→reopen→claim→completed；但 cli-dev 全程单 turn、未 idle，所以它不是「宿主唤醒 idle 成员」，而是「同 turn 内被 reopen + 续派」。
4. docx-editor 被反复唤醒是真（6 turn，含从 inactive 唤醒），但它 task-2 从未 completed，用「完成后复用」描述它不准确。
5. 用户表述需要修正：**「完成后复用」严格只适用于 cli-dev 的 task-1**；对 docx-editor/board-runner 应为「同一 in_progress 成员被反复 send_message 追加 turn」。
6. C（roster 行残留 + 无删除 API + interrupt 不清行）解释了「成员为什么看起来还在、还能被点名」，为 strong。
7. 本仓库 force-subagent 的「完成即 interrupt 且永不再 send_message」只是 `index.js:230` `FLAT_LEAD_APPENDIX` 提示词文本；插件的 pre-execute 门禁只封成员的 subagent 系工具，**没有对 send_message 的 deny 分支**，所以「不得复用」无强制力——目标会话里 Lead 确实 reopen+续派，与该文本相悖。此为可核对事实（#2 反证）而非 SPECULATION。
8. 证据强度：A strong；C strong；B none/rejected；「≤20 ms」weak（数字错误，方向正确）。

## 5. 缺失的关键证据清单

1. 用户原始观察对象不在会话 journal 内（T1 line 123 已承认）：无法从数据确认用户所说的「复用」具体指哪个成员/哪一次，只能确认会话里实际发生的唤醒/ reopen 事件。
2. 宿主进程连续性我未独立复核 T1 的 PID `lstart` 断言（T1 line 112：PID 4112586，20:13:59 启动，覆盖整个会话窗口未重启）；我用的是「journal 内无 resume/fork/restart 事件 + 无成员重建事件」这条更硬的证据，未再独立 `ps` 核对该 PID 启动时刻。若需闭合 B 的「进程重启」这一支，应补 `ps -eo lstart` 与宿主日志。
3. cli-dev 的 task-1 reclaim（rev6 in_progress）发生在其自身 session（lead journal 无对应 `claim` update），我未打开 cli-dev journal 逐行取该 `claim` 记录的行号——若要坐实「原 owner 自己 reclaim」可回 `/tmp/t1-cli.jsonl` 补 `team_task_update action":"claim"` 的行。
4. 没有「wake 事件」本身：这是**预期的缺失**（宿主不产生自动 wake），其缺失正支持「非自动复用」，而非报告漏洞。

## 6. 需要向用户更正的措辞

- 更正 1：不是「宿主把完成的成员自动复用」。宿主无自动复用；同名 spawn 会直接报错。
- 更正 2：「完成后仍被复用」只对 **cli-dev / task-1** 成立，且其本质是 **Lead `reopen` 已 completed 的 task + 同一 turn 内续派**，cli-dev 并未被踢出后「复活」。
- 更正 3：docx-editor 从未完成过任务，应说「被反复 `send_message` 追加 turn」，不是「完成后复用」。
- 更正 4：成员「还在 roster / 还能点名」= append-only 无删除 API 的正常现象（C），不等于被复用。
- 更正 5：T1「误差 ≤20 ms」应改为「Lead send → 成员起 turn 实测约 0.2–0.5 s」；那个 20 ms 是 Lead 内部 list_agents→send 的间隔。
