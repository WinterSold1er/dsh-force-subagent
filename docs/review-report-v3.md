# 对抗审查报告 v3（task-11：消息级注入）

**结论（第 3 轮，最终）：`VERDICT: REJECT`** —— 文档已修，但测试文件在复审期间被改写为 16 tests（15 pass + 1 todo），**唯一的 `startsRequestSeries` 回归门禁被标记 todo 而失效**；M2 变异在当前套件下全绿。详见第 8 节。

审查对象：`index.js` sha256 `45e3d894…b77b9d0`、`tests/force-subagent.test.js` sha256 `79881562…d512cb58`、README.md / docs/install.md / docs/agent-team-api.md、docs/verification-log.md §10。

## 1. 独立复跑

```
$ node --test tests/
exit=0；ℹ tests 15 / pass 15 / fail 0 / cancelled 0 / skipped 0 / todo 0
```

实现确为消息级：`index.js:38-54` 只注册一个 `agent/pre-step` waterfall；全文件无 `systemPrompt`/`section`/`order`/`getSectionOrder`/`agent/created` 残留（`grep -n "section\|order\|getSectionOrder" index.js` 无命中）。

## 2. 逐项核验（对照任务清单）

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | 消息层追加、位置在 runtime-context 之后 | **成立**。harness 默认决策为 `messages: [...claimed, context]`（`agent-loop/src/agent.ts:279-282`，context=runtime context），插件在 `decision.messages` 末尾续接（index.js:49-52）；测试 `runtime-context 消息保持原位置，提醒始终追加在最后` 锁定 |
| 2 | 五道门禁 | **齐**：非 enter → 原样（index.js:40）；`payload.messages.length === 0` → 原样（:41）；非成员 `tryMembership ?? {}`（:42）；未知角色 `renderNudge===''`（:43-44）；`next()` reject 原样返回（:40，且 `await next()` 不包裹 try/catch，错误对象原样上抛）。测试 tests:112-173 逐条覆盖 |
| 3 | 保留 decision 字段、不凭空造字段 | **成立**。`{...decision, messages: [...]}`（index.js:47-53）；测试 tests:63-90 断 `startsRequestSeries` 保留，tests:192 断 next 未带该字段时输出不得新增键 |
| 4 | 幂等 | **结构成立**。harness 每 step 仅 emit 一次 `agent/pre-step`（`agent-loop/src/agent.ts:274-275`）；空批（工具步）被 :41 拦掉。测试 tests:205-235 断两批各一条、原文引用不变、UUID 不同 |
| 5 | 测试真实性 | **有牙**，见第 3 节 |
| 6 | 文档与实现一致、无 section 残留说法 | **不成立**，见第 4 节 B1/B2 |
| 7 | 静态：无吞错/硬编码/静默降级 | **成立**。无 try/catch；角色仅经 `Object.hasOwn(NUDGES, role)` 白名单（index.js:26）；无非团队回落；无 TODO/魔法常量 |

## 3. 变异测试（/tmp 副本，仓库 sha256 前后未变）

| 变异 | 结果 |
| --- | --- |
| M1：删除 `if (payload.messages.length === 0) return decision` | exit 1，pass 14 / **fail 1**：`空消息批次不追加，且不查询 roster` |
| M2：`...decision` 改为 `kind: 'enter'` | exit 1，pass 14 / **fail 1**：`lead：enter 决策末尾追加 lead 提醒，且保留 startsRequestSeries 与原文引用/顺序` |
| M3：提醒插到 `decision.messages` 之前 | exit 1，pass 10 / **fail 5**（含 `runtime-context 消息保持原位置…`） |

结论：五道门禁、字段保留、落位均有可失败断言，非恒真。

## 4. 阻断缺陷

**B1（阻断）`docs/agent-team-api.md:19` 仍展示旧反模式 `{ kind: 'enter', messages: […] }`。**
该段（:9「`index.js` 现在只在 apply 里注册一个 waterfall 监听」）声称描述当前实现，但代码与 `index.js:47-53` 不一致，且正是 `docs/verification-log.md:179-181` 记录并已修复的「丢弃 startsRequestSeries」缺陷（本轮 M2 变异证明该写法会挂测试）。
复现：`sed -n '17,19p' docs/agent-team-api.md`。
期望：`return { ...decision, messages: [...decision.messages, {...}] }`，并在「五条不变量」中补一条「必须展开 decision，不得硬编码 kind」。
实际：文档示例硬编码 `kind: 'enter'`，与实现相反。

**B2（阻断）`docs/agent-team-api.md:39`、`:263` 仍写 `export const inject = ['agentTeams', 'systemPrompt']`。**
当前实现 `index.js:14` 为 `inject = ['agentTeams']`；README.md:19 已写对。文档与实现不一致，会误导实现者把 `systemPrompt` 重新注入。
复现：`grep -n "inject = \[" docs/agent-team-api.md README.md index.js`。
期望：两处改为 `['agentTeams']`（或标注「旧方案 inject 含 systemPrompt，已废弃」）。
实际：TL;DR 与 §门禁段均错误保留 `systemPrompt`。

## 5. 非阻断观察（不构成本轮阻断）

- 同一 payload 连续调用两次处理器会各追加一条（实测 `r1.messages.length=2, r2.messages.length=2`）。harness 每 step 只 emit 一次（`agent.ts:274-275`），正常流程不会发生；当前「天然幂等」由 harness 契约保证，非插件防御。建议补一条注释说明该前提即可。
- `payload.messages` 非数组时直接 `TypeError`（实测 `Cannot read properties of undefined`）。harness 类型为必填 `UserMessage[]`（`runtime-types.ts:320`），属契约违反，fail-loud 可接受。
- 注入消息 `source.kind='user'`，语义上会被会话记录为用户消息；属设计选择，文档已写明。
- `docs/verification-log.md §10` 自身记录准确（含旧实现 `23f1af47…` 的丢字段教训），与本次变异结果一致。

## 6. 结论

**`VERDICT: REJECT`**。代码、门禁、落位、字段保留、测试均有实证支撑；阻断项仅为 `docs/agent-team-api.md` 两处旧口径（示例代码与 inject 列表）。修这两处后可复审放行，无需再动实现与测试。

## 7. 第 2 轮复验（最终）

仅复验文档，未再扩大范围。`docs/agent-team-api.md` sha256 `77ee0737…a1be79bf`；`index.js`/测试文件 sha256 未变（`45e3d894…` / `79881562…`）。

| 项 | 复验结果 |
| --- | --- |
| B1 `:19` 示例 | 已改为 `return { ...decision, messages: [...decision.messages, {...}] }`，与 `index.js:47-53` 一致 |
| 新增不变量 | `:23` 已改「六条」；`:30` 第 6 条明确「必须展开 decision、保留 startsRequestSeries、只替换 messages」并引用 `agent.ts:415/442` |
| B2 inject | `:40`、`:264` 均为 `export const inject = ['agentTeams']`，与 `index.js:14`、README.md:19 一致 |
| 严格旧口径残留 | `grep -n "inject = \['agentTeams', 'systemPrompt'\]"` → NONE；`grep -n "kind: 'enter', messages"` → NONE |
| 新增历史标注 | `:39`「（历史方案）」、`:209`「（历史结论，已被当前实现推翻）」与当前口径不矛盾；`:209` 明确指向 `agent/pre-step`，无新矛盾 |
| 复跑 | `node --test tests/` exit 0，tests 15 / pass 15 / fail 0 |

结论：**`VERDICT: APPROVE`**（第 2 轮）。实现、测试、文档三者一致；第 1 轮非阻断观察（同 payload 重复调用会追加两次、payload.messages 契约外输入抛 TypeError）仍为已知遗留，不阻断交付。

## 8. 第 3 轮复验：测试被改写，回归门禁失效 → REJECT

### 8.1 事实

复审期间测试文件被并发改写（仓库 0 commit，无 git 基线）：

| 时间/状态 | tests sha256 | 用例 |
| --- | --- | --- |
| 第 1 轮基线（17:20） | `79881562…` | 15 tests，15 pass |
| 第 2 轮复验（我实测） | `79881562…` | 15 tests，15 pass |
| 当前（mtime 17:46:02） | `fe4fdf2125e7…b959252a` | **16 tests，15 pass + 1 todo** |

`index.js` 全程未变（`45e3d894…`）。

### 8.2 阻断缺陷 B3：唯一回归门禁用例被 todo 禁用

`tests/force-subagent.test.js:251-252`：

```js
test('enter 决策须保留 startsRequestSeries 等非 messages 字段（旧实现丢弃，防回归）', {
  todo: 'BUG（旧版）：…此用例保持 todo 作为回归门禁，修复确认后转普通用例。',
}, async () => { … assert.equal(result.startsRequestSeries, true) … })
```

该用例是套件中**唯一**断言 `startsRequestSeries` 被保留的用例；`todo` 态不计入失败统计。

复现：

```
$ node --test tests/
exit=0；ℹ tests 16 / pass 15 / fail 0 / todo 1

# 在 /tmp 副本把 index.js:48 `...decision` 改为 `kind: 'enter'`
$ node --test tests/
exit=0；ℹ tests 16 / pass 15 / fail 0 / todo 1      ← 丢字段缺陷未被捕获
```

期望：字段丢失应导致测试失败；实际：全绿。
反证（/tmp 副本去掉 `todo` 选项后）：
- 正常实现 → exit 0，16/16；
- M2 变异 → exit 1，fail 1，正是该用例。
→ 断言本身有效，**只是被禁用**。这与 `docs/verification-log.md:179-181` 记录「该字段丢失会改变 series 起点」直接冲突。

### 8.3 阻断缺陷 B4：验证日志与当前套件不一致

`docs/verification-log.md §10` 仍记「15 个 test」；当前实际 16 个（15 pass + 1 todo）。日志未更新，无法证明当前状态被验证过。

### 8.4 修复要求（单点，代码无需动）

1. 删除 `tests:251-252` 的 `{ todo: … }` 选项，使其成为普通用例；验收：`node --test tests/` → 16/16、exit 0，且把 `...decision` 改为 `kind:'enter'` 时该用例 fail。
2. 更新 `docs/verification-log.md §10`：test 数 16、全绿、附上 M2 失败证据。
3. 建议（非阻断）：为仓库建立首个 git commit 基线，避免测试套件在无记录情况下被改写（本轮已发生两次哈希漂移）。

### 8.5 结论

**`VERDICT: REJECT`**。文档 B1/B2 已修；阻断为测试门禁被 todo 禁用 + 日志口径过期。修复仅动测试与日志，改后复审 1 分钟即可放行。

## 9. Lead 仲裁与交付状态

### 9.1 B3/B4 已关闭（reviewer 实测复核）

verifier 已移除 `tests:251` 的 `todo` 选项，用例转为普通断言。实测：

```
$ grep -n "todo" tests/force-subagent.test.js
NONE

$ node --test tests/
exit=0；ℹ tests 16 / pass 16 / fail 0 / todo 0
```

M2 变异复核（/tmp 副本，`index.js:48` `...decision` → `kind: 'enter'`）：

```
$ node --test tests/
exit=1；ℹ tests 16 / pass 15 / fail 1
✖ enter 决策须保留 startsRequestSeries 等非 messages 字段（旧实现丢弃，防回归）
```

→ 回归门禁已生效，丢字段缺陷会被捕获。

`docs/verification-log.md §10` 已重组为 10.1-10.6（含 `10.4 已知缺陷与回归用例（todo 已移除）`），旧重复节删除，与当前 16 用例一致。

### 9.2 仲裁结论

- 第 3 轮为对抗上限（3/3），停止对抗。
- Lead 裁决：接受上述修复，验收交付。
- 顶部 `VERDICT` 与第 8 节的 REJECT 作为历史记录保留，不改写。

### 9.3 最终交付状态

| 项 | 值 |
| --- | --- |
| `index.js` | sha256 `45e3d894…b77b9d0`（全程未变） |
| `tests/force-subagent.test.js` | sha256 `cc860a68…f07664ab`，16 tests / 16 pass / 0 todo |
| `docs/verification-log.md` | sha256 `60153a97…e08f5b73f`，§10 与当前套件一致 |
| M2 变异 | exit 1，fail 1（`enter 决策须保留 startsRequestSeries…`） |
| 文档 | README / agent-team-api 与实现一致；**install.md:127 仍有陈旧 inject 期望，见第 10 节** |
| 已知遗留（不阻断） | 同 payload 重复调用会追加两次（harness 每 step 仅 emit 一次）；`payload.messages` 契约外输入抛 TypeError；仓库仍无首个 commit 基线 |

## 10. 交付后新发现：install.md:127 陈旧 inject 期望（待 Lead 裁决）

静态审查 subagent 在仲裁后返回，reviewer 已独立复核确认。

### 10.1 缺陷

`docs/install.md:124-127` 的安装验证步骤：

```
$ node --input-type=module -e "import('…/index.js').then(m=>console.log(m.inject))"
期望：`[ 'agents', 'agentTeams', 'systemPrompt' ]`
```

实际导出（`index.js:14`）：`export const inject = ['agentTeams']`；测试 `tests/force-subagent.test.js:69` 也断言 `['agentTeams']`。

复现：

```
$ node --input-type=module -e "import('./index.js').then(m=>console.log(m.inject))"
[ 'agentTeams' ]
```

期望（按文档校验）：打印 `[ 'agents', 'agentTeams', 'systemPrompt' ]`；实际打印 `[ 'agentTeams' ]` → **照文档执行会误判安装失败**。该期望是 section 时代残留（旧实现 inject 含 `agents`/`systemPrompt`），本轮实现与 README:19、agent-team-api.md:40/:264 均已改为 `['agentTeams']`，仅此一处漏改。

### 10.2 修复

`docs/install.md:127` 改为：期望：`[ 'agentTeams' ]`（可加注「打印 `[ 'agentTeams' ]` 即正确；含 `agents`/`systemPrompt` 说明是旧版插件」）。

### 10.3 状态

- 不改写顶部 `VERDICT` 与第 8/9 节历史记录。
- 该缺陷属文档单行错误，不影响代码与测试（16/16、M2 变异 fail 1 结论不变）。
- 建议 Lead 交付前并入同一批文档修正（与第 9 节交付状态并列）；round 上限已到，不再开启对抗轮次，由 Lead 裁决是否要求 implementer 补这一行。
