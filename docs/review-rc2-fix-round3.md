# RC.2 修复 · 第 3 轮（终审）对抗式审查报告

审查者：reviewer3（flat 模式，全部实跑，口头承诺一律不信）。范围：只审查，未改任何实现文件。

## 0. 测试实跑（两遍 + 专项）

| 命令 | 结果 |
|---|---|
| `node --test tests/`（第 1 遍） | tests 614 / pass 614 / fail 0 / skipped 0 / todo 0 |
| `node --test tests/`（第 2 遍，独立进程） | tests 614 / pass 614 / fail 0（duration 280ms，结果稳定） |
| `node --test tests/notice-unknown.test.js` | 3 / 3 绿（N1 未探测中性、N2 三档分文案、N3 抛错缓存） |

用例数量：`git diff --stat tests/` 显示 12 个既有测试文件被改、4 个新文件（capability-tier 8、notice-unknown 3、probe-fallback 8、save-all-workspaces 19）。逐文件 `grep -cE "^\s*(test|it)\("` 对比 HEAD：既有 22 个文件用例数 **全部持平**，新增文件 +38 → 用例总数只增不减。被删的具名用例（如 `member-finished-gate` 的「用例 1/4/5/6/7 … 被 deny」）对应的是 commit `a6329bc`「取消全部硬 deny」的语义变更，同名场景在新文案下重建为「投递提醒 + 放行」断言，不是删用例掩盖失败。

## 1. D-7 未探测时 notice 必须中性 —— **PASS**

自己搭 fake host（不复用仓库夹具）直接执行注册的 `/using-agent-team` handler：

- 命令是本会话第一个动作（`definitions` 调用次数 = 0，`warnings.length = 0`）→ 恰好 1 条 notice：
  `【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派（持续到 /using-agent-team off）。本会话已开启 Agent-Team 强制委派提示；本会话的真实工具面尚未确认，是否具备委派能力以本轮系统提示的 Agent-Team 段为准。`
  正面承诺锚点 `必须委派` = **false**；否定锚点 `未检测到委派工具|没有委派能力` = **false**；中性锚点 `尚未确认|以本轮系统提示` = **true**。
- 同一夹具先探测再执行命令：team → 正面 true / 否定 false / 中性 false；standard → 正面 true / 中性 false；none → 正面 false / 否定 true / 中性 false。
- 判据实现：`index.js:642-646`（`caps === undefined || caps.probed !== true` → 中性句；只有 `probed === true` 才按 `delegationTier` 分档）；命令侧取 `latestCaps`（`index.js:1178-1179`、`index.js:1650`），未探测时 `latestCaps === undefined`，不会凭空造 warn。

**测试不是「只断言测试自己」**：同一夹具、同一组正则，唯一变量是「命令前是否发生过探测」，锚点结果随之翻转（上面两组实测数据即反例证据）；`STANDARD_CAPABILITIES.probed === false`（`index.js:483-494`）保证探测失败也走中性支，不会伪装成已确认。

## 2. D-10 抛错支缓存 —— **PASS**

`definitions` 恒抛错（`boom-r3`）的 tools 替身，同一 `toolSet` 对象上跑 3 次 section + 1 次门禁：
`definitions` 实际调用次数 = **1**（不是 4），探测降级 warn = **1**，总 warn = **1**，无抛出、notice 文案稳定（中性句）。
换一个 `toolSet` 对象再 section 一次 → `definitions` 调用次数 = **2**（真实重探，不是全局粘住）。
判据实现：`index.js:1198`（`WeakMap` 按 toolSet 键）、抛错支 `index.js:1238-1244` 显式 `capabilitiesCache.set(toolSet, fallback)`（1243），与空结果支（1232）同构。

## 3. 回归矩阵（实跑，抽查）—— **PASS**

单 handler、单 section（`gate handlers=1 sections=1`），全程 `deny=false`、`next` 恰好一次。

| 场景 | 实测 |
|---|---|
| 未派发，同一 turn 连打 write / edit / bash / run_code / mcp__github__push_files / foobar_unknown / grep / glob / read | 只有第 1 次（write）投递 1 条 `[team-gate]` 提醒，其余 0 → 同 turn 恰好 1 条 |
| 新 turn（新 `turn/start`）各工具作为本轮第一个调用：foobar_unknown / run_code / mcp__github__push_files / edit / bash / terminal_run / write | 每个独立夹具都投递 1 条提醒，分类文案正确（未知工具→「工具「foobar_unknown」」、run_code→「执行工具」、bash→「取证工具」）→ 未知工具与 `mcp__*` 均被覆盖，无枚举漏网 |
| 派发（subagent / team_task_create / send_message）后同轮 read / grep / glob | 提醒 = 0（豁免成立） |
| 派发后同轮 write | 仍提醒 1 条：「本轮已派发成员，但你仍在亲自执行实现工具「write」——派发不等于放手」 |
| 全程 | 无任何 `{ kind: 'deny' }`；`warns: []` |

## 4. 死名 —— **PASS**

- `grep -c "spawn_teammate\|subagent_role\|close_subagent" index.js` = **0**（grep 退出码 1，即零匹配）。
- 真实调用已注册的 section（不是静态读源码），三档各一次，对输出正文做同一正则：team 档 len=770 / **deadMatches=0**；standard 档 len=757 / **0**；none 档 len=202 / **0**。

## 5. 糊弄排查 —— **PASS**

- 无 `TODO` / `FIXME` / `XXX` / `.only` / `.skip`；无空 `catch {}`（`index.js` 的 catch 全部带 warn 或降级返回；仅 3 处测试内 `} catch {`，位于 `lead-gate.test.js:180`、`member-finished-gate.test.js:186`、`member-gate-deny.test.js:120`，是「预期抛错路径」的收口，其前后仍有实质断言）。
- 无恒真断言（搜 `assert.ok(true)` / `assert.equal(true, true)` / `expect(true)` → 0 命中）。
- 未见为测试写死的特判：能力档位与文案全部由 `capabilitiesFromNames` / `delegationTier` / `fallbackCapabilities` 从探测到的名字集合推导，我用自己构造的名字集合（含 `foobar_unknown`、`terminal_run`）即可复现分类结果，非硬编码返回值。

## 6. 文档-实现一致 —— **FAIL（1 条矛盾，非运行时缺陷）**

| 条目 | 结论 |
|---|---|
| 已完成成员门禁仅在 team 档（先判 `caps.board`） | **一致**：`docs/rc2-compat.md:54-55`、`README.md:21` 与实现（门禁分支以 `caps.board` 为准，standard 档整条停用）相符 |
| 探测失败含「结果为空」 | **一致**：`index.js:1224-1234` 空清单走 `fallbackCapabilities` + warn，文档 `rc2-compat.md` 列出四种降级（含空清单） |
| `inject` 含 `tools` | **一致**：`index.js:31` `export const inject = ['commands','systemPrompt','subagents','tools']` |
| notice 按档 / 中性 | **矛盾**：`docs/rc2-compat.md:42` 明文写着「非 `none` 档（team / standard / **一条都没探测过**）→ 『…实现与测试必须委派…』」，即 D-7 修复**之前**的行为；实现（`index.js:642-643`）对「一条都没探测过 / 探测失败」给的是中性句「本会话的真实工具面尚未确认…以本轮系统提示的 Agent-Team 段为准」。`README.md:22` 也只描述 none / 非 none 两态，完全没写中性档。全文 `grep -c "中性\|未确认" README.md docs/rc2-compat.md` = **0**。 |
| 设计稿《实现偏差说明》 | **一致**：`docs/rc2-flat-mode-design.md:7` 已回填偏差说明，`:19`、`:148` 明确 team 档判据是实现里的 `caps.board`（`team_task_create`），不再声称 `spawn_teammate`；正文残留的 `spawn_teammate` 均位于原稿引用且已就地标注偏差。 |
| 注释引用真实性（D-9） | **一致**：`packages/core/agent/src/dispatch.ts:174-176` = `assembleContextFor` 返回 `{ agent, scope: agent }`；`packages/core/tools/src/index.ts:284-290` = `view(scope)` 在 `closed \|\| scope !== agent` 时返回空 Map；`packages/subagent/tool-subagent-control/src/index.ts:31` = `interrupt: z.boolean().default(true)`。三个被引用文件均存在且行号内容吻合。 |

## 7. 残余风险（上线后仍可能让 Lead 自己干活的路径）

1. **事件形状漂移 → 门禁整轮静默**（实测 D 组）：`command/run` 已开启但会话事件里找不到 `turn/start` 时，`index.js:1429-1431` fail-open：模型侧 **0 条提醒**，只有 1 条 `logger.warn`（模型看不见）。若宿主事件命名/裁剪变化，Lead 全程亲自干活而模型侧无任何提示。与文档口径一致，但可观测性只剩日志。建议：给这条 fail-open 也补一条模型可见提醒（或 section 里降级说明）。
2. **探测失败 ≠ none，但也不会「催」**：探测失败走 `fallbackCapabilities`（`probed:false`、standard 名字集），notice 中性、section 仍提 `subagent` 等稳定委派工具 —— 不会反向劝 Lead 自己干活（这是对的取舍），代价是宿主真出了委派工具时该轮文案偏保守。属可接受。
3. **`interrupt` 三态留 `undefined`**：探测失败时既不承诺也不否定 `interrupt_agent`（`index.js:478-486`），Lead 可能以为能中断已完成成员；影响面小，非委派失效路径。
4. **standard 档「已完成成员门禁」整条停用**（按 `caps.board`）：Team 开关 OFF 时向已完成成员 `send_message` 无任何提醒，纪律完全落在文案上 —— 这是文档明示的设计决定，不是缺陷，但它是「Lead 以为团队还在运转」的一条潜在路径。
5. 我的夹具里 `wait_agent` 触发了「连续两次 wait_agent 之间没有有效动作」提醒：`agentTeams.tryMembership` 返回 undefined（flat 模式无看板成员）时，`subagent` 派发不被该门禁认定为「有效动作」。真机上 subagent 走 `subagents.rootOf` 推导后是否仍误判，值得回归时补一条真实事件序列的验证。

## 8. 裁决

代码层面：D-1/D-2/D-3/D-4（第 1 轮）与 D-7/D-9/D-10（第 2 轮）七条缺陷都已 **真实修复**，可用独立夹具复现；测试两遍 614/614 绿、专项 3/3 绿、无糊弄迹象、无 deny、无死名。唯一实质缺陷是文档 `docs/rc2-compat.md:42`（+ `README.md:22`）仍描述 D-7 修复前的 notice 分档，与 `index.js:642-643` 相反 —— 属文档欠账，不影响运行时行为，**不阻塞插件交付**，但在把 compat 文档当规格发布前必须改（把「一条都没探测过」从「正面文案」移到「中性句」那一支）。

VERDICT: APPROVE
