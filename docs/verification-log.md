# 验证日志：nudge 注入回归（task-3）

- 日期：2026-10-30（Asia/Shanghai）
- 仓库：`/home/csy/Code/Github/dsh-force-subagent`
- 运行时：`node v26.9.0`（零依赖 ESM，`node --test`）
- 被测实现：`index.js`，sha256 `31060040f861c8a92f41157a4662ee61c8d9ebd8639f77dbc8aec17c2da677be`（第 2 轮修订后验证；首轮为 `9caff298…aa55ddf`，12:26 仅注释/JSDoc 说明隐式 lead 更新，本任务未修改 `index.js`）
- 本次仅写：`tests/force-subagent.test.js`、`docs/verification-log.md`

## 结论

| 阶段 | 命令 | 退出码 | tests | pass | fail |
| --- | --- | --- | --- | --- | --- |
| 修复前基线（旧测试断言 601） | `node --test tests/` | 1 | 8 | 7 | 1 |
| 合并后完整套件 | `node --test tests/` | 0 | 19 | 19 | 0 |
| 独立复跑（subagent C2，另一上下文） | `node --test tests/` | 0 | 19 | 19 | 0 |

修复前唯一失败即旧断言写死 `order === 601` / 锚点 `TEAM_POLICY`，与实现改为 `DEPLOYMENT_PERSONA_SUFFIX + 1 = 10201` 冲突——说明新断言能捕获「nudge 被埋在提示词 33% 处」的旧行为。

## 1. 修复前基线（2026-10-30 11:14）

命令：`node --test tests/`，退出码 **1**，`tests 8 / pass 7 / fail 1`。

```text
✖ failing tests:

test at tests/force-subagent.test.js:100:1
✖ apply 为已存在 agent 注册唯一 section：名称固定、order 紧随 TEAM_POLICY (2.82844ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      {
        agentId: 'agent-a',
  +     name: 'DEPLOYMENT_PERSONA_SUFFIX'
  -     name: 'TEAM_POLICY'
      }
    ]
```

## 2. 合并后完整运行输出（2026-10-30 11:31）

> 第 2 轮修订（task-3 reopen）：tryMembership mock 对齐真实 roster 语义（live root 隐式 lead，生产可达），删除生产不可达的「非团队 root」正向用例，修正 1 处恒真断言与 2 处全文文案耦合断言。

命令：`node --test tests/`，退出码 **0**，`tests 19 / pass 19 / fail 0`。

```text
✔ renderNudge 对 lead 文案含 team_task_create / spawn_teammate / wait_agent 三条硬指令 (2.058684ms)
✔ renderNudge 对 teammate 文案含「编排者」与 subagent，且与 lead 文案不同 (0.368231ms)
✔ renderNudge 对未知/伪装/原型污染等非团队角色一律返回严格空串 (0.434286ms)
✔ resolveNudge 对 roster 成员返回 role + 对应文案 + team-member，成员分支优先于 agent 形态 (1.475269ms)
✔ resolveNudge 对已注册但角色非法的 membership 返回 unknown-team-role 且不注入文案 (0.350052ms)
✔ resolveNudge 对 membership 缺失 + 根 agent（无 parentSession）返回 not-in-team (0.410067ms)
✔ resolveNudge 对 membership 缺失 + 带 parentSession 的二级子代理注入 teammate 文案 (0.265183ms)
✔ resolveNudge 优先级边界：非法角色 + parentSession 仍落 unknown-team-role，不回落注入 (0.260512ms)
✔ inject 严格声明 [agents, agentTeams, systemPrompt] (0.254495ms)
✔ apply 回放已有 agent：两名各一节、名称与 order 固定、仅一个 effect (1.051461ms)
✔ 根因回归·位置：order 落在 DEPLOYMENT_PERSONA_SUFFIX 之后，不再是 TEAM_POLICY+1 (0.314246ms)
✔ 负例·锚点缺失：orderOf 返回 undefined / NaN 时显式抛错且不注册半成品 (0.870679ms)
✔ agent/created：晚到 agent 安装一次，重复 created 幂等，不同 agent 各自独立 (0.352012ms)
✔ text 每轮重算不缓存：lead → teammate → 未知角色 → undefined → lead，membership 恰查 5 次 (0.405646ms)
✔ subagent child：roster 无 membership 时回落 teammate，membership 角色优先于 parentSession (0.312355ms)
✔ 隐式 lead（生产可达）：live root、无 parentSession、无 subagentDescriptor → roster 等价返回 {role:"lead"} (0.286448ms)
✔ 生命周期：disposed 精准释放、重复与未知 id 安全、effect 卸载与再注册互不污染 (0.526696ms)
✔ 重复 apply：卸载后再 apply 不抛错，旧 section 已释放、新 section 独立 (0.459685ms)
✔ 根因回归·晚加载：apply 前已存在的 agent 拿到 lead 文案，角色变化后不缓存 (0.322118ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 143.561485
EXIT=0
```

## 3. 独立复跑（subagent C2，2026-10-30 11:33）

由另一上下文的验证 subagent 独立执行同一命令，原始输出留存 `/tmp/c2-final.log`：

```text
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 132.05142
EXIT=0
```

## 4. 断言有效性证据（变异测试）

子任务 B 在 `/tmp` 副本上对 `index.js` 做变异，仓库实现未动：

| 变异 | 预期/实际 |
| --- | --- |
| M1：`ORDER_ANCHOR` 改回 `TEAM_POLICY` | fail 6（实测：6/19 用例失败，含 order 601≠10201） |
| M2：删除 `sectionOrder` 的 `Number.isFinite` 显式抛错守卫 | fail 1（锚点缺失负例命中） |
| M3：删除 `installed.has` 去重 + `ctx.agents.list()` 回放 | fail 10（created 幂等/回放用例命中） |

即断言对「位置回退、静默降级、重复注册、漏回放」四类回归均有牙，非恒真。

## 5. 覆盖矩阵（task-3 要求 → 用例）

| # | 要求 | 对应用例（`tests/force-subagent.test.js`） |
| --- | --- | --- |
| 1 | renderNudge 正负例 | `renderNudge 对 lead …`、`…teammate…`、`…非团队角色一律返回严格空串`（16 项负例表，含 `Lead`/`LEAD`/`lead `/` teammate`/`''`/`null`/`undefined`/`42`/`true`/`{}`/`[]`/`toString`/`constructor`/`__proto__`/`Symbol`）|
| 2 | apply 回放与 created 注册 | `apply 回放已有 agent…`、`agent/created：晚到 agent 安装一次…` |
| 3 | text 每轮重算（角色变化不缓存） | `text 每轮重算不缓存：lead → teammate → 未知角色 → undefined → lead…`（membership 恰查 5 次）、`subagent child：…`、`隐式 lead（生产可达）…` |
| 4 | 针对 task-1 根因的失败场景回归 | `根因回归·位置：order … 不再是 TEAM_POLICY+1`（10201 > 全表，且 ≠ 601）、`根因回归·晚加载：apply 前已存在的 agent 拿到 lead 文案…`（插件晚加载/宿主重启后回放即注入，下一轮角色切换不缓存） |
| 5 | disposed/卸载释放、重复注册不抛错 | `生命周期：disposed 精准释放…`、`重复 apply：卸载后再 apply 不抛错…` |
| 附加 | 负例/边界 | `resolveNudge 对 membership 缺失 + 根 agent … not-in-team`、`resolveNudge 优先级边界…`、`负例·锚点缺失：orderOf 返回 undefined / NaN 时显式抛错且不注册半成品`（断言 `sections=0`、`effects=0`、仅 1 次锚点查询） |

### 关键负例（真实断空 + reason，而非只测 mock）

- 无 `parentSession` 的 live root（生产可达）：roster 隐式 lead → `text() === renderNudge('lead')` 且 `reason === 'team-member'`；`not-in-team` 仅保留为 `resolveNudge` 纯函数防御边界（生产不可达）；
- 未知团队角色（`observer`/`intern`/`''`/`Lead`）：`text() === ''` 且 `reason === 'unknown-team-role'`；
- 有 `parentSession` 且带 `subagentDescriptor`（生产可达）：roster 返回 `undefined` → `text() === renderNudge('teammate')` 且 `reason === 'subagent-child'`；
- 锚点缺失（`undefined`/`NaN`）：`apply` 抛错且 `section()` 零调用、错误信息含 `DEPLOYMENT_PERSONA_SUFFIX`。

## 6. 契约核对（真实 harness 源码）

- `packages/core/system-prompt/lib/index.js`：`SECTION_ORDERS` 中 `TEAM_POLICY=600`、`WEB_SURFACE=10100`、`DEPLOYMENT_PERSONA_SUFFIX=10200`；`getSectionOrder(name)` 为纯查表（未知名 `undefined`）；`section()` 拒绝非有限 `order`（`TypeError`）并返回 disposer。
- `packages/core/agent/lib/index.js`：`agent/created`、`agent/disposed` 的 payload 均为 `{ agent }`。
- 测试 harness 的 `getSectionOrder` 表驱动 mock 与上述常量/语义一致，未登记锚点名直接抛错，避免实现偷换锚点仍通过。

## 7. 已知限制 / 残留

1. 单元级验证使用契约一致的 mock；未启动真实 host 做端到端会话验证（宿主重启成本高，且 task-1 已用真实会话快照证明注入链路）。
2. `parentSession: null` 语义未固化：实现以 `!== undefined` 判定，`null` 会被判为 `subagent-child`。现有用例未断言该点；如需把 `null` 视为非团队成员，应改实现为 `!= null` 并补例（本任务不改 `index.js`）。
3. task-1 根因中的“注入成功但不照做”（行为层）不属可单测范围，测试只保证注入内容与位置正确。

## 8. 复现

```bash
cd /home/csy/Code/Github/dsh-force-subagent
node --test tests/
# 期望：tests 19 / pass 19 / fail 0，退出码 0
```

## 9. 真实运行验证（引用 reviewer 实证）

数据来源：reviewer 对抗审查报告 [docs/review-report-v2.md §10](/home/csy/Code/Github/dsh-force-subagent/docs/review-report-v2.md#L106-L121)（经 `open_document` 读取的原始快照证据）；本节不重复取样。

- host 重启：PID 4040148，`2026-10-30 11:17:34`，新 host 加载 sha256 `9caff298…aa55ddf` 的实现（该实现随后于 12:26 仅注释/JSDoc 更新为 `31060040…`，行为不变；快照取证针对运行中 host）。
- 重启后 lead 快照（10-30 11:18:40）：**全长 14229，nudge 起点 13974，其后仅 255 字符 = 位于提示词末尾**（紧接 `DEPLOYMENT_PERSONA_SUFFIX`，`order 10200+1` 生效）。
- 旧行为反向对照：10-30 10:38:57 失败当轮 **全长 15110，起点 4963，其后 10147 字符（33%）**；11:12:04 重启前为 14129/4963。
- teammate 回落分支：二级子代理（`parentSession` 非空，如 `24b235c9`、`33a8dc1e`）快照末尾 **122 字符 = teammate 文案** → 回落分支真实生效。
- 其它重启后 lead：`718a1dc3`（11:18:35）、`6473747b`（11:18:48，距末尾 221 字符）亦为同一落位；重启前 `338226ce`、`54515897`、`ba13c231` 仍为 4963/3199 起点。
- 加载证据：`journalctl _PID=4040148 --since "2026-10-30 11:17:30" --until "2026-10-30 11:19:30"` 无本插件 apply 报错、无 section 撞名、无 `getSectionOrder` 抛错（`~/.dsh/logs` 文件层无证据，见 F4）→ 加载成功已证实。
- 结论：**nudge 已落提示词末尾，teammate 回落分支真实生效**；「位置 → 遵从」因果仍属未证实假设（见 §7 限制 3 与 reviewer §5）。

## 10. 消息级注入验证（task-10）

### 10.1 命令与结果

- 命令：`cd /home/csy/Code/Github/dsh-force-subagent && node --test tests/ > /tmp/task10c-run.log 2>&1; echo "EXIT=$?" >> /tmp/task10c-run.log`（Node v26.9.0，运行于 2026-10-30 17:56 +08:00）
- 退出码 **0**；`tests 16 / pass 16 / fail 0 / todo 0 / cancelled 0 / skipped 0`

### 10.2 被测与测试工件

| 工件 | sha256 | mtime | 大小 |
| --- | --- | --- | --- |
| `index.js`（未改动） | `45e3d8947296187bc0fccdd81cf57111e653b3c01991a3c4fe99c6149b77b9d0` | 2026-10-30 17:16:46.308194407 +0800 | 3138 B |
| `tests/force-subagent.test.js`（整文件重写，todo 已移除） | `cc860a682443e9a02f689907835f9337c51625984668fecb03b5bb2fd07664ab` | 2026-10-30 17:52:38.780823253 +0800 | 10471 B |

**版本更正**：任务简报假设被测为 17:11 版（sha256 `23f1af47…`）。仓库磁盘上的 `index.js` 实为 17:16:46 版（sha256 `45e3d894…`），其 `apply()` 已写成 `return { ...decision, messages: [...] }`（index.js:47-53）。测试针对磁盘上的真实实现编写，未 mock 插件内部函数：宿主只提供最小 fake ctx（`on` 捕获监听 + `agentTeams.tryMembership` 记录调用），决策由 `next()` 提供。

### 10.3 逐条覆盖映射

| 用例（tests/force-subagent.test.js） | 覆盖点与实质断言 |
| --- | --- |
| inject 只声明 agentTeams，apply 仅注册一个 agent/pre-step 监听 | `deepEqual(inject, ['agentTeams'])`；`eventNames === ['agent/pre-step']`；`handlerCount === 1` |
| lead：提醒追加到消息末尾，且不修改 next() 决策的数组与元素 | `kind==='enter'`、len 3、`[0]===m1`、`[1]===m2`、末条 `content[0].text === renderNudge('lead')`、末条非 m1/m2 引用、`result.messages !== decision.messages`、`decision.messages` 仍 2 且元素引用不变 |
| teammate：文案独立于 lead，原有两条消息顺序与引用不变 | 末条 text `=== renderNudge('teammate')` 且 `!== renderNudge('lead')`；m1/m2 顺序与引用不变 |
| 非团队成员（tryMembership 返回 undefined）：原样返回 next() 决策 | `strictEqual(result, decision)`；`calls.length === 1` 且入参为 `payload.agent` |
| tryMembership 返回 null：?? 兜底为空对象，仍不注入 | `strictEqual(result, decision)`（`?? {}` 边界） |
| 未知角色（role: observer）：原样返回决策、无追加 | `strictEqual(result, decision)`；len 1 |
| 空消息批次：不注入，且完全不查询成员身份 | `payload.messages === []` 而 decision 仍 enter 带 2 条 → `strictEqual(result, decision)`；`calls.length === 0` |
| 非 enter 决策（kind: reject）：原样返回且不查询成员身份 | `strictEqual(result, decision)`；`result.messages === undefined`；`calls.length === 0` |
| next() 抛错：同一 Error 对象向上传播，插件不吞异常 | `assert.rejects(handler(payload,next), e => e === err)` |
| 每个消息批次恰好追加一条：连续三批各 +1 且提醒 id 互不相同 | batchA/batchB/batchA 三次同一 handler；每次 `result.messages.length === decision.messages.length + 1`；三次提醒 id 互不相同且均为 UUID v4；文档注释声明 pre-step 每批一次、插件内部不做跨批去重 |
| 注入消息 shape：UUID v4 id、role user、单元素 text content、source user | `id` 匹配 UUID v4 正则；`role==='user'`；`content.length===1`；`content[0] deepEqual {type:'text',text:renderNudge(role)}`；`source deepEqual {kind:'user'}`；两次调用 id 不同 |
| decision.messages 为空时仅追加提醒 | payload 非空、decision.messages 空 → `result.messages.length === 1` 且为提醒；`decision.messages` 仍空 |
| runtime-context 消息：位置与引用不变，提醒仍在最后 | `result.messages[0]===rt`（`source.kind==='runtime-context'`）、`[1]===m1`、末条为提醒 |
| renderNudge 正例：lead / teammate 非空且含关键 token | lead 含 `team_task_create`、`spawn_teammate`；teammate 含 `编排者`、`subagent`；两者互异 |
| renderNudge 负例：非法角色一律空串 | 14 项负例（`observer`/`Lead`/`lead `/` teammate`/`''`/`null`/`undefined`/`42`/`true`/`{}`/`[]`/`toString`/`constructor`/`__proto__`/`Symbol('lead')`）逐项 `=== ''`，另加 `Object.create(null)` |
| enter 决策须保留 startsRequestSeries 等非 messages 字段（普通回归用例） | `kind==='enter'`、`messages[0]` 原引用不变、`startsRequestSeries===true`；见 10.4 |

### 10.4 已知缺陷与回归用例（todo 已移除）

- 旧缺陷（已修复）：17:11 版 `index.js`（sha256 `23f1af47…`）在 pre-step 追加提醒时返回 `{kind:'enter', messages}`，丢弃 `next()` 决策的 `startsRequestSeries`。
- 真实 harness 依据：`packages/core/agent/lib/types/runtime-types.d.ts:92-100`（`startsRequestSeries?: true`）；`packages/core/agent-loop/src/agent.ts:415` 读取、`:418` 用于 `systemPrompt.project`、`:442` 传入 `buildRequest`。
- 当前实现（sha256 `45e3d894…`，17:16）已改为 `return { ...decision, messages: [...] }`。
- **todo 已移除**：reviewer 第 3 轮指出 `{ todo: … }` 会使「丢字段」变异抓不到；现为普通 test，断言 `kind==='enter'`、`result.messages[0] === 原 m1`（前缀未重建）、`result.startsRequestSeries === true`。套件汇总因此为 `pass 16 / todo 0`。
- 变异自证（M2）：/tmp 副本把 `...decision` 改为 `kind:'enter'` 后运行，`tests 16 / pass 15 / fail 1 / todo 0 / EXIT=1`，失败用例即上述回归用例（`startsRequestSeries` actual undefined ≠ expected true）。

```bash
rm -rf /tmp/mut10 && mkdir -p /tmp/mut10/tests
cp index.js /tmp/mut10/ && cp tests/force-subagent.test.js /tmp/mut10/tests/
sed -i "s/\.\.\.decision,/kind: 'enter',/" /tmp/mut10/index.js
cd /tmp/mut10 && node --test tests/
```

### 10.5 运行输出全文

```text
✔ inject 只声明 agentTeams，apply 仅注册一个 agent/pre-step 监听 (6.329935ms)
✔ lead：提醒追加到消息末尾，且不修改 next() 决策的数组与元素 (4.60023ms)
✔ teammate：文案独立于 lead，原有两条消息顺序与引用不变 (0.310046ms)
✔ 非团队成员（tryMembership 返回 undefined）：原样返回 next() 决策 (0.315891ms)
✔ tryMembership 返回 null：?? 兜底为空对象，仍不注入 (1.316985ms)
✔ 未知角色（role: observer）：原样返回决策、无追加 (0.292435ms)
✔ 空消息批次：不注入，且完全不查询成员身份 (0.237561ms)
✔ 非 enter 决策（kind: reject）：原样返回且不查询成员身份 (0.21169ms)
✔ next() 抛错：同一 Error 对象向上传播，插件不吞异常 (0.733879ms)
✔ 每个消息批次恰好追加一条：连续三批各 +1 且提醒 id 互不相同（插件内无跨批去重） (0.687002ms)
✔ 注入消息 shape：UUID v4 id、role user、单元素 text content、source user (0.611788ms)
✔ decision.messages 为空时仅追加提醒（result.messages.length === 1） (0.245394ms)
✔ runtime-context 消息：位置与引用不变，提醒仍在最后 (0.227454ms)
✔ renderNudge 正例：lead / teammate 非空且含关键 token (0.147503ms)
✔ renderNudge 负例：非法角色一律空串 (0.137479ms)
✔ enter 决策须保留 startsRequestSeries 等非 messages 字段（旧实现丢弃，防回归） (0.280603ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 125.753627
EXIT=0
```

### 10.6 限制

- 测试用最小 fake ctx，未启动真实 Cordis/harness；`agent/pre-step` 在真实 harness 中对每个消息批次调用一次的次数仍以上线快照证据（§8/§9）为准，本节只验证插件侧“每批至多一次追加、无跨批去重”的行为契约。

### 10.7 并行写入更正与二次复跑（task-10 执行者自证）

- 并发冲突：task-10 期间 `tests/force-subagent.test.js` 与 `docs/verification-log.md` 被两个写入者同时改写。执行者首版（sha256 `fe4fdf2125e7e3227a4f3aa41ee54a6301bb8990053d00aa50d4afefb959252a`，10621 B，17:46:02）在 `startsRequestSeries` 用例上带 `{ todo: … }`，那次运行（`/tmp/task10-run.log`，17:46）为 `tests 16 / pass 15 / fail 0 / todo 1 / EXIT=0`（当轮执行者当时口径；后被 reviewer 第 3 轮推翻）。随后 reviewer 要求去掉 `{ todo }`，最终版为 sha256 `cc860a682443e9a02f689907835f9337c51625984668fecb03b5bb2fd07664ab`（10471 B，17:52:38）；本文件一度出现两个 `## 10.` 重复节，现已合并为单一 §10（10.1–10.7），§1–§9 未改动。
- 二次复跑（2026-10-30 17:59 +08:00，`node --test tests/ > /tmp/task10-run-verify.log 2>&1; echo "EXIT=$?" >> /tmp/task10-run-verify.log`）：`tests 16 / pass 16 / fail 0 / todo 0 / EXIT=0`。
- 被测实现全程未改动：`index.js` sha256 `45e3d8947296187bc0fccdd81cf57111e653b3c01991a3c4fe99c6149b77b9d0`，mtime `2026-10-30 17:16:46.308194407 +0800`，3138 B。
- 版本时间线（已复核，非猜测）：17:12 磁盘上的 `index.js` 为 sha256 `23f1af47…`（2947 B，`{kind:'enter', messages}` 丢 `startsRequestSeries`）；implementer 于 17:16:46 修复为 `{ ...decision, messages }`，即当前 `45e3d894…`（3138 B）。仓库无 git 提交历史，故旧版内容只能由本日志与 implementer 修复记录佐证；回归由 §10.4 的 M2 变异（`tests 16 / pass 15 / fail 1 / todo 0 / EXIT=1`）捕获。
